//! Session recording: wraps a session's output and stores asciicast events in the
//! encrypted database (see `cairn_core::recording`).

use super::{SessionMessage, SessionOutput};
use cairn_core::recording::{self, Encoder, NewRecording};
use cairn_core::Vault;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Store buffered events at least this often while output flows.
const FLUSH_INTERVAL: Duration = Duration::from_secs(2);
/// ...or once this much is buffered.
const FLUSH_BYTES: usize = 64 * 1024;
/// While Cairn is locked events stay in memory up to this size; beyond it they are
/// dropped and the recording is marked truncated.
const MAX_BUFFERED: usize = 32 * 1024 * 1024;

struct State {
    encoder: Encoder,
    last_flush: Instant,
    truncated: bool,
    /// The limit was hit; nothing more is stored.
    full: bool,
    /// The session closed; the end is stored once the vault is unlocked.
    ended: Option<(String, i64)>,
}

pub struct Recording {
    id: i64,
    started: Instant,
    vault: Arc<Mutex<Vault>>,
    state: Mutex<State>,
}

impl Recording {
    fn secs(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    /// Write buffered events (and the end, once closed). Returns true when nothing is
    /// left to write.
    fn flush(&self) -> bool {
        let mut st = self.state.lock();
        let data = st.encoder.take();
        let vault = self.vault.lock();
        let stored = vault.with_conn(|c| {
            if !st.full && !recording::append(c, self.id, &data)? {
                st.full = true;
                st.truncated = true;
            }
            if let Some((ended_at, ms)) = &st.ended {
                recording::finish(c, self.id, ended_at, *ms, st.truncated)?;
            }
            Ok(())
        });
        st.last_flush = Instant::now();
        match stored {
            Ok(()) => st.ended.is_some(),
            Err(_) => {
                // Locked (or a database error): keep the events for the next attempt.
                if data.len() + st.encoder.buffered() <= MAX_BUFFERED {
                    st.encoder.restore(data);
                } else {
                    st.truncated = true;
                }
                false
            }
        }
    }

    fn output(&self, bytes: &[u8]) {
        let due = {
            let mut st = self.state.lock();
            if st.full {
                return;
            }
            let secs = self.secs();
            st.encoder.output(secs, bytes);
            st.encoder.buffered() >= FLUSH_BYTES || st.last_flush.elapsed() >= FLUSH_INTERVAL
        };
        if due {
            self.flush();
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let secs = self.secs();
        self.state.lock().encoder.resize(secs, cols, rows);
    }

    /// Mark the end; returns true when everything was stored.
    fn close(&self) -> bool {
        {
            let mut st = self.state.lock();
            let secs = self.secs();
            st.encoder.finish(secs);
            let ms = i64::try_from(self.started.elapsed().as_millis()).unwrap_or(i64::MAX);
            st.ended = Some((cairn_core::audit::now(), ms));
        }
        self.flush()
    }
}

/// Recordings by session id: resizes reach them, and recordings that ended while
/// Cairn was locked are finished on the next unlock.
#[derive(Default)]
pub struct Recorders {
    live: Mutex<HashMap<String, Arc<Recording>>>,
}

impl std::fmt::Debug for Recorders {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Recorders")
            .field("live", &self.live.lock().len())
            .finish()
    }
}

impl Recorders {
    /// Start recording a session; `None` if the recording cannot be created (the
    /// session then runs unrecorded).
    pub fn start(&self, vault: &Arc<Mutex<Vault>>, meta: &NewRecording) -> Option<Arc<Recording>> {
        let id = vault.lock().with_conn(|c| recording::start(c, meta)).ok()?;
        let rec = Arc::new(Recording {
            id,
            started: Instant::now(),
            vault: vault.clone(),
            state: Mutex::new(State {
                encoder: Encoder::new(),
                last_flush: Instant::now(),
                truncated: false,
                full: false,
                ended: None,
            }),
        });
        self.live
            .lock()
            .insert(meta.session_id.clone(), rec.clone());
        Some(rec)
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) {
        if let Some(r) = self.live.lock().get(session_id) {
            r.resize(cols, rows);
        }
    }

    fn closed(&self, session_id: &str, done: bool) {
        if done {
            self.live.lock().remove(session_id);
        }
    }

    /// Store what recordings buffered while locked (called after unlock).
    pub fn flush(&self) {
        let all: Vec<(String, Arc<Recording>)> = self
            .live
            .lock()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (session_id, rec) in all {
            if rec.flush() {
                self.live.lock().remove(&session_id);
            }
        }
    }

    /// Whether a session is being recorded.
    pub fn is_recording(&self, session_id: &str) -> bool {
        self.live.lock().contains_key(session_id)
    }
}

/// Records output on its way to the inner output.
pub struct RecordingOutput {
    pub inner: Arc<dyn SessionOutput>,
    pub recording: Arc<Recording>,
    pub recorders: Arc<Recorders>,
    pub session_id: String,
}

impl SessionOutput for RecordingOutput {
    fn data(&self, bytes: Vec<u8>) {
        self.recording.output(&bytes);
        self.inner.data(bytes);
    }

    fn message(&self, msg: SessionMessage) {
        if let SessionMessage::Closed { .. } = msg {
            let done = self.recording.close();
            self.recorders.closed(&self.session_id, done);
        }
        self.inner.message(msg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cairn_core::terminal::CloseReason;
    use cairn_core::SecretString;

    struct Null;
    impl SessionOutput for Null {
        fn data(&self, _: Vec<u8>) {}
        fn message(&self, _: SessionMessage) {}
    }

    fn meta() -> NewRecording {
        NewRecording {
            session_id: "s1".into(),
            protocol: "ssh".into(),
            target: "sw1:22".into(),
            device_id: None,
            device: "sw1".into(),
            cols: 80,
            rows: 24,
            started_at: cairn_core::audit::now(),
        }
    }

    fn vault(dir: &std::path::Path) -> Arc<Mutex<Vault>> {
        let mut v = Vault::new(dir);
        v.setup_with_params(
            &SecretString::from("correct horse battery"),
            cairn_core::kdf::KdfParams::new(1024, 1, 1).expect("rng"),
        )
        .expect("setup");
        Arc::new(Mutex::new(v))
    }

    #[test]
    fn records_output_and_resizes_until_close() {
        let dir = tempfile::tempdir().expect("tmp");
        let vault = vault(dir.path());
        let recorders = Arc::new(Recorders::default());
        let rec = recorders.start(&vault, &meta()).expect("start");
        let out = RecordingOutput {
            inner: Arc::new(Null),
            recording: rec,
            recorders: recorders.clone(),
            session_id: "s1".into(),
        };
        out.data(b"sw1# ".to_vec());
        recorders.resize("s1", 132, 40);
        out.data(b"show clock\r\n".to_vec());
        assert!(recorders.is_recording("s1"));
        out.message(SessionMessage::Closed {
            reason: CloseReason::Closed,
        });
        assert!(!recorders.is_recording("s1"));
        let (list, cast) = vault
            .lock()
            .with_conn(|c| {
                let list = recording::list(c)?;
                let cast = recording::cast(c, list[0].id)?;
                Ok((list, cast))
            })
            .expect("read");
        assert!(list[0].ended_at.is_some());
        assert!(cast.contains("\"r\", \"132x40\""));
        assert!(cast.contains("show clock"));
    }

    #[test]
    fn keeps_events_while_locked_and_stores_them_after_unlock() {
        let dir = tempfile::tempdir().expect("tmp");
        let vault = vault(dir.path());
        let recorders = Arc::new(Recorders::default());
        let rec = recorders.start(&vault, &meta()).expect("start");
        let out = RecordingOutput {
            inner: Arc::new(Null),
            recording: rec,
            recorders: recorders.clone(),
            session_id: "s1".into(),
        };
        vault
            .lock()
            .lock(cairn_core::audit::LockReason::Manual)
            .expect("lock");
        out.data(b"output while locked\r\n".to_vec());
        out.message(SessionMessage::Closed {
            reason: CloseReason::Closed,
        });
        // Not stored yet: still pending.
        assert!(recorders.is_recording("s1"));
        vault
            .lock()
            .unlock(&SecretString::from("correct horse battery"))
            .expect("unlock");
        recorders.flush();
        assert!(!recorders.is_recording("s1"));
        let cast = vault
            .lock()
            .with_conn(|c| {
                let id = recording::list(c)?[0].id;
                recording::cast(c, id)
            })
            .expect("read");
        assert!(cast.contains("output while locked"));
    }
}
