//! An interactive SSH shell exposed as a [`TerminalSession`].
//!
//! [`SshSession::start`] returns immediately; connecting, authenticating and opening the
//! shell happen on a background task. Input typed meanwhile is queued and sent once the
//! shell is open. The session reports the outcome through the event sink.

use crate::connect::{connect, ConnectOptions, Connection};
use crate::error::SshError;
use crate::interact::{Interact, Progress};
use cairn_core::terminal::{
    clamp_size, CloseReason, EventSink, TermEvent, TerminalError, TerminalSession,
};
use cairn_core::UserFacingError;
use russh::ChannelMsg;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};

#[derive(Debug)]
enum Cmd {
    Data(Vec<u8>),
    Resize(u16, u16),
}

/// Terminal type requested from the server.
pub const TERM: &str = "xterm-256color";

/// The live connection of a session, shared with SFTP, forwards and config grab.
type Link = Arc<std::sync::Mutex<Option<Arc<Connection>>>>;

pub struct SshSession {
    tx: mpsc::UnboundedSender<Cmd>,
    cancel: Arc<Notify>,
    closing: Arc<AtomicBool>,
    link: Link,
}

impl std::fmt::Debug for SshSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshSession").finish_non_exhaustive()
    }
}

impl SshSession {
    /// Start connecting on `runtime`. Events (output, close) go to `sink`.
    pub fn start(
        runtime: &tokio::runtime::Handle,
        opts: ConnectOptions,
        cols: u16,
        rows: u16,
        interact: Arc<dyn Interact>,
        sink: EventSink,
    ) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let cancel = Arc::new(Notify::new());
        let closing = Arc::new(AtomicBool::new(false));
        let link = Link::default();
        let (c, cl, l) = (cancel.clone(), closing.clone(), link.clone());
        runtime.spawn(async move {
            let reason = tokio::select! {
                r = run(opts, clamp_size(cols, rows), interact, sink.clone(), rx, l.clone()) => r,
                () = c.notified() => CloseReason::Closed,
            };
            // Forwards and SFTP sessions see the connection go away with the shell.
            if let Some(conn) = l.lock().ok().and_then(|mut g| g.take()) {
                let _ = conn
                    .handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
            }
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
            link,
        }
    }

    /// The authenticated connection once the shell is open (None before or after).
    pub fn connection(&self) -> Option<Arc<Connection>> {
        self.link.lock().ok().and_then(|g| g.clone())
    }
}

impl TerminalSession for SshSession {
    fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        self.tx
            .send(Cmd::Data(data.to_vec()))
            .map_err(|_| TerminalError::Closed)
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let (cols, rows) = clamp_size(cols, rows);
        self.tx
            .send(Cmd::Resize(cols, rows))
            .map_err(|_| TerminalError::Closed)
    }

    fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        // notify_one stores a permit, so a close before the task polls is not lost.
        self.cancel.notify_one();
    }
}

/// Human-readable failure with the actionable hint appended.
fn describe(err: &SshError) -> String {
    match err.hint() {
        Some(h) => format!("{} {h}", err.user_message()),
        None => err.user_message(),
    }
}

async fn run(
    opts: ConnectOptions,
    (mut cols, mut rows): (u16, u16),
    interact: Arc<dyn Interact>,
    sink: EventSink,
    mut rx: mpsc::UnboundedReceiver<Cmd>,
    link: Link,
) -> CloseReason {
    let conn = match connect(&opts, interact.clone()).await {
        Ok(c) => Arc::new(c),
        Err(e) => {
            return CloseReason::Error {
                message: describe(&e),
            }
        }
    };
    let target = conn.target.clone();
    let fail = |e: russh::Error| CloseReason::Error {
        message: describe(&SshError::from_russh(e, &target)),
    };

    // Apply resizes that arrived while connecting; keep queued input for after the shell.
    let mut pending = Vec::new();
    while let Ok(cmd) = rx.try_recv() {
        match cmd {
            Cmd::Resize(c, r) => (cols, rows) = (c, r),
            data @ Cmd::Data(_) => pending.push(data),
        }
    }

    // Opening the channel and requesting the PTY/shell can hang on a wedged server;
    // bound it by the same timeout used for the connect/handshake.
    let setup_timeout = std::time::Duration::from_secs(u64::from(opts.connect_timeout_secs.max(1)));
    let setup = async {
        let channel = conn
            .handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::Channel(e.to_string()))?;
        channel
            .request_pty(false, TERM, u32::from(cols), u32::from(rows), 0, 0, &[])
            .await
            .map_err(|e| SshError::from_russh(e, &target))?;
        if opts.agent_forwarding {
            // Servers may refuse forwarding (AllowAgentForwarding no); the shell still works.
            let _ = channel.agent_forward(false).await;
        }
        channel
            .request_shell(false)
            .await
            .map_err(|e| SshError::from_russh(e, &target))?;
        Ok::<_, SshError>(channel)
    };
    let mut channel = match tokio::time::timeout(setup_timeout, setup).await {
        Ok(Ok(ch)) => ch,
        Ok(Err(e)) => {
            return CloseReason::Error {
                message: describe(&e),
            }
        }
        Err(_) => {
            return CloseReason::Error {
                message: describe(&SshError::Timeout {
                    target: target.clone(),
                }),
            }
        }
    };
    if let Ok(mut slot) = link.lock() {
        *slot = Some(conn.clone());
    }
    interact.progress(Progress::Connected {
        host_key: conn.host_key.clone(),
    });
    for cmd in pending {
        if let Cmd::Data(d) = cmd {
            if let Err(e) = channel.data_bytes(d).await {
                return fail(e);
            }
        }
    }

    let mut exit_code: Option<i32> = None;
    let mut ended_cleanly = false;
    loop {
        tokio::select! {
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { data }) => sink(TermEvent::Data(data.to_vec())),
                Some(ChannelMsg::ExtendedData { data, .. }) => sink(TermEvent::Data(data.to_vec())),
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = Some(exit_status as i32);
                    ended_cleanly = true;
                }
                Some(ChannelMsg::ExitSignal { .. }) | Some(ChannelMsg::Eof) => ended_cleanly = true,
                Some(ChannelMsg::Close) => {
                    ended_cleanly = true;
                    break;
                }
                None => break,
                Some(_) => {}
            },
            cmd = rx.recv() => match cmd {
                Some(Cmd::Data(d)) => {
                    if let Err(e) = channel.data_bytes(d).await {
                        return fail(e);
                    }
                }
                Some(Cmd::Resize(c, r)) => {
                    // Not fatal: some network OSes ignore window-change.
                    let _ = channel.window_change(u32::from(c), u32::from(r), 0, 0).await;
                }
                // The session object was dropped.
                None => break,
            },
        }
    }

    if let Ok(mut slot) = link.lock() {
        *slot = None;
    }
    let _ = conn
        .handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;
    if ended_cleanly {
        CloseReason::Exited { code: exit_code }
    } else {
        CloseReason::Error {
            message: describe(&SshError::Disconnected(
                "no response from the server (network down or device rebooted)".into(),
            )),
        }
    }
}
