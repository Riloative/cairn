//! Port forwarding over an established connection: local (ssh -L), remote (ssh -R)
//! and dynamic SOCKS5 (ssh -D). Each forward reports live counters.

use crate::connect::{Connection, RemoteRoute};
use crate::error::SshError;
use cairn_core::tools::{ForwardKind, ForwardSpec};
use russh::client::Msg;
use russh::Channel;
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

/// Live counters of one forward.
#[derive(Debug, Default)]
pub struct ForwardStats {
    pub active: AtomicU32,
    pub total: AtomicU64,
    pub bytes_out: AtomicU64,
    pub bytes_in: AtomicU64,
    /// The last connection error (e.g. destination refused), cleared on success.
    pub last_error: Mutex<Option<String>>,
}

/// A snapshot of [`ForwardStats`] for the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardCounters {
    pub active: u32,
    pub total: u64,
    pub bytes_out: u64,
    pub bytes_in: u64,
    pub last_error: Option<String>,
}

impl ForwardStats {
    pub fn snapshot(&self) -> ForwardCounters {
        ForwardCounters {
            active: self.active.load(Ordering::Relaxed),
            total: self.total.load(Ordering::Relaxed),
            bytes_out: self.bytes_out.load(Ordering::Relaxed),
            bytes_in: self.bytes_in.load(Ordering::Relaxed),
            last_error: self.last_error.lock().ok().and_then(|e| e.clone()),
        }
    }

    fn set_error(&self, e: Option<String>) {
        if let Ok(mut slot) = self.last_error.lock() {
            *slot = e;
        }
    }
}

/// A running forward; stopped with [`Forward::stop`] or when the connection ends.
#[derive(Debug)]
pub struct Forward {
    pub spec: ForwardSpec,
    /// The port actually listening (the OS or server picks one for port 0).
    pub bound_port: u16,
    pub stats: Arc<ForwardStats>,
    stop: watch::Sender<bool>,
    conn: Arc<Connection>,
}

impl Forward {
    /// Stop accepting connections (open ones finish on their own).
    pub async fn stop(&self) {
        let _ = self.stop.send(true);
        if self.spec.kind == ForwardKind::Remote {
            let _ = self
                .conn
                .handle
                .cancel_tcpip_forward(self.spec.bind_host.clone(), u32::from(self.bound_port))
                .await;
            if let Ok(mut routes) = self.conn.routes.lock() {
                routes.remove(&(self.spec.bind_host.clone(), u32::from(self.bound_port)));
            }
        }
    }

    pub fn is_stopped(&self) -> bool {
        *self.stop.borrow()
    }
}

fn bind_addr(spec: &ForwardSpec) -> String {
    if spec.bind_host.contains(':') {
        format!("[{}]:{}", spec.bind_host, spec.bind_port)
    } else {
        format!("{}:{}", spec.bind_host, spec.bind_port)
    }
}

/// Start a forward on `conn`.
pub async fn start(conn: Arc<Connection>, spec: ForwardSpec) -> Result<Forward, SshError> {
    let spec = spec.clean().map_err(|e| SshError::ForwardBind {
        addr: bind_addr(&spec),
        message: e.to_string(),
    })?;
    let stats = Arc::new(ForwardStats::default());
    let (stop, stopped) = watch::channel(false);
    let bound_port = match spec.kind {
        ForwardKind::Local | ForwardKind::Dynamic => {
            let listener = TcpListener::bind((spec.bind_host.as_str(), spec.bind_port))
                .await
                .map_err(|e| SshError::ForwardBind {
                    addr: bind_addr(&spec),
                    message: e.to_string(),
                })?;
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            tokio::spawn(accept_loop(
                listener,
                conn.clone(),
                spec.clone(),
                stats.clone(),
                stopped,
            ));
            port
        }
        ForwardKind::Remote => {
            let port = conn
                .handle
                .tcpip_forward(spec.bind_host.clone(), u32::from(spec.bind_port))
                .await
                .map_err(|e| SshError::ForwardRefused(e.to_string()))?;
            // Servers answer with the port only when 0 was requested.
            let port = if spec.bind_port == 0 {
                u16::try_from(port).unwrap_or(0)
            } else {
                spec.bind_port
            };
            if let Ok(mut routes) = conn.routes.lock() {
                routes.insert(
                    (spec.bind_host.clone(), u32::from(port)),
                    RemoteRoute {
                        dest_host: spec.dest_host.clone(),
                        dest_port: spec.dest_port,
                        stats: stats.clone(),
                    },
                );
            }
            port
        }
    };
    Ok(Forward {
        spec,
        bound_port,
        stats,
        stop,
        conn,
    })
}

async fn accept_loop(
    listener: TcpListener,
    conn: Arc<Connection>,
    spec: ForwardSpec,
    stats: Arc<ForwardStats>,
    mut stopped: watch::Receiver<bool>,
) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(2));
    loop {
        tokio::select! {
            r = listener.accept() => {
                let Ok((stream, peer)) = r else { continue };
                let (conn, spec, stats) = (conn.clone(), spec.clone(), stats.clone());
                tokio::spawn(async move {
                    let result = match spec.kind {
                        ForwardKind::Dynamic => socks5(stream, peer, &conn, &stats).await,
                        _ => {
                            let channel = conn
                                .handle
                                .channel_open_direct_tcpip(
                                    spec.dest_host.clone(),
                                    u32::from(spec.dest_port),
                                    peer.ip().to_string(),
                                    u32::from(peer.port()),
                                )
                                .await
                                .map_err(|e| {
                                    format!(
                                        "{}:{} could not be reached from the server ({e})",
                                        spec.dest_host, spec.dest_port
                                    )
                                });
                            match channel {
                                Ok(ch) => {
                                    pipe(stream, ch, &stats).await;
                                    Ok(())
                                }
                                Err(e) => Err(e),
                            }
                        }
                    };
                    if let Err(e) = result {
                        stats.set_error(Some(e));
                    }
                });
            }
            _ = stopped.changed() => break,
            // The SSH connection is gone: free the local port.
            _ = tick.tick() => if conn.handle.is_closed() { break },
        }
    }
}

/// Copy both ways between a local socket and an SSH channel, counting bytes.
async fn pipe<S>(mut stream: S, channel: Channel<Msg>, stats: &ForwardStats)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    stats.active.fetch_add(1, Ordering::Relaxed);
    stats.total.fetch_add(1, Ordering::Relaxed);
    stats.set_error(None);
    let mut remote = channel.into_stream();
    if let Ok((out, inn)) = tokio::io::copy_bidirectional(&mut stream, &mut remote).await {
        stats.bytes_out.fetch_add(out, Ordering::Relaxed);
        stats.bytes_in.fetch_add(inn, Ordering::Relaxed);
    }
    stats.active.fetch_sub(1, Ordering::Relaxed);
}

/// A connection the server forwarded to us (remote forward): connect to the route.
pub(crate) async fn bridge_remote(channel: Channel<Msg>, route: RemoteRoute) {
    match TcpStream::connect((route.dest_host.as_str(), route.dest_port)).await {
        Ok(stream) => pipe(stream, channel, &route.stats).await,
        Err(e) => {
            route.stats.set_error(Some(format!(
                "{}:{} refused the forwarded connection ({e})",
                route.dest_host, route.dest_port
            )));
            let _ = channel.close().await;
        }
    }
}

/// SOCKS5 reply codes (RFC 1928).
const SOCKS_OK: u8 = 0;
const SOCKS_FAIL: u8 = 1;
const SOCKS_UNSUPPORTED: u8 = 7;
const SOCKS_ATYP_UNSUPPORTED: u8 = 8;

async fn socks_reply(stream: &mut TcpStream, code: u8) -> std::io::Result<()> {
    stream.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}

/// Read a SOCKS5 CONNECT request; returns the destination (no authentication).
async fn socks_handshake(stream: &mut TcpStream) -> Result<(String, u16), String> {
    let io = |e: std::io::Error| e.to_string();
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await.map_err(io)?;
    if head[0] != 5 {
        return Err("only SOCKS5 clients are supported".into());
    }
    let mut methods = vec![0u8; usize::from(head[1])];
    stream.read_exact(&mut methods).await.map_err(io)?;
    if !methods.contains(&0) {
        stream.write_all(&[5, 0xff]).await.map_err(io)?;
        return Err("the SOCKS client requires authentication".into());
    }
    stream.write_all(&[5, 0]).await.map_err(io)?;
    let mut req = [0u8; 4];
    stream.read_exact(&mut req).await.map_err(io)?;
    if req[1] != 1 {
        let _ = socks_reply(stream, SOCKS_UNSUPPORTED).await;
        return Err("only CONNECT requests are supported".into());
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            stream.read_exact(&mut a).await.map_err(io)?;
            IpAddr::V4(Ipv4Addr::from(a)).to_string()
        }
        4 => {
            let mut a = [0u8; 16];
            stream.read_exact(&mut a).await.map_err(io)?;
            IpAddr::V6(Ipv6Addr::from(a)).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(io)?;
            let mut name = vec![0u8; usize::from(len[0])];
            stream.read_exact(&mut name).await.map_err(io)?;
            String::from_utf8_lossy(&name).into_owned()
        }
        _ => {
            let _ = socks_reply(stream, SOCKS_ATYP_UNSUPPORTED).await;
            return Err("unsupported SOCKS address type".into());
        }
    };
    let mut port = [0u8; 2];
    stream.read_exact(&mut port).await.map_err(io)?;
    Ok((host, u16::from_be_bytes(port)))
}

async fn socks5(
    mut stream: TcpStream,
    peer: SocketAddr,
    conn: &Connection,
    stats: &ForwardStats,
) -> Result<(), String> {
    let (host, port) = socks_handshake(&mut stream).await?;
    let channel = conn
        .handle
        .channel_open_direct_tcpip(
            host.clone(),
            u32::from(port),
            peer.ip().to_string(),
            u32::from(peer.port()),
        )
        .await;
    match channel {
        Ok(ch) => {
            socks_reply(&mut stream, SOCKS_OK)
                .await
                .map_err(|e| e.to_string())?;
            pipe(stream, ch, stats).await;
            Ok(())
        }
        Err(e) => {
            let _ = socks_reply(&mut stream, SOCKS_FAIL).await;
            Err(format!(
                "{host}:{port} could not be reached from the server ({e})"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn socks5_handshake_parses_domain_and_ipv4_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let client = tokio::spawn(async move {
            let mut c = TcpStream::connect(addr).await.expect("connect");
            c.write_all(&[5, 1, 0]).await.expect("greet");
            let mut r = [0u8; 2];
            c.read_exact(&mut r).await.expect("method");
            assert_eq!(r, [5, 0]);
            let mut req = vec![5, 1, 0, 3, 11];
            req.extend_from_slice(b"example.org");
            req.extend_from_slice(&443u16.to_be_bytes());
            c.write_all(&req).await.expect("request");
            c
        });
        let (mut s, _) = listener.accept().await.expect("accept");
        assert_eq!(
            socks_handshake(&mut s).await,
            Ok(("example.org".into(), 443))
        );
        drop(client.await);

        let client = tokio::spawn(async move {
            let mut c = TcpStream::connect(addr).await.expect("connect");
            c.write_all(&[5, 1, 2]).await.expect("greet");
            let mut r = [0u8; 2];
            c.read_exact(&mut r).await.expect("method");
            r
        });
        let (mut s, _) = listener.accept().await.expect("accept");
        assert!(socks_handshake(&mut s).await.is_err(), "auth-only client");
        assert_eq!(client.await.expect("join"), [5, 0xff]);
    }
}
