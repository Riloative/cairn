//! Live terminal sessions and their transport to the frontend.
//!
//! Output bytes travel over a per-session `Channel` as raw binary payloads
//! (`InvokeResponseBody::Raw`), never JSON arrays. Lifecycle messages (closed, …) use a
//! second, JSON channel. Input arrives as a raw request body (see `commands::session`).

use cairn_core::terminal::{CloseReason, EventSink, TermEvent, TerminalSession};
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
    Closed { reason: CloseReason },
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

    /// Start a session. `start` receives the event sink and returns the backend; events
    /// are forwarded to `output`, and the session is forgotten once it closes.
    pub fn open<E>(
        self: &Arc<Self>,
        output: Arc<dyn SessionOutput>,
        start: impl FnOnce(EventSink) -> Result<Arc<dyn TerminalSession>, E>,
    ) -> Result<SessionId, E> {
        let id = format!("s{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let weak = Arc::downgrade(self);
        let sink_id = id.clone();
        let sink: EventSink = Arc::new(move |event| match event {
            TermEvent::Data(bytes) => output.data(bytes),
            TermEvent::Closed(reason) => {
                if let Some(mgr) = weak.upgrade() {
                    mgr.sessions.lock().remove(&sink_id);
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
