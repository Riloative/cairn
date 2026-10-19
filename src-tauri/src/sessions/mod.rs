//! Live terminal sessions and their transport to the frontend.
//!
//! Output bytes travel over a per-session `Channel` as raw binary payloads
//! (`InvokeResponseBody::Raw`), never JSON arrays. Lifecycle messages (closed, …) use a
//! second, JSON channel. Input arrives as a raw request body (see `commands::session`).

pub mod autologin;
pub mod log;
pub mod output;
pub mod rdp;
pub mod ssh;

use cairn_core::known_hosts::HostKeyStatus;
use cairn_core::terminal::{CloseReason, EventSink, TermEvent, TerminalSession};
use cairn_proto_ssh::{HostKeyInfo, Progress, Prompt};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Opaque session identifier shared with the frontend.
pub type SessionId = String;

/// Lifecycle messages sent on a session's event channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionMessage {
    /// Connection progress (SSH): connecting / authenticating / connected.
    Progress {
        progress: Progress,
    },
    /// A host key needs the user's decision; answer with `session_prompt_reply`.
    #[serde(rename_all = "camelCase")]
    HostKey {
        prompt_id: u64,
        info: HostKeyInfo,
        status: HostKeyStatus,
        /// `match` / `mismatch` / `unknown` in the user's OpenSSH known_hosts.
        openssh: &'static str,
    },
    /// Credentials or answers needed; answer with `session_prompt_reply`.
    #[serde(rename_all = "camelCase")]
    Prompt {
        prompt_id: u64,
        prompt: Prompt,
    },
    /// The transport is up (Telnet; SSH uses `Progress`).
    Connected,
    Closed {
        reason: CloseReason,
    },
}

/// State of a serial file transfer, sent on the transfer's own channel. Failures are
/// returned as the command's error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum TransferStatus {
    #[serde(rename_all = "camelCase")]
    Running { bytes: u64, total: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Done { files: Vec<String>, bytes: u64 },
}

/// Protocol-specific controls attached to a session (serial lines, Telnet BREAK).
#[derive(Clone)]
pub enum Extra {
    Serial(Arc<SerialControl>),
    Telnet(Arc<cairn_proto_telnet::TelnetSession>),
}

/// A serial session plus the cancel flag of its running transfer.
pub struct SerialControl {
    pub session: Arc<cairn_proto_serial::SerialSession>,
    pub cancel: std::sync::atomic::AtomicBool,
}

impl std::fmt::Debug for Extra {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Extra::Serial(_) => "Extra::Serial",
            Extra::Telnet(_) => "Extra::Telnet",
        })
    }
}

/// Where a session's output goes. Implemented by Tauri channels in production and by
/// collectors in tests.
pub trait SessionOutput: Send + Sync + 'static {
    fn data(&self, bytes: Vec<u8>);
    fn message(&self, msg: SessionMessage);
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<SessionId, Arc<dyn TerminalSession>>>,
    extras: Mutex<HashMap<SessionId, Extra>>,
    next_id: AtomicU64,
}

impl std::fmt::Debug for SessionManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionManager")
            .field("open", &self.sessions.lock().len())
            .finish()
    }
}

impl SessionManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Reserve a fresh session id (so outputs can know it before the session starts).
    pub fn allocate_id(&self) -> SessionId {
        format!("s{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1)
    }

    /// Start a session with a fresh id. See [`SessionManager::open_with_id`].
    #[cfg(test)]
    pub fn open<E>(
        self: &Arc<Self>,
        output: Arc<dyn SessionOutput>,
        start: impl FnOnce(EventSink) -> Result<Arc<dyn TerminalSession>, E>,
    ) -> Result<SessionId, E> {
        let id = self.allocate_id();
        self.open_with_id(id, output, start)
    }

    /// Start a session. `start` receives the event sink and returns the backend; events
    /// are forwarded to `output`, and the session is forgotten once it closes.
    pub fn open_with_id<E>(
        self: &Arc<Self>,
        id: SessionId,
        output: Arc<dyn SessionOutput>,
        start: impl FnOnce(EventSink) -> Result<Arc<dyn TerminalSession>, E>,
    ) -> Result<SessionId, E> {
        let weak = Arc::downgrade(self);
        let sink_id = id.clone();
        let sink: EventSink = Arc::new(move |event| match event {
            TermEvent::Data(bytes) => output.data(bytes),
            TermEvent::Closed(reason) => {
                if let Some(mgr) = weak.upgrade() {
                    mgr.sessions.lock().remove(&sink_id);
                    mgr.extras.lock().remove(&sink_id);
                }
                output.message(SessionMessage::Closed { reason });
            }
        });
        // Insert under the lock so a backend that closes instantly (on its own thread)
        // cannot remove the session before it is registered. `start` must therefore not
        // emit events synchronously on the calling thread.
        let mut sessions = self.sessions.lock();
        let session = start(sink)?;
        sessions.insert(id.clone(), session);
        Ok(id)
    }

    /// Attach protocol-specific controls to an open session.
    pub fn set_extra(&self, id: &str, extra: Extra) {
        if self.sessions.lock().contains_key(id) {
            self.extras.lock().insert(id.to_owned(), extra);
        }
    }

    pub fn extra(&self, id: &str) -> Option<Extra> {
        self.extras.lock().get(id).cloned()
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn TerminalSession>> {
        self.sessions.lock().get(id).cloned()
    }

    pub fn close(&self, id: &str) {
        // Clone out first: `close` may synchronously emit `Closed`, which re-locks.
        let session = self.get(id);
        if let Some(s) = session {
            s.close();
        }
    }

    pub fn close_all(&self) {
        let all: Vec<_> = self.sessions.lock().values().cloned().collect();
        for s in all {
            s.close();
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.sessions.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cairn_core::terminal::TerminalError;

    #[derive(Default)]
    struct Collect {
        data: Mutex<Vec<u8>>,
        messages: Mutex<Vec<SessionMessage>>,
    }
    impl SessionOutput for Collect {
        fn data(&self, bytes: Vec<u8>) {
            self.data.lock().extend(bytes);
        }
        fn message(&self, msg: SessionMessage) {
            self.messages.lock().push(msg);
        }
    }

    /// Echo backend: writes come straight back as output.
    struct Echo {
        sink: EventSink,
    }
    impl TerminalSession for Echo {
        fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
            (self.sink)(TermEvent::Data(data.to_vec()));
            Ok(())
        }
        fn resize(&self, _: u16, _: u16) -> Result<(), TerminalError> {
            Ok(())
        }
        fn close(&self) {
            (self.sink)(TermEvent::Closed(CloseReason::Closed));
        }
    }

    fn open_echo(mgr: &Arc<SessionManager>, out: &Arc<Collect>) -> SessionId {
        mgr.open::<()>(out.clone(), |sink| Ok(Arc::new(Echo { sink })))
            .expect("open")
    }

    #[test]
    fn routes_output_and_forgets_closed_sessions() {
        let mgr = SessionManager::new();
        let out = Arc::new(Collect::default());
        let id = open_echo(&mgr, &out);
        assert_eq!(mgr.len(), 1);
        mgr.get(&id).expect("session").write(b"hi").expect("write");
        assert_eq!(*out.data.lock(), b"hi");
        mgr.close(&id);
        assert_eq!(mgr.len(), 0);
        assert_eq!(
            *out.messages.lock(),
            [SessionMessage::Closed {
                reason: CloseReason::Closed
            }]
        );
    }

    #[test]
    fn ids_are_unique() {
        let mgr = SessionManager::new();
        let out = Arc::new(Collect::default());
        let a = open_echo(&mgr, &out);
        let b = open_echo(&mgr, &out);
        assert_ne!(a, b);
        mgr.close_all();
        assert_eq!(mgr.len(), 0);
    }

    #[test]
    fn failed_start_registers_nothing() {
        let mgr = SessionManager::new();
        let out = Arc::new(Collect::default());
        let r = mgr.open(out, |_| Err::<Arc<dyn TerminalSession>, _>("nope"));
        assert_eq!(r, Err("nope"));
        assert_eq!(mgr.len(), 0);
    }

    #[test]
    fn real_local_shell_round_trip() {
        let mgr = SessionManager::new();
        let out = Arc::new(Collect::default());
        let spec = cairn_pty::ShellSpec {
            program: Some("/bin/sh".into()),
            args: vec!["-c".into(), "read x; echo got-$x".into()],
            ..Default::default()
        };
        let id = mgr
            .open(out.clone(), |sink| {
                cairn_pty::LocalPty::spawn(&spec, 80, 24, sink)
                    .map(|p| Arc::new(p) as Arc<dyn TerminalSession>)
            })
            .expect("spawn");
        mgr.get(&id)
            .expect("session")
            .write(b"abc\n")
            .expect("write");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while mgr.len() > 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let text = String::from_utf8_lossy(&out.data.lock()).into_owned();
        assert!(text.contains("got-abc"), "{text:?}");
        assert!(matches!(
            out.messages.lock()[0],
            SessionMessage::Closed {
                reason: CloseReason::Exited { code: Some(0) }
            }
        ));
    }
}
