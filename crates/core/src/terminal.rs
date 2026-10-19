//! Protocol-neutral interface for byte-stream terminal sessions.
//!
//! Every terminal backend (local PTY, SSH, serial, Telnet) implements
//! [`TerminalSession`] and reports output through an [`EventSink`]. The Tauri layer owns
//! the sessions and forwards events to the frontend over binary channels; backends never
//! know about the UI.

use serde::Serialize;
use std::sync::Arc;

/// Why a session ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CloseReason {
    /// The remote side or local process ended normally.
    Exited { code: Option<i32> },
    /// The user closed the session.
    Closed,
    /// The connection failed or dropped; `message` is user-facing.
    Error { message: String },
}

impl CloseReason {
    /// Unexpected ends trigger a desktop notification and the reconnect overlay.
    pub fn is_unexpected(&self) -> bool {
        matches!(self, CloseReason::Error { .. })
    }
}

/// Output from a terminal backend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TermEvent {
    /// Raw bytes for the terminal emulator. Never transformed.
    Data(Vec<u8>),
    /// The session ended. No events follow.
    Closed(CloseReason),
}

/// Callback receiving a backend's events, possibly from a background thread.
pub type EventSink = Arc<dyn Fn(TermEvent) + Send + Sync>;

/// Errors from terminal I/O.
#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("The session has ended.")]
    Closed,
    #[error("Could not send input: {0}")]
    Io(String),
}

impl crate::UserFacingError for TerminalError {
    fn code(&self) -> &'static str {
        match self {
            TerminalError::Closed => "session.closed",
            TerminalError::Io(_) => "session.io",
        }
    }
}

/// A running terminal session.
pub trait TerminalSession: Send + Sync {
    /// Send user input (already encoded by the terminal emulator).
    fn write(&self, data: &[u8]) -> Result<(), TerminalError>;
    /// Inform the backend of the terminal size in character cells.
    fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError>;
    /// End the session. Backends emit `Closed(CloseReason::Closed)` when done.
    fn close(&self);
}

/// Clamp a terminal size to sane bounds (xterm.js may briefly report 0 while hidden).
pub fn clamp_size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(2, 1000), rows.clamp(1, 500))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_errors_are_unexpected() {
        assert!(CloseReason::Error {
            message: "x".into()
        }
        .is_unexpected());
        assert!(!CloseReason::Closed.is_unexpected());
        assert!(!CloseReason::Exited { code: Some(1) }.is_unexpected());
    }

    #[test]
    fn close_reason_serializes_tagged() {
        let json = serde_json::to_value(CloseReason::Exited { code: Some(0) }).expect("json");
        assert_eq!(json["kind"], "exited");
        assert_eq!(json["code"], 0);
    }

    #[test]
    fn clamps_degenerate_sizes() {
        assert_eq!(clamp_size(0, 0), (2, 1));
        assert_eq!(clamp_size(80, 24), (80, 24));
        assert_eq!(clamp_size(5000, 5000), (1000, 500));
    }
}
