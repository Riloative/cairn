//! Spawning a shell on a pseudo-terminal.

use cairn_core::terminal::{
    clamp_size, CloseReason, EventSink, TermEvent, TerminalError, TerminalSession,
};
use cairn_core::UserFacingError;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// What to run in a local terminal.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpec {
    /// Program to run; the user's login shell when `None`.
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    /// Working directory; the home directory when `None`.
    pub cwd: Option<PathBuf>,
    /// Extra environment variables.
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("Could not create a pseudo-terminal: {0}")]
    Open(String),
    #[error("Could not start {program}: {message}")]
    Spawn { program: String, message: String },
}

impl UserFacingError for PtyError {
    fn code(&self) -> &'static str {
        match self {
            PtyError::Open(_) => "pty.open",
            PtyError::Spawn { .. } => "pty.spawn",
        }
    }

    fn hint(&self) -> Option<String> {
        match self {
            PtyError::Spawn { program, .. } => Some(format!(
                "Check that {program} is installed and executable, or pick another shell in the terminal profile."
            )),
            PtyError::Open(_) => None,
        }
    }
}

/// The user's shell: `$SHELL`, else the platform default.
pub fn default_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".into()
            } else {
                "/bin/bash".into()
            }
        })
}

/// A running local shell.
pub struct LocalPty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    closed_by_user: Arc<AtomicBool>,
}

impl std::fmt::Debug for LocalPty {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalPty").finish_non_exhaustive()
    }
}

impl LocalPty {
    /// Spawn `spec` on a new PTY of `cols`×`rows`. Output and exit are reported to `sink`
    /// from a background thread.
    pub fn spawn(
        spec: &ShellSpec,
        cols: u16,
        rows: u16,
        sink: EventSink,
    ) -> Result<Self, PtyError> {
        let (cols, rows) = clamp_size(cols, rows);
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::Open(e.to_string()))?;

        let program = spec.program.clone().unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(&program);
        if spec.program.is_none() && spec.args.is_empty() {
            // Login shell so the user's profile (PATH etc.) applies, as in other terminals.
            cmd.arg("-l");
        }
        cmd.args(&spec.args);
        match &spec.cwd {
            Some(dir) => cmd.cwd(dir),
            None => {
                if let Some(home) = std::env::var_os("HOME") {
                    cmd.cwd(home);
                }
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Cairn");
        cmd.env("TERM_PROGRAM_VERSION", cairn_core::VERSION);
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        let mut child = pair.slave.spawn_command(cmd).map_err(|e| PtyError::Spawn {
            program: program.clone(),
            message: e.to_string(),
        })?;
        // The slave end belongs to the child now; keeping it open would hide EOF.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::Open(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::Open(e.to_string()))?;
        let killer = child.clone_killer();
        let closed_by_user = Arc::new(AtomicBool::new(false));

        let closed_flag = closed_by_user.clone();
        std::thread::Builder::new()
            .name("cairn-pty-reader".into())
            .spawn(move || {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => sink(TermEvent::Data(buf[..n].to_vec())),
                        // EIO is how Linux reports a PTY whose child has exited.
                        Err(_) => break,
                    }
                }
                let reason = if closed_flag.load(Ordering::SeqCst) {
                    CloseReason::Closed
                } else {
                    let code = child.wait().ok().map(|s| s.exit_code() as i32);
                    CloseReason::Exited { code }
                };
                sink(TermEvent::Closed(reason));
            })
            .map_err(|e| PtyError::Open(e.to_string()))?;

        Ok(Self {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            closed_by_user,
        })
    }
}

impl TerminalSession for LocalPty {
    fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        let mut w = self.writer.lock();
        w.write_all(data)
            .and_then(|()| w.flush())
            .map_err(|e| TerminalError::Io(e.to_string()))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let (cols, rows) = clamp_size(cols, rows);
        self.master
            .lock()
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::Io(e.to_string()))
    }

    fn close(&self) {
        self.closed_by_user.store(true, Ordering::SeqCst);
        // Already-exited children return an error here; either way the reader ends.
        let _ = self.killer.lock().kill();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn collect() -> (EventSink, mpsc::Receiver<TermEvent>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        (
            Arc::new(move |e| {
                let _ = tx.lock().send(e);
            }),
            rx,
        )
    }

    /// Gather output until the session closes (or time out).
    fn drain(rx: &mpsc::Receiver<TermEvent>) -> (String, CloseReason) {
        let mut out = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(10)) {
                Ok(TermEvent::Data(d)) => out.extend(d),
                Ok(TermEvent::Closed(r)) => return (String::from_utf8_lossy(&out).into(), r),
                Err(e) => panic!("timed out waiting for the session: {e}"),
            }
        }
    }

    fn sh(script: &str) -> ShellSpec {
        ShellSpec {
            program: Some("/bin/sh".into()),
            args: vec!["-c".into(), script.into()],
            ..Default::default()
        }
    }

    #[test]
    fn runs_a_command_and_reports_exit_code() {
        let (sink, rx) = collect();
        let _pty = LocalPty::spawn(&sh("echo hello-cairn; exit 3"), 80, 24, sink).expect("spawn");
        let (out, reason) = drain(&rx);
        assert!(out.contains("hello-cairn"), "output: {out:?}");
        assert_eq!(reason, CloseReason::Exited { code: Some(3) });
    }

    #[test]
    fn sets_terminal_environment() {
        let (sink, rx) = collect();
        let _pty =
            LocalPty::spawn(&sh("echo \"$TERM/$TERM_PROGRAM\""), 80, 24, sink).expect("spawn");
        let (out, _) = drain(&rx);
        assert!(out.contains("xterm-256color/Cairn"), "output: {out:?}");
    }

    #[test]
    fn forwards_input_and_resizes() {
        let (sink, rx) = collect();
        let pty = LocalPty::spawn(&sh("read line; stty size; echo got:$line"), 80, 24, sink)
            .expect("spawn");
        pty.resize(100, 30).expect("resize");
        pty.write(b"ping\n").expect("write");
        let (out, reason) = drain(&rx);
        assert!(out.contains("30 100"), "output: {out:?}");
        assert!(out.contains("got:ping"), "output: {out:?}");
        assert_eq!(reason, CloseReason::Exited { code: Some(0) });
    }

    #[test]
    fn close_reports_closed() {
        let (sink, rx) = collect();
        let pty = LocalPty::spawn(&sh("sleep 30"), 80, 24, sink).expect("spawn");
        pty.close();
        let (_, reason) = drain(&rx);
        assert_eq!(reason, CloseReason::Closed);
    }

    #[test]
    fn missing_program_is_a_spawn_error() {
        let (sink, _rx) = collect();
        let spec = ShellSpec {
            program: Some("/nonexistent/shell".into()),
            ..Default::default()
        };
        let err = LocalPty::spawn(&spec, 80, 24, sink).expect_err("should fail");
        assert!(matches!(err, PtyError::Spawn { .. }));
        assert!(err.hint().is_some());
    }
}
