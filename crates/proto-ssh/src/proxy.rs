//! Outbound proxies for the first hop: SOCKS5 (RFC 1928/1929) and HTTP CONNECT.

use crate::error::SshError;
use cairn_core::SecretString;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyKind {
    Socks5,
    Http,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<SecretString>,
}

/// Open a TCP stream to `host:port` through `proxy`.
pub async fn connect_via(
    proxy: &ProxyConfig,
    host: &str,
    port: u16,
) -> Result<TcpStream, SshError> {
    let proxy_target = format!("{}:{}", proxy.host, proxy.port);
    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(|e| SshError::Proxy(format!("cannot reach proxy {proxy_target}: {e}")))?;
    match proxy.kind {
        ProxyKind::Socks5 => socks5(&mut stream, proxy, host, port).await?,
        ProxyKind::Http => http_connect(&mut stream, proxy, host, port).await?,
    }
    Ok(stream)
}

fn io(e: std::io::Error) -> SshError {
    SshError::Proxy(e.to_string())
}

async fn socks5(s: &mut TcpStream, p: &ProxyConfig, host: &str, port: u16) -> Result<(), SshError> {
    let with_auth = p.username.is_some();
    let methods: &[u8] = if with_auth { &[0x00, 0x02] } else { &[0x00] };
    let mut hello = vec![0x05, methods.len() as u8];
    hello.extend_from_slice(methods);
    s.write_all(&hello).await.map_err(io)?;
    let mut reply = [0u8; 2];
    s.read_exact(&mut reply).await.map_err(io)?;
    match reply {
        [0x05, 0x00] => {}
        [0x05, 0x02] if with_auth => {
            let user = p.username.as_deref().unwrap_or_default().as_bytes();
            let pass = p
                .password
                .as_ref()
                .map(|x| x.expose())
                .unwrap_or_default()
                .as_bytes();
            if user.len() > 255 || pass.len() > 255 {
                return Err(SshError::Proxy(
                    "SOCKS5 username or password is too long".into(),
                ));
            }
            let mut auth = vec![0x01, user.len() as u8];
            auth.extend_from_slice(user);
            auth.push(pass.len() as u8);
            auth.extend_from_slice(pass);
            s.write_all(&auth).await.map_err(io)?;
            let mut r = [0u8; 2];
            s.read_exact(&mut r).await.map_err(io)?;
            if r[1] != 0x00 {
                return Err(SshError::Proxy(
                    "the SOCKS5 proxy rejected the credentials".into(),
                ));
            }
        }
        [0x05, 0xff] => {
            return Err(SshError::Proxy(
                "the SOCKS5 proxy requires authentication".into(),
            ))
        }
        _ => return Err(SshError::Proxy("not a SOCKS5 proxy".into())),
    }
    if host.len() > 255 {
        return Err(SshError::Proxy("hostname too long for SOCKS5".into()));
    }
    let mut req = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
    req.extend_from_slice(host.as_bytes());
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await.map_err(io)?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).await.map_err(io)?;
    if head[1] != 0x00 {
        return Err(SshError::Proxy(format!(
            "the SOCKS5 proxy could not reach {host}:{port} ({})",
            socks5_reason(head[1])
        )));
    }
    // Skip the bound address.
    let addr_len = match head[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l).await.map_err(io)?;
            l[0] as usize
        }
        _ => return Err(SshError::Proxy("malformed SOCKS5 reply".into())),
    };
    let mut skip = vec![0u8; addr_len + 2];
    s.read_exact(&mut skip).await.map_err(io)?;
    Ok(())
}

fn socks5_reason(code: u8) -> &'static str {
    match code {
        0x01 => "general failure",
        0x02 => "not allowed by ruleset",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused",
        0x06 => "TTL expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown error",
    }
}

async fn http_connect(
    s: &mut TcpStream,
    p: &ProxyConfig,
    host: &str,
    port: u16,
) -> Result<(), SshError> {
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut req = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some(user) = &p.username {
        let pass = p.password.as_ref().map(|x| x.expose()).unwrap_or_default();
        req.push_str(&format!(
            "Proxy-Authorization: Basic {}\r\n",
            base64(format!("{user}:{pass}").as_bytes())
        ));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await.map_err(io)?;

    let mut reader = BufReader::new(s);
    let mut status = String::new();
    reader.read_line(&mut status).await.map_err(io)?;
    let code = status.split_whitespace().nth(1).unwrap_or_default();
    // Drain headers up to the blank line.
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await.map_err(io)?;
        if n == 0 || line == "\r\n" || line == "\n" {
            break;
        }
    }
    if !reader.buffer().is_empty() {
        return Err(SshError::Proxy(
            "the HTTP proxy sent data before the tunnel opened".into(),
        ));
    }
    match code {
        "200" => Ok(()),
        "407" => Err(SshError::Proxy(
            "the HTTP proxy requires authentication (407)".into(),
        )),
        _ => Err(SshError::Proxy(format!(
            "the HTTP proxy refused the tunnel: {}",
            status.trim()
        ))),
    }
}

fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        for (i, o) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(i.as_bytes()), o);
        }
    }

    /// Echo server; returns its port.
    async fn echo() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = l.local_addr().expect("addr").port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let (mut r, mut w) = s.split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
            }
        });
        port
    }

    /// Minimal SOCKS5 proxy with optional user/pass that tunnels to 127.0.0.1:<port>.
    async fn socks5_proxy(require_auth: bool) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = l.local_addr().expect("addr").port();
        tokio::spawn(async move {
            let (mut c, _) = l.accept().await.expect("accept");
            let mut h = [0u8; 2];
            c.read_exact(&mut h).await.expect("hello");
            let mut m = vec![0u8; h[1] as usize];
            c.read_exact(&mut m).await.expect("methods");
            if require_auth {
                c.write_all(&[5, 2]).await.expect("w");
                let mut v = [0u8; 2];
                c.read_exact(&mut v).await.expect("auth");
                let mut u = vec![0u8; v[1] as usize];
                c.read_exact(&mut u).await.expect("user");
                let mut pl = [0u8; 1];
                c.read_exact(&mut pl).await.expect("plen");
                let mut p = vec![0u8; pl[0] as usize];
                c.read_exact(&mut p).await.expect("pass");
                let ok = u == b"alice" && p == b"s3cret";
                c.write_all(&[1, if ok { 0 } else { 1 }]).await.expect("w");
                if !ok {
                    return;
                }
            } else {
                c.write_all(&[5, 0]).await.expect("w");
            }
            let mut head = [0u8; 5];
            c.read_exact(&mut head).await.expect("req");
            let mut host = vec![0u8; head[4] as usize];
            c.read_exact(&mut host).await.expect("host");
            let mut p = [0u8; 2];
            c.read_exact(&mut p).await.expect("port");
            let mut up = TcpStream::connect(("127.0.0.1", u16::from_be_bytes(p)))
                .await
                .expect("up");
            c.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
                .await
                .expect("w");
            let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
        });
        port
    }

    /// Minimal HTTP CONNECT proxy.
    async fn http_proxy() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = l.local_addr().expect("addr").port();
        tokio::spawn(async move {
            let (c, _) = l.accept().await.expect("accept");
            let mut r = BufReader::new(c);
            let mut first = String::new();
            r.read_line(&mut first).await.expect("line");
            loop {
                let mut line = String::new();
                r.read_line(&mut line).await.expect("hdr");
                if line == "\r\n" {
                    break;
                }
            }
            let target = first.split_whitespace().nth(1).expect("target").to_owned();
            let mut up = TcpStream::connect(target).await.expect("up");
            let mut c = r.into_inner();
            c.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .expect("w");
            let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
        });
        port
    }

    async fn roundtrip(mut s: TcpStream) {
        s.write_all(b"ping").await.expect("write");
        let mut buf = [0u8; 4];
        s.read_exact(&mut buf).await.expect("read");
        assert_eq!(&buf, b"ping");
    }

    fn cfg(kind: ProxyKind, port: u16, auth: bool) -> ProxyConfig {
        ProxyConfig {
            kind,
            host: "127.0.0.1".into(),
            port,
            username: auth.then(|| "alice".into()),
            password: auth.then(|| SecretString::from("s3cret")),
        }
    }

    #[tokio::test]
    async fn socks5_tunnels() {
        let target = echo().await;
        let proxy = socks5_proxy(false).await;
        roundtrip(
            connect_via(&cfg(ProxyKind::Socks5, proxy, false), "localhost", target)
                .await
                .expect("connect"),
        )
        .await;
    }

    #[tokio::test]
    async fn socks5_with_credentials() {
        let target = echo().await;
        let proxy = socks5_proxy(true).await;
        roundtrip(
            connect_via(&cfg(ProxyKind::Socks5, proxy, true), "localhost", target)
                .await
                .expect("connect"),
        )
        .await;
    }

    #[tokio::test]
    async fn socks5_reports_missing_credentials() {
        let proxy = socks5_proxy(true).await;
        let err = connect_via(&cfg(ProxyKind::Socks5, proxy, false), "localhost", 1)
            .await
            .expect_err("fails");
        assert!(
            err.to_string().contains("requires authentication")
                || err.to_string().contains("not a SOCKS5"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn http_connect_tunnels() {
        let target = echo().await;
        let proxy = http_proxy().await;
        roundtrip(
            connect_via(&cfg(ProxyKind::Http, proxy, false), "127.0.0.1", target)
                .await
                .expect("connect"),
        )
        .await;
    }

    #[tokio::test]
    async fn unreachable_proxy_is_reported() {
        let l = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = l.local_addr().expect("addr").port();
        drop(l);
        let err = connect_via(&cfg(ProxyKind::Http, port, false), "x", 22)
            .await
            .expect_err("fails");
        assert!(err.to_string().contains("cannot reach proxy"));
    }
}
