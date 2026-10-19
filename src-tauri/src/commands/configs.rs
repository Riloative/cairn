//! Grab config over a device's open SSH session, snapshot history, diffs and export.

use super::session::require_unlocked;
use crate::error::CommandResult;
use crate::state::AppState;
use cairn_core::audit::AuditEvent;
use cairn_core::inventory::{credentials, devices};
use cairn_core::tools::configdiff::{self, ConfigDiff};
use cairn_core::tools::grab;
use cairn_core::tools::snapshots::{self, Snapshot, SnapshotInfo};
use cairn_core::CoreError;
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabResult {
    pub snapshot: SnapshotInfo,
    /// False when identical to the previous snapshot.
    pub changed: bool,
}

/// Run the vendor's "show configuration" on a second channel of the device's SSH
/// session and store the result as a snapshot.
#[tauri::command]
pub async fn config_grab(
    state: State<'_, AppState>,
    device_id: i64,
    session_id: String,
) -> CommandResult<GrabResult> {
    require_unlocked(&state)?;
    let (device, enable) = state.vault.lock().with_conn(|c| {
        let d = devices::get(c, device_id)?
            .ok_or_else(|| CoreError::Validation("This device no longer exists.".into()))?;
        // Grab needs privileged mode whether or not the profile enters it on connect.
        let enable = match d.credential_id {
            Some(id) => credentials::secrets(c, id)?.enable_secret,
            None => None,
        };
        Ok((d, enable))
    })?;
    let plan = grab::plan(&device.vendor);
    let command = plan.command.clone();
    let audit = |bytes: u64, changed: bool, error: Option<String>| {
        state.audit.record(
            &state.vault,
            AuditEvent::ConfigGrabbed {
                device_id,
                device: device.hostname.clone(),
                command: command.clone(),
                bytes,
                changed,
                ok: error.is_none(),
                error,
            },
        );
    };
    let conn = state.ssh_connection(&session_id)?;
    let config = match cairn_proto_ssh::grab::grab(&conn, plan, enable).await {
        Ok(c) => c,
        Err(e) => {
            audit(0, false, Some(e.to_string()));
            return Err(e.into());
        }
    };
    let saved = state
        .vault
        .lock()
        .with_conn(|c| snapshots::save(c, device_id, &command, &config));
    match saved {
        Ok((snapshot, changed)) => {
            audit(config.len() as u64, changed, None);
            Ok(GrabResult { snapshot, changed })
        }
        Err(e) => {
            audit(config.len() as u64, false, Some(e.to_string()));
            Err(e.into())
        }
    }
}

#[tauri::command]
pub fn config_snapshots(
    state: State<'_, AppState>,
    device_id: i64,
) -> CommandResult<Vec<SnapshotInfo>> {
    Ok(state
        .vault
        .lock()
        .with_conn(|c| snapshots::list(c, device_id))?)
}

fn get(state: &AppState, id: i64) -> CommandResult<Snapshot> {
    Ok(state.vault.lock().with_conn(|c| {
        snapshots::get(c, id)?
            .ok_or_else(|| CoreError::Validation("This snapshot no longer exists.".into()))
    })?)
}

#[tauri::command]
pub fn config_snapshot(state: State<'_, AppState>, id: i64) -> CommandResult<Snapshot> {
    get(&state, id)
}

#[tauri::command]
pub fn config_snapshot_note(
    state: State<'_, AppState>,
    id: i64,
    note: String,
) -> CommandResult<()> {
    Ok(state
        .vault
        .lock()
        .with_conn(|c| snapshots::set_note(c, id, &note))?)
}

#[tauri::command]
pub fn config_snapshot_delete(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    Ok(state.vault.lock().with_conn(|c| snapshots::delete(c, id))?)
}

/// Side-by-side diff of two snapshots (older first).
#[tauri::command]
pub fn config_diff(
    state: State<'_, AppState>,
    old_id: i64,
    new_id: i64,
) -> CommandResult<ConfigDiff> {
    let (a, b) = (get(&state, old_id)?, get(&state, new_id)?);
    Ok(configdiff::side_by_side(&a.content, &b.content))
}

/// Write a snapshot (or, with `against`, a unified diff from that older snapshot) to
/// `path`. Audited as an export.
#[tauri::command]
pub async fn config_export(
    state: State<'_, AppState>,
    id: i64,
    against: Option<i64>,
    path: String,
) -> CommandResult<String> {
    require_unlocked(&state)?;
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(CoreError::Validation("Choose where to save the file.".into()).into());
    }
    let snap = get(&state, id)?;
    let host = state
        .vault
        .lock()
        .with_conn(|c| devices::get(c, snap.info.device_id))?
        .map(|d| d.hostname)
        .unwrap_or_default();
    let (content, format) = match against {
        Some(old) => {
            let old = get(&state, old)?;
            (
                configdiff::unified(
                    &old.content,
                    &snap.content,
                    &format!("{host} {}", old.info.taken_at),
                    &format!("{host} {}", snap.info.taken_at),
                ),
                "diff",
            )
        }
        None => (snap.content, "text"),
    };
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| CoreError::io(&path, e))?;
    let shown = path.display().to_string();
    state.audit.record(
        &state.vault,
        AuditEvent::DataExported {
            what: format!("configuration of {host}"),
            format: format.into(),
            path: shown.clone(),
        },
    );
    Ok(shown)
}
