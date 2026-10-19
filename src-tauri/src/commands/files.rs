//! File operations on SSH sessions: the SFTP panel (browse and manage) and transfers
//! over SFTP or SCP, with progress, cancellation and audit entries.

use super::session::require_unlocked;
use crate::error::CommandResult;
use crate::state::AppState;
use cairn_core::audit::AuditEvent;
use cairn_core::CoreError;
use cairn_proto_ssh::sftp::{RemoteEntry, Sftp};
use cairn_proto_ssh::{scp, SshError};
use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::watch;

/// SFTP sessions per SSH session, and running transfers.
#[derive(Default)]
pub struct FileService {
    sftp: Mutex<HashMap<String, Arc<Sftp>>>,
    transfers: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl std::fmt::Debug for FileService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileService").finish_non_exhaustive()
    }
}

impl FileService {
    /// The session's SFTP client, opened on first use (and again after a reconnect).
    async fn sftp(&self, state: &AppState, session_id: &str) -> Result<Arc<Sftp>, SshError> {
        let conn = match state.ssh_connection(session_id) {
            Ok(c) => c,
            Err(e) => {
                self.sftp.lock().remove(session_id);
                return Err(e);
            }
        };
        if let Some(s) = self.sftp.lock().get(session_id) {
            return Ok(s.clone());
        }
        let sftp = Arc::new(Sftp::open(&conn).await?);
        self.sftp.lock().insert(session_id.to_owned(), sftp.clone());
        Ok(sftp)
    }

    /// Forget a broken SFTP client so the next call opens a fresh one.
    fn drop_on_error<T>(&self, session_id: &str, r: Result<T, SshError>) -> Result<T, SshError> {
        if matches!(r, Err(SshError::Sftp(ref m)) if m.contains("closed") || m.contains("Timeout"))
        {
            self.sftp.lock().remove(session_id);
        }
        r
    }
}

fn check_path(path: &str) -> CommandResult<()> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return Err(CoreError::Validation("That path is not valid.".into()).into());
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_home(
    state: State<'_, AppState>,
    files: State<'_, FileService>,
    session_id: String,
) -> CommandResult<String> {
    require_unlocked(&state)?;
    let s = files.sftp(&state, &session_id).await?;
    Ok(files.drop_on_error(&session_id, s.home().await)?)
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    files: State<'_, FileService>,
    session_id: String,
    path: String,
) -> CommandResult<Vec<RemoteEntry>> {
    require_unlocked(&state)?;
    check_path(&path)?;
    let s = files.sftp(&state, &session_id).await?;
    Ok(files.drop_on_error(&session_id, s.list(&path).await)?)
}

/// Rename, delete, mkdir or chmod.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum FileOp {
    Mkdir { path: String },
    Rename { from: String, to: String },
    Remove { path: String },
    Chmod { path: String, mode: u32 },
}

#[tauri::command]
pub async fn sftp_op(
    state: State<'_, AppState>,
    files: State<'_, FileService>,
    session_id: String,
    op: FileOp,
) -> CommandResult<()> {
    require_unlocked(&state)?;
    let s = files.sftp(&state, &session_id).await?;
    let r = match &op {
        FileOp::Mkdir { path } => {
            check_path(path)?;
            s.mkdir(path).await
        }
        FileOp::Rename { from, to } => {
            check_path(from)?;
            check_path(to)?;
            s.rename(from, to).await
        }
        FileOp::Remove { path } => {
            check_path(path)?;
            s.remove(path).await
        }
        FileOp::Chmod { path, mode } => {
            check_path(path)?;
            if *mode > 0o7777 {
                return Err(
                    CoreError::Validation("Use permissions like 644 or 755.".into()).into(),
                );
            }
            s.chmod(path, *mode).await
        }
    };
    Ok(files.drop_on_error(&session_id, r)?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferProtocol {
    Sftp,
    Scp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferDirection {
    /// Local → device.
    Upload,
    /// Device → local.
    Download,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    /// Chosen by the frontend (queue item id) for cancellation.
    pub id: String,
    pub protocol: TransferProtocol,
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
}

const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// Run one transfer to completion; progress (bytes so far) arrives on `on_progress`.
#[tauri::command]
pub async fn file_transfer(
    state: State<'_, AppState>,
    files: State<'_, FileService>,
    session_id: String,
    request: TransferRequest,
    on_progress: Channel<u64>,
) -> CommandResult<u64> {
    require_unlocked(&state)?;
    check_path(&request.remote_path)?;
    let local = PathBuf::from(&request.local_path);
    if !local.is_absolute() || request.id.is_empty() || request.id.len() > 64 {
        return Err(CoreError::Validation("That local path is not valid.".into()).into());
    }
    let (stop, cancel) = watch::channel(false);
    files.transfers.lock().insert(request.id.clone(), stop);

    let last = Mutex::new(Instant::now() - PROGRESS_EVERY);
    let progress = |bytes: u64| {
        let mut at = last.lock();
        if at.elapsed() >= PROGRESS_EVERY {
            *at = Instant::now();
            let _ = on_progress.send(bytes);
        }
    };
    let result = async {
        match request.protocol {
            TransferProtocol::Sftp => {
                let s = files.sftp(&state, &session_id).await?;
                match request.direction {
                    TransferDirection::Upload => {
                        s.upload(&local, &request.remote_path, progress, cancel)
                            .await
                    }
                    TransferDirection::Download => {
                        s.download(&request.remote_path, &local, progress, cancel)
                            .await
                    }
                }
            }
            TransferProtocol::Scp => {
                let conn = state.ssh_connection(&session_id)?;
                match request.direction {
                    TransferDirection::Upload => {
                        scp::upload(&conn, &local, &request.remote_path, progress, cancel).await
                    }
                    TransferDirection::Download => {
                        scp::download(&conn, &request.remote_path, &local, progress, cancel).await
                    }
                }
            }
        }
    }
    .await;
    files.transfers.lock().remove(&request.id);
    if let Ok(n) = &result {
        let _ = on_progress.send(*n);
    }
    let (bytes, error) = match &result {
        Ok(n) => (*n, None),
        Err(e) => (0, Some(e.to_string())),
    };
    state.audit.record(
        &state.vault,
        AuditEvent::FileTransferred {
            session_id: session_id.clone(),
            protocol: match request.protocol {
                TransferProtocol::Sftp => "sftp".into(),
                TransferProtocol::Scp => "scp".into(),
            },
            direction: match request.direction {
                TransferDirection::Upload => "upload".into(),
                TransferDirection::Download => "download".into(),
            },
            file: request.remote_path.clone(),
            bytes,
            ok: error.is_none(),
            error,
        },
    );
    Ok(result?)
}

#[tauri::command]
pub fn file_transfer_cancel(files: State<'_, FileService>, id: String) {
    if let Some(stop) = files.transfers.lock().get(&id) {
        let _ = stop.send(true);
    }
}
