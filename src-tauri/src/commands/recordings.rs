//! Session recording commands: list, replay, export and delete.

use crate::commands::session::require_unlocked;
use crate::error::CommandResult;
use crate::state::AppState;
use cairn_core::audit::AuditEvent;
use cairn_core::recording::{self, RecordingInfo};
use cairn_core::CoreError;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub fn recordings_list(state: State<'_, AppState>) -> CommandResult<Vec<RecordingInfo>> {
    Ok(state.vault.lock().with_conn(recording::list)?)
}

/// The recording as an asciicast v2 file, for the replay player.
#[tauri::command]
pub fn recording_cast(state: State<'_, AppState>, id: i64) -> CommandResult<String> {
    Ok(state.vault.lock().with_conn(|c| recording::cast(c, id))?)
}

/// Whether a session is being recorded (for the tab's indicator).
#[tauri::command]
pub fn session_recording(state: State<'_, AppState>, session_id: String) -> bool {
    state.recorders.is_recording(&session_id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordingFormat {
    /// asciicast v2, playable with asciinema.
    Cast,
    /// Plain-text transcript.
    Text,
}

/// Write a recording to `path`. Audited as an export.
#[tauri::command]
pub async fn recording_export(
    state: State<'_, AppState>,
    id: i64,
    format: RecordingFormat,
    path: String,
) -> CommandResult<()> {
    require_unlocked(&state)?;
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(CoreError::Validation("Choose where to save the file.".into()).into());
    }
    let (info, content) = state.vault.lock().with_conn(|c| {
        let info = recording::get(c, id)?
            .ok_or_else(|| CoreError::Validation("That recording no longer exists.".into()))?;
        let content = match format {
            RecordingFormat::Cast => recording::cast(c, id)?,
            RecordingFormat::Text => recording::transcript(c, id)?,
        };
        Ok((info, content))
    })?;
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| CoreError::io(&path, e))?;
    state.audit.record(
        &state.vault,
        AuditEvent::DataExported {
            what: format!("recording of {} ({})", info.title(), info.started_at),
            format: match format {
                RecordingFormat::Cast => "asciicast".into(),
                RecordingFormat::Text => "text".into(),
            },
            path: path.display().to_string(),
        },
    );
    Ok(())
}

#[tauri::command]
pub fn recording_delete(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    Ok(state.vault.lock().with_conn(|c| {
        // The recording and its audit entry go together.
        let tx = c.unchecked_transaction()?;
        let info = recording::delete(&tx, id)?;
        cairn_core::audit::append(
            &tx,
            &AuditEvent::RecordingDeleted {
                recording_id: info.id,
                session_id: info.session_id,
                protocol: info.protocol,
                target: info.target,
                device: (!info.device.is_empty()).then_some(info.device),
                started_at: info.started_at,
            },
        )?;
        tx.commit()?;
        Ok(())
    })?)
}
