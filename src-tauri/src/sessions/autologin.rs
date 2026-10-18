//! Types login and enable answers for sessions opened from a device's credential
//! profile (see `cairn_core::login`).

use super::{SessionId, SessionManager, SessionMessage, SessionOutput};
use cairn_core::login::{LoginAutomator, LoginPlan};
use parking_lot::Mutex;
use std::sync::{Arc, Weak};

pub struct AutoLoginOutput {
    inner: Arc<dyn SessionOutput>,
    automator: Mutex<LoginAutomator>,
    sessions: Weak<SessionManager>,
    id: SessionId,
}

/// Wrap `output` so prompts in the first part of the session are answered from `plan`.
/// Returns `output` unchanged when there is nothing to answer.
pub fn wrap(
    output: Arc<dyn SessionOutput>,
    plan: LoginPlan,
    sessions: &Arc<SessionManager>,
    id: &str,
) -> Arc<dyn SessionOutput> {
    if plan.is_empty() {
        return output;
    }
    Arc::new(AutoLoginOutput {
        inner: output,
        automator: Mutex::new(LoginAutomator::new(plan)),
        sessions: Arc::downgrade(sessions),
        id: id.to_owned(),
    })
}

impl SessionOutput for AutoLoginOutput {
    fn data(&self, bytes: Vec<u8>) {
        let keys = {
            let mut a = self.automator.lock();
            if a.is_done() {
                None
            } else {
                a.feed(&bytes)
            }
        };
        self.inner.data(bytes);
        if let Some(keys) = keys {
            // `get` waits for registration if the session is still starting.
            if let Some(session) = self.sessions.upgrade().and_then(|m| m.get(&self.id)) {
                // A failed write means the session is closing; nothing to answer.
                let _ = session.write(&keys);
            }
        }
    }

    fn message(&self, msg: SessionMessage) {
        self.inner.message(msg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cairn_core::terminal::{CloseReason, EventSink, TermEvent, TerminalError, TerminalSession};
    use cairn_core::SecretString;

    #[derive(Default)]
    struct Sink {
        written: Mutex<Vec<u8>>,
    }

    struct Fake {
        sink: Arc<Sink>,
        _events: EventSink,
    }
    impl TerminalSession for Fake {
        fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
            self.sink.written.lock().extend_from_slice(data);
            Ok(())
        }
        fn resize(&self, _: u16, _: u16) -> Result<(), TerminalError> {
            Ok(())
        }
        fn close(&self) {
            (self._events)(TermEvent::Closed(CloseReason::Closed));
        }
    }

    struct Null;
    impl SessionOutput for Null {
        fn data(&self, _: Vec<u8>) {}
        fn message(&self, _: SessionMessage) {}
    }

    #[test]
    fn answers_enable_through_the_session() {
        let mgr = SessionManager::new();
        let sink = Arc::new(Sink::default());
        let id = mgr.allocate_id();
        let plan = LoginPlan {
            username: None,
            password: None,
            enable_secret: Some(SecretString::from("en")),
        };
        let out = wrap(Arc::new(Null), plan, &mgr, &id);
        let s2 = sink.clone();
        mgr.open_with_id::<()>(id, out.clone(), move |events| {
            Ok(Arc::new(Fake {
                sink: s2,
                _events: events,
            }) as Arc<dyn TerminalSession>)
        })
        .expect("open");
        out.data(b"sw1>".to_vec());
        out.data(b"\r\nPassword: ".to_vec());
        assert_eq!(&*sink.written.lock(), b"enable\ren\r");
    }
}
