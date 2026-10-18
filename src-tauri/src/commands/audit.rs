//! Audit log commands.

use crate::error::CommandResult;
use crate::state::AppState;
use cairn_core::audit::{self, AuditEntry, AuditEvent, IntegrityReport};
use tauri::State;

const MAX_LIMIT: u32 = 1000;

#[tauri::command]
pub fn audit_recent(state: State<'_, AppState>, limit: u32) -> CommandResult<Vec<AuditEntry>> {
    Ok(state
        .vault
        .lock()
        .with_conn(|c| audit::recent(c, limit.min(MAX_LIMIT)))?)
}

/// Verify the hash chain and record the result in the log.
#[tauri::command]
pub fn audit_verify(state: State<'_, AppState>) -> CommandResult<IntegrityReport> {
    Ok(state.vault.lock().with_conn(|c| {
        let report = audit::verify(c)?;
        audit::append(
            c,
            &AuditEvent::IntegrityVerified {
                ok: report.ok,
                entries: report.entries,
            },
        )?;
        Ok(report)
    })?)
}
