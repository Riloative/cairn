//! Mapping typed errors to messages a user can act on.

/// An error that can be explained to the user.
///
/// Every crate defines its own `thiserror` error type and implements this trait so the
/// Tauri layer can show a human-readable, actionable message instead of a debug string.
pub trait UserFacingError: std::error::Error {
    /// Short, stable machine code (e.g. `serial.permission_denied`) for the frontend to
    /// branch on.
    fn code(&self) -> &'static str;

    /// Human-readable message explaining what happened.
    fn user_message(&self) -> String {
        self.to_string()
    }

    /// Optional concrete next step, e.g. the shell command that fixes a permission problem.
    fn hint(&self) -> Option<String> {
        None
    }
}

/// Serializable form of a [`UserFacingError`], as sent across IPC.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ErrorPayload {
    pub code: &'static str,
    pub message: String,
    pub hint: Option<String>,
}

impl ErrorPayload {
    pub fn from_error<E: UserFacingError + ?Sized>(err: &E) -> Self {
        Self {
            code: err.code(),
            message: err.user_message(),
            hint: err.hint(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, thiserror::Error)]
    #[error("Permission denied on {0}")]
    struct Denied(String);

    impl UserFacingError for Denied {
        fn code(&self) -> &'static str {
            "test.denied"
        }
        fn hint(&self) -> Option<String> {
            Some("sudo usermod -aG dialout $USER".into())
        }
    }

    #[test]
    fn payload_carries_code_message_and_hint() {
        let p = ErrorPayload::from_error(&Denied("/dev/ttyUSB0".into()));
        assert_eq!(p.code, "test.denied");
        assert_eq!(p.message, "Permission denied on /dev/ttyUSB0");
        assert_eq!(p.hint.as_deref(), Some("sudo usermod -aG dialout $USER"));
    }

    #[test]
    fn payload_serializes_to_camel_free_json() {
        let p = ErrorPayload::from_error(&Denied("x".into()));
        let json = serde_json::to_value(&p).expect("serializable");
        assert_eq!(json["code"], "test.denied");
        assert!(json.get("hint").is_some());
    }
}
