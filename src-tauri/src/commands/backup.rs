//! Encrypted full backup and restore.

use crate::commands::rdp::RdpService;
use crate::commands::vault::{blocking, info, VaultInfo};
use crate::error::CommandResult;
use crate::sessions::SessionManager;
use crate::state::AppState;
use cairn_core::audit::AuditEvent;
use cairn_core::backup::{self, BackupSummary};
use cairn_core::kdf::KdfParams;
use cairn_core::{CoreError, SecretString, VaultStatus};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

fn absolute(path: String) -> CommandResult<PathBuf> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(CoreError::Validation("Choose a file.".into()).into())
    }
}

/// Write an encrypted backup of everything to `path`. Audited as an export.
#[tauri::command]
pub async fn backup_create(
    state: State<'_, AppState>,
    path: String,
    password: SecretString,
    recordings: bool,
) -> CommandResult<BackupSummary> {
    let path = absolute(path)?;
    let vault = state.vault.clone();
    let out = path.clone();
    let summary = blocking(move || {
        let v = vault.lock();
        // Same costs as the master password, with a fresh salt.
        let costs = v.kdf_params()?;
        let params = KdfParams::new(costs.m_cost_kib, costs.t_cost, costs.p_cost)?;
        Ok(v.with_conn(|c| {
            backup::export(
                c,
                v.dir(),
                &out,
                &password,
                params,
                recordings,
                env!("CARGO_PKG_VERSION"),
            )
        })?)
    })
    .await?;
    state.audit.record(
        &state.vault,
        AuditEvent::DataExported {
            what: if recordings {
                "full backup with recordings".into()
            } else {
                "full backup".into()
            },
            format: "cairn-backup".into(),
            path: path.display().to_string(),
        },
    );
    Ok(summary)
}

/// What a backup file holds (no password needed).
#[tauri::command]
pub fn backup_inspect(path: String) -> CommandResult<BackupSummary> {
    Ok(backup::summary(&absolute(path)?)?)
}

/// Replace all data with a backup. On first launch `master_password` becomes the
/// master password; when unlocked it must be the current one. The frontend reloads
/// afterwards.
#[tauri::command]
pub async fn backup_restore(
    state: State<'_, AppState>,
    sessions: State<'_, Arc<SessionManager>>,
    rdp: State<'_, RdpService>,
    path: String,
    backup_password: SecretString,
    master_password: SecretString,
) -> CommandResult<VaultInfo> {
    let path = absolute(path)?;
    if state.vault.lock().status() == VaultStatus::Locked {
        return Err(CoreError::Locked.into());
    }
    if !sessions.is_empty() || !rdp.is_empty() {
        return Err(
            CoreError::Validation("Close all sessions before restoring a backup.".into()).into(),
        );
    }
    let vault = state.vault.clone();
    blocking(move || {
        vault
            .lock()
            .restore(&path, &backup_password, &master_password)?;
        Ok(())
    })
    .await?;
    // Reconnect data cached from the old database must not outlive it.
    state.ssh_connections.lock().clear();
    state.touch();
    info(&state)
}
