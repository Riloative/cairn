//! Saved connections (named Quick Connect targets) and resolving their credential
//! profile in Rust, so stored secrets never pass through the frontend.

use super::session::require_unlocked;
use crate::error::CommandResult;
use crate::state::AppState;
use cairn_core::inventory::credentials::{self, CredentialProfile, Secrets};
use cairn_core::saved::{self, SavedConnection};
use cairn_core::CoreError;
use tauri::State;

#[tauri::command]
pub fn saved_connections_list(state: State<'_, AppState>) -> CommandResult<Vec<SavedConnection>> {
    require_unlocked(&state)?;
    Ok(state.vault.lock().with_conn(saved::list)?)
}

#[tauri::command]
pub fn saved_connection_save(
    state: State<'_, AppState>,
    connection: SavedConnection,
) -> CommandResult<SavedConnection> {
    require_unlocked(&state)?;
    Ok(state
        .vault
        .lock()
        .with_conn(|c| saved::save(c, &connection))?)
}

#[tauri::command]
pub fn saved_connection_delete(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    require_unlocked(&state)?;
    Ok(state.vault.lock().with_conn(|c| saved::delete(c, id))?)
}

/// Mark a saved connection as just used (the list shows recent ones first).
#[tauri::command]
pub fn saved_connection_used(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    require_unlocked(&state)?;
    Ok(state.vault.lock().with_conn(|c| saved::touch(c, id))?)
}

/// A credential profile and its secrets, for connections opened with `credential_id`.
pub(crate) fn credential(
    state: &AppState,
    id: Option<i64>,
) -> CommandResult<Option<(CredentialProfile, Secrets)>> {
    let Some(id) = id else { return Ok(None) };
    Ok(Some(state.vault.lock().with_conn(|c| {
        let profile = credentials::get(c, id)?.ok_or_else(|| {
            CoreError::Validation(
                "That credential profile no longer exists. Edit the saved connection and pick another.".into(),
            )
        })?;
        let secrets = credentials::secrets(c, id)?;
        Ok((profile, secrets))
    })?))
}
