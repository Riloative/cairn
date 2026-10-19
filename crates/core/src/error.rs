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

/// Errors from the core crate (vault, database, audit, settings).
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("The master password is incorrect.")]
    WrongPassword,
    #[error("Cairn has not been set up yet.")]
    NotInitialized,
    #[error("Cairn is already set up.")]
    AlreadyInitialized,
    #[error("Cairn is locked.")]
    Locked,
    #[error("The vault metadata file is damaged: {0}")]
    CorruptVaultFile(String),
    #[error("A cryptographic operation failed: {0}")]
    Crypto(String),
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("Could not access {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("Data could not be encoded or decoded: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Validation(String),
    #[error("The database was created by a newer version of Cairn (schema {found}, this build supports {supported}).")]
    SchemaTooNew { found: i64, supported: i64 },
}

impl CoreError {
    pub fn io(path: &std::path::Path, source: std::io::Error) -> Self {
        Self::Io {
            path: path.display().to_string(),
            source,
        }
    }
}

impl UserFacingError for CoreError {
    fn code(&self) -> &'static str {
        match self {
            CoreError::WrongPassword => "vault.wrong_password",
            CoreError::NotInitialized => "vault.not_initialized",
            CoreError::AlreadyInitialized => "vault.already_initialized",
            CoreError::Locked => "vault.locked",
            CoreError::CorruptVaultFile(_) => "vault.corrupt",
            CoreError::Crypto(_) => "crypto",
            CoreError::Database(_) => "db",
            CoreError::Io { .. } => "io",
            CoreError::Json(_) => "json",
            CoreError::Validation(_) => "validation",
            CoreError::SchemaTooNew { .. } => "db.schema_too_new",
        }
    }

    fn hint(&self) -> Option<String> {
        match self {
            CoreError::WrongPassword => Some(
                "Check Caps Lock and keyboard layout. A lost master password cannot be recovered; restore from a backup instead.".into(),
            ),
            CoreError::Locked => Some("Unlock Cairn with your master password.".into()),
            CoreError::SchemaTooNew { .. } => Some("Update Cairn to the latest version.".into()),
            CoreError::Io { .. } => Some("Check that the folder exists and that you have permission to write to it.".into()),
            _ => None,
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
    fn core_errors_have_codes_and_hints() {
        let p = ErrorPayload::from_error(&CoreError::WrongPassword);
        assert_eq!(p.code, "vault.wrong_password");
        assert!(p.hint.is_some());
    }

    #[test]
    fn payload_serializes_to_camel_free_json() {
        let p = ErrorPayload::from_error(&Denied("x".into()));
        let json = serde_json::to_value(&p).expect("serializable");
        assert_eq!(json["code"], "test.denied");
        assert!(json.get("hint").is_some());
    }
}
