//! Terminal preference commands (profiles, imported palettes, prompt patterns).

use crate::error::CommandResult;
use crate::state::AppState;
use cairn_core::terminal_prefs::{self, TerminalPrefs};
use tauri::State;

#[tauri::command]
pub fn terminal_prefs_get(state: State<'_, AppState>) -> CommandResult<TerminalPrefs> {
    Ok(state.vault.lock().with_conn(terminal_prefs::load)?)
}

#[tauri::command]
pub fn terminal_prefs_update(
    state: State<'_, AppState>,
    prefs: TerminalPrefs,
) -> CommandResult<TerminalPrefs> {
    Ok(state
        .vault
        .lock()
        .with_conn(|c| terminal_prefs::save(c, &prefs))?)
}
