//! A Telnet (or raw TCP) connection as a [`TerminalSession`].

use crate::negotiation::Negotiator;
use cairn_core::terminal::{
    clamp_size, CloseReason, EventSink, TermEvent, TerminalError, TerminalSession,
};
use cairn_core::UserFacingError;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Notify};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelnetOptions {
    pub host: String,
    pub port: u16,
    /// Plain TCP without Telnet negotiation (console servers in "raw" mode).
    #[serde(default)]
    pub raw: bool,
    #[serde(default = "default_timeout")]
    pub connect_timeout_secs: u32,
}

fn default_timeout() -> u32 {
    10
}

impl TelnetOptions {
    pub fn target(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TelnetError {
    #[error("Connection to {0} was refused.")]
    Refused(String),
    #[error("Timed out connecting to {0}.")]
    Timeout(String),
    #[error("Could not connect to {target}: {message}")]
    Connect { target: String, message: String },
    #[error("The connection was lost: {0}")]
    Disconnected(String),
}

impl UserFacingError for TelnetError {
    fn code(&self) -> &'static str {
        match self {
            TelnetError::Refused(_) => "telnet.refused",
            TelnetError::Timeout(_) => "telnet.timeout",
            TelnetError::Connect { .. } => "telnet.connect",
            TelnetError::Disconnected(_) => "telnet.disconnected",
        }
    }

    fn hint(&self) -> Option<String> {
        match self {
            TelnetError::Refused(_) => Some(
                "Check the port. For a console server, make sure the port is in Telnet mode and not already in use by another session.".into(),
            ),
            TelnetError::Timeout(_) => Some("Check the address and any firewall in between.".into()),
            _ => None,
        }
    }
}

enum Cmd {
    Data(Vec<u8>),
    Resize(u16, u16),
    Break,
}

pub struct TelnetSession {
    tx: mpsc::UnboundedSender<Cmd>,
    cancel: Arc<Notify>,
    closing: Arc<AtomicBool>,
}

impl std::fmt::Debug for TelnetSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TelnetSession").finish_non_exhaustive()
    }
}

fn describe(e: &TelnetError) -> String {
    match e.hint() {
        Some(h) => format!("{} {h}", e.user_message()),
        None => e.user_message(),
    }
}

impl TelnetSession {
    /// Start connecting; `on_connected` runs once the TCP connection is up.
    pub fn start(
        runtime: &tokio::runtime::Handle,
        opts: TelnetOptions,
        cols: u16,
        rows: u16,
        sink: EventSink,
        on_connected: Box<dyn FnOnce() + Send>,
    ) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let cancel = Arc::new(Notify::new());
        let closing = Arc::new(AtomicBool::new(false));
        let (c, cl) = (cancel.clone(), closing.clone());
        runtime.spawn(async move {
            let reason = tokio::select! {
                r = run(opts, clamp_size(cols, rows), sink.clone(), rx, on_connected) => r,
                () = c.notified() => CloseReason::Closed,
            };
            let reason = if cl.load(Ordering::SeqCst) {
                CloseReason::Closed
            } else {
                reason
            };
            sink(TermEvent::Closed(reason));
        });
        Self {
            tx,
            cancel,
            closing,
        }
    }

    /// Send a Telnet BREAK (IAC BRK); for raw TCP this is a no-op.
    pub fn send_break(&self) -> Result<(), TerminalError> {
        self.tx.send(Cmd::Break).map_err(|_| TerminalError::Closed)
    }
}

async fn connect(opts: &TelnetOptions) -> Result<TcpStream, TelnetError> {
    let target = opts.target();
    let timeout = Duration::from_secs(u64::from(opts.connect_timeout_secs.max(1)));
    match tokio::time::timeout(timeout, TcpStream::connect((opts.host.as_str(), opts.port))).await {
        Err(_) => Err(TelnetError::Timeout(target)),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
            Err(TelnetError::Refused(target))
        }
        Ok(Err(e)) => Err(TelnetError::Connect {
            target,
            message: e.to_string(),
        }),
        Ok(Ok(s)) => {
            let _ = s.set_nodelay(true);
            Ok(s)
        }
    }
}

async fn run(
    opts: TelnetOptions,
    (cols, rows): (u16, u16),
    sink: EventSink,
    mut rx: mpsc::UnboundedReceiver<Cmd>,
    on_connected: Box<dyn FnOnce() + Send>,
) -> CloseReason {
    let stream = match connect(&opts).await {
        Ok(s) => s,
        Err(e) => {
            return CloseReason::Error {
                message: describe(&e),
            }
        }
    };
    on_connected();
    let (mut reader, mut writer) = stream.into_split();
    let mut neg = Negotiator::new(cols, rows);
    let mut buf = vec![0u8; 16 * 1024];
    let lost = |e: std::io::Error| CloseReason::Error {
        message: describe(&TelnetError::Disconnected(e.to_string())),
    };
    loop {
        tokio::select! {
            n = reader.read(&mut buf) => match n {
                Ok(0) => return CloseReason::Exited { code: None },
                Ok(n) => {
                    if opts.raw {
                        sink(TermEvent::Data(buf[..n].to_vec()));
                        continue;
                    }
                    let r = neg.receive(&buf[..n]);
                    if !r.data.is_empty() {
                        sink(TermEvent::Data(r.data));
                    }
                    if !r.reply.is_empty() {
                        if let Err(e) = writer.write_all(&r.reply).await {
                            return lost(e);
                        }
                    }
                }
                Err(e) => return lost(e),
            },
            cmd = rx.recv() => {
                let bytes = match cmd {
                    Some(Cmd::Data(d)) if opts.raw => d,
                    Some(Cmd::Data(d)) => neg.encode_input(&d),
                    Some(Cmd::Resize(c, r)) => match neg.resize(c, r) {
                        Some(m) if !opts.raw => m,
                        _ => continue,
                    },
                    Some(Cmd::Break) if !opts.raw => Negotiator::break_command().to_vec(),
                    Some(Cmd::Break) => continue,
                    None => return CloseReason::Closed,
                };
                if let Err(e) = writer.write_all(&bytes).await {
                    return lost(e);
                }
            }
        }
    }
}

impl TerminalSession for TelnetSession {
    fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        self.tx
            .send(Cmd::Data(data.to_vec()))
            .map_err(|_| TerminalError::Closed)
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let (c, r) = clamp_size(cols, rows);
        self.tx
            .send(Cmd::Resize(c, r))
            .map_err(|_| TerminalError::Closed)
    }

    fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.cancel.notify_one();
    }
}
