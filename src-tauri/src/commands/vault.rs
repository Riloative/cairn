//! Master password and lock commands.

use crate::error::{CommandError, CommandResult};
use crate::state::AppState;
use cairn_core::audit::LockReason;
use cairn_core::{SecretString, VaultStatus};
use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub status: VaultStatus,
    /// Failed unlock attempts since the last successful unlock.
    pub failed_attempts: usize,
    pub min_password_length: usize,
}

fn info(state: &AppState) -> CommandResult<VaultInfo> {
    let vault = state.vault.lock();
    Ok(VaultInfo {
        status: vault.status(),
        failed_attempts: vault.failed_attempts()?,
        min_password_length: cairn_core::vault::MIN_PASSWORD_LEN,
    })
}

/// Run CPU-heavy vault work (Argon2id) off the async runtime.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| CommandError::internal(format!("background task failed: {e}")))?
}

#[tauri::command]
pub fn vault_status(state: State<'_, AppState>) -> CommandResult<VaultInfo> {
    info(&state)
}

#[tauri::command]
pub async fn vault_setup(
    state: State<'_, AppState>,
    password: SecretString,
) -> CommandResult<VaultInfo> {
    let vault = state.vault.clone();
    blocking(move || Ok(vault.lock().setup(&password)?)).await?;
    state.touch();
    info(&state)
}

#[tauri::command]
pub async fn vault_unlock(
    state: State<'_, AppState>,
    password: SecretString,
) -> CommandResult<VaultInfo> {
    let vault = state.vault.clone();
    blocking(move || Ok(vault.lock().unlock(&password)?)).await?;
    state.touch();
    // Write audit events raised while locked (e.g. sessions that ended during auto-lock).
    state.audit.flush(&state.vault.lock());
    // ...and recordings that buffered output meanwhile.
    state.recorders.flush();
    info(&state)
}

#[tauri::command]
pub fn vault_lock(state: State<'_, AppState>) -> CommandResult<VaultInfo> {
    state.vault.lock().lock(LockReason::Manual)?;
    info(&state)
}

#[tauri::command]
pub async fn vault_change_password(
    state: State<'_, AppState>,
    current: SecretString,
    new: SecretString,
) -> CommandResult<()> {
    let vault = state.vault.clone();
    blocking(move || Ok(vault.lock().change_password(&current, &new)?)).await
}

/// Called (throttled) by the frontend on user input to reset the idle timer.
#[tauri::command]
pub fn activity_ping(state: State<'_, AppState>) {
    if state.vault.lock().status() == VaultStatus::Unlocked {
        state.touch();
    }
}
