//! IPC error type: every command returns `Result<T, CommandError>`, which serializes to
//! `{ code, message, hint }` (see `ErrorPayload` and `CommandError` in `ui/src/lib/ipc.ts`).

use cairn_core::{ErrorPayload, UserFacingError};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct CommandError(ErrorPayload);

impl CommandError {
    pub fn internal(message: impl Into<String>) -> Self {
        Self(ErrorPayload {
            code: "internal",
            message: message.into(),
            hint: Some("Please try again. If it keeps happening, restart Cairn.".into()),
        })
    }
}

impl<E: UserFacingError> From<E> for CommandError {
    fn from(err: E) -> Self {
        Self(ErrorPayload::from_error(&err))
    }
}

pub type CommandResult<T> = Result<T, CommandError>;

#[cfg(test)]
mod tests {
    use super::*;
    use cairn_core::CoreError;

    #[test]
    fn serializes_core_errors_as_flat_payloads() {
        let e: CommandError = CoreError::Locked.into();
        let json = serde_json::to_value(&e).expect("serialize");
        assert_eq!(json["code"], "vault.locked");
        assert_eq!(json["message"], "Cairn is locked.");
        assert!(json["hint"].is_string());
    }
}
