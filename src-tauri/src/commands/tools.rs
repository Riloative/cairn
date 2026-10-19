//! Snippets and broadcast bookkeeping (the input itself goes through `session_write`).

use super::session::require_unlocked;
use crate::error::CommandResult;
use crate::state::AppState;
use cairn_core::audit::AuditEvent;
use cairn_core::tools::snippets::{self, Snippet};
use cairn_core::CoreError;
use rusqlite::Connection;
use tauri::State;

fn with<T>(
    state: &AppState,
    f: impl FnOnce(&Connection) -> Result<T, CoreError>,
) -> CommandResult<T> {
    Ok(state.vault.lock().with_conn(f)?)
}

#[tauri::command]
pub fn snippets_list(state: State<'_, AppState>) -> CommandResult<Vec<Snippet>> {
    with(&state, snippets::list)
}

#[tauri::command]
pub fn snippet_save(state: State<'_, AppState>, snippet: Snippet) -> CommandResult<Snippet> {
    with(&state, |c| snippets::save(c, &snippet))
}

#[tauri::command]
pub fn snippet_delete(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    with(&state, |c| snippets::delete(c, id))
}

fn targets(list: Vec<String>) -> CommandResult<Vec<String>> {
    if list.is_empty() || list.len() > 256 || list.iter().any(|t| t.len() > 300) {
        return Err(
            CoreError::Validation("Choose up to 256 sessions to broadcast to.".into()).into(),
        );
    }
    Ok(list)
}

/// Record that broadcast input was turned on for these sessions (labels, not input).
#[tauri::command]
pub fn broadcast_started(state: State<'_, AppState>, targets: Vec<String>) -> CommandResult<()> {
    require_unlocked(&state)?;
    let targets = self::targets(targets)?;
    state
        .audit
        .record(&state.vault, AuditEvent::BroadcastStarted { targets });
    Ok(())
}

#[tauri::command]
pub fn broadcast_ended(
    state: State<'_, AppState>,
    targets: Vec<String>,
    duration_secs: u64,
) -> CommandResult<()> {
    let targets = self::targets(targets)?;
    state.audit.record(
        &state.vault,
        AuditEvent::BroadcastEnded {
            targets,
            duration_secs,
        },
    );
    Ok(())
}
