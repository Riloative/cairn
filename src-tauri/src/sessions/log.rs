//! Optional session logging: raw output with a timestamp at the start of every line.
//! Only output is logged (never keystrokes), so passwords typed at prompts are not
//! recorded. Escape sequences are kept as-is: logs stay raw.

use super::{SessionMessage, SessionOutput};
use parking_lot::Mutex;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Inserts `[timestamp] ` before each line of a byte stream.
#[derive(Debug, Default)]
pub struct LineStamper {
    at_line_start: bool,
}

impl LineStamper {
    pub fn new() -> Self {
        Self {
            at_line_start: true,
        }
    }

    pub fn stamp(&mut self, bytes: &[u8], now: &str, out: &mut Vec<u8>) {
        for &b in bytes {
            if self.at_line_start {
                out.extend_from_slice(format!("[{now}] ").as_bytes());
                self.at_line_start = false;
            }
            out.push(b);
            if b == b'\n' {
                self.at_line_start = true;
            }
        }
    }
}

/// Characters safe for a log file name.
pub fn sanitize(target: &str) -> String {
    let s: String = target
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(60)
        .collect();
    if s.is_empty() {
        "session".into()
    } else {
        s
    }
}

/// `<dir>/<YYYY-MM-DD>/<HHMMSS>-<protocol>-<target>-<id>.log`
pub fn log_path(dir: &Path, protocol: &str, target: &str, session_id: &str) -> PathBuf {
    let now = chrono::Local::now();
    dir.join(now.format("%Y-%m-%d").to_string()).join(format!(
        "{}-{protocol}-{}-{session_id}.log",
        now.format("%H%M%S"),
        sanitize(target)
    ))
}

pub struct LoggingOutput {
    pub inner: Arc<dyn SessionOutput>,
    writer: Mutex<(LineStamper, BufWriter<File>)>,
}

impl LoggingOutput {
    pub fn create(inner: Arc<dyn SessionOutput>, path: &Path) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(Self {
            inner,
            writer: Mutex::new((LineStamper::new(), BufWriter::new(File::create(path)?))),
        })
    }
}

fn now() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string()
}

impl SessionOutput for LoggingOutput {
    fn data(&self, bytes: Vec<u8>) {
        {
            let mut guard = self.writer.lock();
            let (stamper, file) = &mut *guard;
            let mut buf = Vec::with_capacity(bytes.len() + 32);
            stamper.stamp(&bytes, &now(), &mut buf);
            // Logging must never break the session; a full disk only loses the log.
            let _ = file.write_all(&buf);
        }
        self.inner.data(bytes);
    }

    fn message(&self, msg: SessionMessage) {
        if let SessionMessage::Closed { .. } = msg {
            let _ = self.writer.lock().1.flush();
        }
        self.inner.message(msg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_each_line_across_chunks() {
        let mut s = LineStamper::new();
        let mut out = Vec::new();
        s.stamp(b"hello\nwor", "T1", &mut out);
        s.stamp(b"ld\n", "T2", &mut out);
        s.stamp(b"\x1b[32mok\x1b[0m", "T3", &mut out);
        assert_eq!(
            String::from_utf8_lossy(&out),
            "[T1] hello\n[T1] world\n[T3] \x1b[32mok\x1b[0m"
        );
    }

    #[test]
    fn sanitizes_targets() {
        assert_eq!(sanitize("[2001:db8::1]:22"), "_2001_db8__1__22");
        assert_eq!(sanitize(""), "session");
        assert_eq!(sanitize("/bin/bash"), "_bin_bash");
    }

    #[test]
    fn writes_a_log_file() {
        struct Null;
        impl SessionOutput for Null {
            fn data(&self, _: Vec<u8>) {}
            fn message(&self, _: SessionMessage) {}
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let path = log_path(dir.path(), "ssh", "sw1:22", "s1");
        let out = LoggingOutput::create(Arc::new(Null), &path).expect("create");
        out.data(b"line one\nline two\n".to_vec());
        out.message(SessionMessage::Closed {
            reason: cairn_core::terminal::CloseReason::Closed,
        });
        let text = std::fs::read_to_string(&path).expect("read");
        assert_eq!(text.lines().count(), 2);
        assert!(text.lines().all(|l| l.starts_with('[')));
        assert!(path.to_string_lossy().contains("ssh-sw1_22-s1"));
    }
}
