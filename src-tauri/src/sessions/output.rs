//! Session outputs: Tauri channels, wrapped with session-end auditing.

use super::{SessionMessage, SessionOutput};
use crate::audit_queue::AuditQueue;
use cairn_core::audit::AuditEvent;
use cairn_core::terminal::CloseReason;
use cairn_core::Vault;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Instant;
use tauri::ipc::{Channel, InvokeResponseBody};

/// Output bytes as raw binary channel messages; lifecycle messages as JSON.
pub struct ChannelOutput {
    pub data: Channel<InvokeResponseBody>,
    pub events: Channel<SessionMessage>,
}

impl SessionOutput for ChannelOutput {
    fn data(&self, bytes: Vec<u8>) {
        // The webview may already be gone (window closing); output is then irrelevant.
        let _ = self.data.send(InvokeResponseBody::Raw(bytes));
    }
    fn message(&self, msg: SessionMessage) {
        let _ = self.events.send(msg);
    }
}

/// Adds a `session_ended` audit entry when the session closes.
pub struct AuditedOutput {
    pub inner: Arc<dyn SessionOutput>,
    pub vault: Arc<Mutex<Vault>>,
    pub audit: Arc<AuditQueue>,
    pub session_id: String,
    pub protocol: &'static str,
    pub target: String,
    pub started: Instant,
}

fn reason_label(reason: &CloseReason) -> String {
    match reason {
        CloseReason::Exited { code: Some(c) } => format!("exited ({c})"),
        CloseReason::Exited { code: None } => "exited".into(),
        CloseReason::Closed => "closed by user".into(),
        CloseReason::Error { message } => format!("error: {message}"),
    }
}

impl SessionOutput for AuditedOutput {
    fn data(&self, bytes: Vec<u8>) {
        self.inner.data(bytes);
    }

    fn message(&self, msg: SessionMessage) {
        if let SessionMessage::Closed { reason } = &msg {
            self.audit.record(
                &self.vault,
                AuditEvent::SessionEnded {
                    session_id: self.session_id.clone(),
                    protocol: self.protocol.into(),
                    target: self.target.clone(),
                    duration_secs: self.started.elapsed().as_secs(),
                    reason: reason_label(reason),
                },
            );
        }
        self.inner.message(msg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_close_reasons() {
        assert_eq!(
            reason_label(&CloseReason::Exited { code: Some(0) }),
            "exited (0)"
        );
        assert_eq!(reason_label(&CloseReason::Closed), "closed by user");
        assert!(reason_label(&CloseReason::Error {
            message: "x".into()
        })
        .starts_with("error"));
    }
}
