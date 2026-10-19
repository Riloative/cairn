//! The TFTP server: a listener on the configured address and one task (with its own
//! UDP port, the "transfer ID") per transfer.
//!
//! - Reads and writes can be allowed separately; names are jailed to the root folder.
//! - Writes go to a temporary file renamed into place when complete, so a broken
//!   transfer never leaves a truncated config or image behind.
//! - Options: `blksize` (faster firmware pushes), `tsize`, `timeout`. Block numbers
//!   roll over after 65535, so files larger than 32 MB work with default blocks.

use crate::error::{bind_error, TftpError};
use crate::jail::{self, JailError};
use crate::netascii;
use crate::packet::{ErrorCode, Mode, Options, Packet, BLOCK_SIZE, MAX_BLOCK_SIZE};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UdpSocket;
use tokio::sync::watch;

/// Server settings, also stored as the user's TFTP preferences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub root: PathBuf,
    pub bind: SocketAddr,
    pub allow_read: bool,
    pub allow_write: bool,
    /// Allow uploads to replace existing files.
    #[serde(default)]
    pub overwrite: bool,
}

/// Which way the data flows, from the client's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    /// The client downloads (RRQ).
    Read,
    /// The client uploads (WRQ).
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ServerEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        id: u64,
        peer: String,
        file: String,
        direction: Direction,
        size: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress { id: u64, bytes: u64 },
    #[serde(rename_all = "camelCase")]
    Finished {
        id: u64,
        bytes: u64,
        ok: bool,
        error: Option<String>,
    },
    /// A request turned away before any data moved (permissions, missing file).
    #[serde(rename_all = "camelCase")]
    Refused {
        peer: String,
        file: String,
        direction: Direction,
        reason: String,
    },
}

pub type EventSink = Arc<dyn Fn(ServerEvent) + Send + Sync>;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);
const RETRIES: u32 = 5;
/// Uploads larger than this are refused (disk full protection).
const MAX_UPLOAD: u64 = 8 * 1024 * 1024 * 1024;
/// netascii files are converted in memory.
const MAX_NETASCII: u64 = 64 * 1024 * 1024;
const PROGRESS_BYTES: u64 = 256 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(300);

/// A running server; dropping it does not stop it, call [`TftpServer::stop`].
#[derive(Debug)]
pub struct TftpServer {
    addr: SocketAddr,
    stop: watch::Sender<bool>,
}

impl TftpServer {
    /// Bind and start serving on the current tokio runtime.
    pub async fn start(cfg: ServerConfig, sink: EventSink) -> Result<Self, TftpError> {
        if !cfg.allow_read && !cfg.allow_write {
            return Err(TftpError::NothingAllowed);
        }
        if !cfg.root.is_dir() {
            return Err(TftpError::Root {
                path: cfg.root.clone(),
            });
        }
        let sock = UdpSocket::bind(cfg.bind)
            .await
            .map_err(|e| bind_error(cfg.bind, e))?;
        let addr = sock.local_addr().map_err(|e| bind_error(cfg.bind, e))?;
        let (stop, stopped) = watch::channel(false);
        tokio::spawn(listen(sock, Arc::new(cfg), sink, stopped));
        Ok(Self { addr, stop })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Stop listening and abort running transfers.
    pub fn stop(&self) {
        let _ = self.stop.send(true);
    }
}

async fn listen(
    sock: UdpSocket,
    cfg: Arc<ServerConfig>,
    sink: EventSink,
    mut stopped: watch::Receiver<bool>,
) {
    let ids = Arc::new(AtomicU64::new(1));
    let mut buf = vec![0u8; MAX_BLOCK_SIZE + 4];
    loop {
        tokio::select! {
            r = sock.recv_from(&mut buf) => {
                let Ok((n, peer)) = r else { continue };
                let request = match Packet::decode(&buf[..n]) {
                    Ok(p @ (Packet::ReadRequest { .. } | Packet::WriteRequest { .. })) => p,
                    Ok(_) => {
                        reply_error(&sock, peer, ErrorCode::UnknownTransferId, "Unknown transfer").await;
                        continue;
                    }
                    Err(e) => {
                        reply_error(&sock, peer, ErrorCode::IllegalOperation, &e.to_string()).await;
                        continue;
                    }
                };
                let id = ids.fetch_add(1, Ordering::Relaxed);
                tokio::spawn(handle(request, peer, id, cfg.clone(), sink.clone(), stopped.clone()));
            }
            _ = stopped.changed() => break,
        }
    }
}

async fn reply_error(sock: &UdpSocket, peer: SocketAddr, code: ErrorCode, message: &str) {
    let pkt = Packet::Error {
        code,
        message: message.to_owned(),
    };
    let _ = sock.send_to(&pkt.encode(), peer).await;
}

async fn handle(
    request: Packet,
    peer: SocketAddr,
    id: u64,
    cfg: Arc<ServerConfig>,
    sink: EventSink,
    stopped: watch::Receiver<bool>,
) {
    let (file, mode, options, direction) = match request {
        Packet::ReadRequest {
            filename,
            mode,
            options,
        } => (filename, mode, options, Direction::Read),
        Packet::WriteRequest {
            filename,
            mode,
            options,
        } => (filename, mode, options, Direction::Write),
        _ => return,
    };
    // Each transfer uses its own port (TID), bound on the server's address.
    let Ok(sock) = UdpSocket::bind(SocketAddr::new(cfg.bind.ip(), 0)).await else {
        return;
    };
    if sock.connect(peer).await.is_err() {
        return;
    }
    let refuse = |code: ErrorCode, reason: &str| {
        sink(ServerEvent::Refused {
            peer: peer.to_string(),
            file: file.clone(),
            direction,
            reason: reason.to_owned(),
        });
        let pkt = Packet::Error {
            code,
            message: reason.to_owned(),
        };
        pkt.encode()
    };

    let prepared = match direction {
        Direction::Read if !cfg.allow_read => Err((
            ErrorCode::AccessViolation,
            "Downloads are disabled on this server",
        )),
        Direction::Write if !cfg.allow_write => Err((
            ErrorCode::AccessViolation,
            "Uploads are disabled on this server",
        )),
        Direction::Read => jail::resolve_read(&cfg.root, &file).map_err(jail_reason),
        Direction::Write => jail::resolve_write(&cfg.root, &file)
            .map_err(jail_reason)
            .and_then(|p| {
                if p.exists() && !cfg.overwrite {
                    Err((
                        ErrorCode::FileExists,
                        "The file exists and overwriting is disabled",
                    ))
                } else {
                    Ok(p)
                }
            }),
    };
    let path = match prepared {
        Ok(p) => p,
        Err((code, reason)) => {
            let _ = sock.send(&refuse(code, reason)).await;
            return;
        }
    };

    let ctx = Transfer {
        sock,
        id,
        sink: sink.clone(),
        stopped,
        timeout: DEFAULT_TIMEOUT,
        bytes: 0,
        last_report: (0, Instant::now()),
    };
    let result = match direction {
        Direction::Read => serve_read(ctx, &path, &file, peer, mode, options).await,
        Direction::Write => serve_write(ctx, &path, &file, peer, mode, options).await,
    };
    let (bytes, error) = match result {
        Ok(b) => (b, None),
        Err((b, e)) => (b, Some(e)),
    };
    sink(ServerEvent::Finished {
        id,
        bytes,
        ok: error.is_none(),
        error,
    });
}

fn jail_reason(e: JailError) -> (ErrorCode, &'static str) {
    match e {
        JailError::NotFound => (ErrorCode::FileNotFound, "File not found"),
        JailError::Invalid | JailError::Outside => (
            ErrorCode::AccessViolation,
            "The file name points outside the served folder",
        ),
    }
}

struct Transfer {
    sock: UdpSocket,
    id: u64,
    sink: EventSink,
    stopped: watch::Receiver<bool>,
    timeout: Duration,
    bytes: u64,
    last_report: (u64, Instant),
}

type Outcome = Result<u64, (u64, String)>;

impl Transfer {
    fn progress(&mut self) {
        let (bytes, at) = self.last_report;
        if self.bytes - bytes >= PROGRESS_BYTES || at.elapsed() >= PROGRESS_EVERY {
            self.last_report = (self.bytes, Instant::now());
            (self.sink)(ServerEvent::Progress {
                id: self.id,
                bytes: self.bytes,
            });
        }
    }

    fn fail(&self, msg: impl Into<String>) -> (u64, String) {
        (self.bytes, msg.into())
    }

    async fn abort(&self, code: ErrorCode, msg: &str) -> (u64, String) {
        let pkt = Packet::Error {
            code,
            message: msg.to_owned(),
        };
        let _ = self.sock.send(&pkt.encode()).await;
        self.fail(msg)
    }

    /// Receive one packet, or `None` on timeout. Errors end the transfer.
    async fn recv(&mut self, buf: &mut [u8]) -> Result<Option<Packet>, (u64, String)> {
        let timeout = self.timeout;
        tokio::select! {
            r = tokio::time::timeout(timeout, self.sock.recv(buf)) => match r {
                Err(_) => Ok(None),
                Ok(Ok(n)) => match Packet::decode(&buf[..n]) {
                    Ok(Packet::Error { message, .. }) => {
                        Err(self.fail(format!("The client cancelled: {message}")))
                    }
                    Ok(p) => Ok(Some(p)),
                    // Garbage is ignored like a lost packet.
                    Err(_) => Ok(None),
                },
                // ICMP port unreachable: the client is gone.
                Ok(Err(e)) => Err(self.fail(format!("The client stopped responding ({e})"))),
            },
            _ = self.stopped.changed() => Err(self.fail("The server was stopped")),
        }
    }

    /// Send `pkt` until `done` accepts a reply (retransmitting on timeout).
    async fn exchange(
        &mut self,
        pkt: &[u8],
        mut done: impl FnMut(&Packet) -> bool,
    ) -> Result<Packet, (u64, String)> {
        let mut buf = vec![0u8; MAX_BLOCK_SIZE + 4];
        for _ in 0..=RETRIES {
            self.sock
                .send(pkt)
                .await
                .map_err(|e| self.fail(format!("Could not send to the client ({e})")))?;
            // Duplicates of older packets do not trigger a resend (Sorcerer's Apprentice).
            let deadline = Instant::now() + self.timeout;
            while Instant::now() < deadline {
                match self.recv(&mut buf).await? {
                    Some(p) if done(&p) => return Ok(p),
                    Some(_) => continue,
                    None => break,
                }
            }
        }
        Err(self.fail("The client stopped responding"))
    }
}

/// Accepted options and the resulting block size.
fn negotiate(
    options: &Options,
    tsize: Option<u64>,
    timeout: &mut Duration,
) -> (Options, usize, Option<u64>) {
    let mut accepted = Vec::new();
    let mut blksize = BLOCK_SIZE;
    let mut client_size = None;
    for (name, value) in options {
        match name.as_str() {
            "blksize" => {
                if let Ok(v) = value.parse::<usize>() {
                    if v >= 8 {
                        blksize = v.min(MAX_BLOCK_SIZE);
                        accepted.push((name.clone(), blksize.to_string()));
                    }
                }
            }
            "timeout" => {
                if let Ok(v @ 1..=255) = value.parse::<u64>() {
                    *timeout = Duration::from_secs(v);
                    accepted.push((name.clone(), v.to_string()));
                }
            }
            "tsize" => match tsize {
                Some(size) => accepted.push((name.clone(), size.to_string())),
                None => {
                    if let Ok(v) = value.parse::<u64>() {
                        client_size = Some(v);
                        accepted.push((name.clone(), v.to_string()));
                    }
                }
            },
            _ => {}
        }
    }
    (accepted, blksize, client_size)
}

enum Source {
    File(tokio::fs::File),
    Memory(Vec<u8>, usize),
}

impl Source {
    async fn fill(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Source::File(f) => {
                let mut n = 0;
                while n < buf.len() {
                    let r = f.read(&mut buf[n..]).await?;
                    if r == 0 {
                        break;
                    }
                    n += r;
                }
                Ok(n)
            }
            Source::Memory(data, pos) => {
                let n = (data.len() - *pos).min(buf.len());
                buf[..n].copy_from_slice(&data[*pos..*pos + n]);
                *pos += n;
                Ok(n)
            }
        }
    }
}

async fn serve_read(
    mut t: Transfer,
    path: &Path,
    file: &str,
    peer: SocketAddr,
    mode: Mode,
    options: Options,
) -> Outcome {
    let size = tokio::fs::metadata(path)
        .await
        .map_err(|e| t.fail(e.to_string()))?
        .len();
    let (mut source, wire_size) = match mode {
        Mode::Octet => (
            Source::File(
                tokio::fs::File::open(path)
                    .await
                    .map_err(|e| t.fail(format!("Could not open the file ({e})")))?,
            ),
            size,
        ),
        Mode::NetAscii => {
            if size > MAX_NETASCII {
                return Err(t
                    .abort(
                        ErrorCode::IllegalOperation,
                        "File too large for netascii mode; use octet",
                    )
                    .await);
            }
            let data = netascii::encode(
                &tokio::fs::read(path)
                    .await
                    .map_err(|e| t.fail(e.to_string()))?,
            );
            let len = data.len() as u64;
            (Source::Memory(data, 0), len)
        }
    };
    let mut timeout = t.timeout;
    let (accepted, blksize, _) = negotiate(&options, Some(wire_size), &mut timeout);
    t.timeout = timeout;
    (t.sink)(ServerEvent::Started {
        id: t.id,
        peer: peer.to_string(),
        file: file.to_owned(),
        direction: Direction::Read,
        size: Some(size),
    });
    if !accepted.is_empty() {
        let oack = Packet::OptionAck { options: accepted }.encode();
        t.exchange(&oack, |p| matches!(p, Packet::Ack { block: 0 }))
            .await?;
    }
    let mut block: u16 = 1;
    let mut data = vec![0u8; blksize];
    loop {
        let n = source
            .fill(&mut data)
            .await
            .map_err(|e| t.fail(format!("Could not read the file ({e})")))?;
        let pkt = Packet::Data {
            block,
            data: data[..n].to_vec(),
        }
        .encode();
        let expect = block;
        t.exchange(
            &pkt,
            |p| matches!(p, Packet::Ack { block } if *block == expect),
        )
        .await?;
        t.bytes += n as u64;
        t.progress();
        if n < blksize {
            return Ok(t.bytes);
        }
        block = block.wrapping_add(1);
    }
}

fn part_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.cairn-part"))
}

async fn serve_write(
    mut t: Transfer,
    path: &Path,
    file: &str,
    peer: SocketAddr,
    mode: Mode,
    options: Options,
) -> Outcome {
    let mut timeout = t.timeout;
    let (accepted, blksize, client_size) = negotiate(&options, None, &mut timeout);
    t.timeout = timeout;
    if client_size.is_some_and(|s| s > MAX_UPLOAD) {
        return Err(t.abort(ErrorCode::DiskFull, "The file is too large").await);
    }
    let part = part_path(path);
    let mut out = tokio::fs::File::create(&part)
        .await
        .map_err(|e| t.fail(format!("Could not create the file ({e})")))?;
    (t.sink)(ServerEvent::Started {
        id: t.id,
        peer: peer.to_string(),
        file: file.to_owned(),
        direction: Direction::Write,
        size: client_size,
    });
    let result = receive(&mut t, &mut out, blksize, accepted, mode).await;
    drop(out);
    match result {
        Ok(()) => match tokio::fs::rename(&part, path).await {
            Ok(()) => Ok(t.bytes),
            Err(e) => {
                let _ = tokio::fs::remove_file(&part).await;
                Err(t.fail(format!("Could not save the file ({e})")))
            }
        },
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(e)
        }
    }
}

async fn receive(
    t: &mut Transfer,
    out: &mut tokio::fs::File,
    blksize: usize,
    accepted: Options,
    mode: Mode,
) -> Result<(), (u64, String)> {
    let mut reply = if accepted.is_empty() {
        Packet::Ack { block: 0 }.encode()
    } else {
        Packet::OptionAck { options: accepted }.encode()
    };
    let mut expect: u16 = 1;
    let mut decoder = netascii::Decoder::default();
    let mut converted = Vec::new();
    loop {
        let want = expect;
        let packet = t
            .exchange(
                &reply,
                |p| matches!(p, Packet::Data { block, .. } if *block == want),
            )
            .await?;
        let Packet::Data { data, .. } = packet else {
            continue;
        };
        if data.len() > blksize {
            return Err(t
                .abort(ErrorCode::IllegalOperation, "Block larger than negotiated")
                .await);
        }
        t.bytes += data.len() as u64;
        if t.bytes > MAX_UPLOAD {
            return Err(t.abort(ErrorCode::DiskFull, "The file is too large").await);
        }
        let last = data.len() < blksize;
        let chunk: &[u8] = match mode {
            Mode::Octet => &data,
            Mode::NetAscii => {
                converted.clear();
                decoder.push(&data, &mut converted);
                if last {
                    decoder.finish(&mut converted);
                }
                &converted
            }
        };
        if let Err(e) = out.write_all(chunk).await {
            return Err(t
                .abort(
                    ErrorCode::DiskFull,
                    &format!("Could not write the file ({e})"),
                )
                .await);
        }
        t.progress();
        reply = Packet::Ack { block: expect }.encode();
        if last {
            out.flush().await.map_err(|e| t.fail(e.to_string()))?;
            // The final ACK; a lost one makes the client resend the last block, which the
            // closed socket ignores (RFC 1350 "dallying" is not required).
            let _ = t.sock.send(&reply).await;
            return Ok(());
        }
        expect = expect.wrapping_add(1);
    }
}
