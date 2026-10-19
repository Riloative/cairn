//! Audit log commands.

use crate::error::CommandResult;
use crate::state::AppState;
use cairn_core::audit::{
    self, AuditEvent, AuditFacets, AuditFilter, AuditPage, ExportFormat, IntegrityReport,
};
use cairn_core::CoreError;
use std::path::PathBuf;
use tauri::State;

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

/// Largest page the audit view asks for at once.
const MAX_PAGE: u32 = 500;

/// Filtered entries, newest first, older than `before_seq` (paging cursor).
#[tauri::command]
pub fn audit_query(
    state: State<'_, AppState>,
    filter: AuditFilter,
    before_seq: Option<i64>,
    limit: u32,
) -> CommandResult<AuditPage> {
    Ok(state
        .vault
        .lock()
        .with_conn(|c| audit::query(c, &filter, before_seq, limit.clamp(1, MAX_PAGE)))?)
}

/// Kinds, devices and protocols present in the log, for the filter menus.
#[tauri::command]
pub fn audit_facets(state: State<'_, AppState>) -> CommandResult<AuditFacets> {
    Ok(state.vault.lock().with_conn(audit::facets)?)
}

/// Write the entries matching `filter` to `path` as CSV or JSON; returns how many.
/// Audited as an export.
#[tauri::command]
pub async fn audit_export(
    state: State<'_, AppState>,
    filter: AuditFilter,
    format: ExportFormat,
    path: String,
) -> CommandResult<u64> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(CoreError::Validation("Choose where to save the file.".into()).into());
    }
    let mut buf = Vec::new();
    let count = state
        .vault
        .lock()
        .with_conn(|c| audit::export(c, &filter, format, &mut buf))?;
    tokio::fs::write(&path, buf)
        .await
        .map_err(|e| CoreError::io(&path, e))?;
    state.audit.record(
        &state.vault,
        AuditEvent::DataExported {
            what: format!("audit log ({count} entries)"),
            format: match format {
                ExportFormat::Csv => "csv".into(),
                ExportFormat::Json => "json".into(),
            },
            path: path.display().to_string(),
        },
    );
    Ok(count)
}
