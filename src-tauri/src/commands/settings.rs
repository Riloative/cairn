//! Settings commands.

use crate::error::CommandResult;
use crate::state::AppState;
use cairn_core::settings::{self, Settings};
use tauri::State;

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> CommandResult<Settings> {
    Ok(state.vault.lock().with_conn(settings::load)?)
}

#[tauri::command]
pub fn settings_update(state: State<'_, AppState>, settings: Settings) -> CommandResult<Settings> {
    Ok(state
        .vault
        .lock()
        .with_conn(|c| settings::save(c, &settings))?)
}
