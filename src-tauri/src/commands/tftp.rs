//! The built-in TFTP server: start/stop with the saved preferences, a live transfer
//! log (kept here and pushed to the UI as `tftp://transfer` events), audit entries.

use super::session::require_unlocked;
use crate::audit_queue::AuditQueue;
use crate::error::CommandResult;
use crate::state::AppState;
use cairn_core::audit::AuditEvent;
use cairn_core::tools::tftp::{self, TftpPrefs};
use cairn_core::Vault;
use cairn_tftp::{Direction, ServerConfig, ServerEvent, TftpServer};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::VecDeque;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Runtime, State};

pub const TRANSFER_EVENT: &str = "tftp://transfer";
/// Transfers kept in the log.
const LOG_LEN: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// 0 for refused requests (no transfer started).
    pub id: u64,
    pub at: String,
    pub peer: String,
    pub file: String,
    pub direction: Direction,
    pub size: Option<u64>,
    pub bytes: u64,
    /// "running", "done", "failed" or "refused".
    pub state: &'static str,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TftpStatus {
    pub running: bool,
    /// The address actually bound (with the port when 0 was asked for).
    pub address: Option<String>,
    pub prefs: TftpPrefs,
    pub log: Vec<LogEntry>,
}

/// The running server and its log.
#[derive(Debug, Default)]
pub struct TftpService {
    server: Mutex<Option<(TftpServer, TftpPrefs)>>,
    log: Arc<Mutex<VecDeque<LogEntry>>>,
}

impl TftpService {
    fn status(&self, prefs: TftpPrefs) -> TftpStatus {
        let server = self.server.lock();
        TftpStatus {
            running: server.is_some(),
            address: server.as_ref().map(|(s, _)| s.local_addr().to_string()),
            prefs: server.as_ref().map_or(prefs, |(_, p)| p.clone()),
            log: self.log.lock().iter().cloned().collect(),
        }
    }

    /// Stop the server (also on app exit and vault lock).
    pub fn stop(&self, vault: &Mutex<Vault>, audit: &AuditQueue) {
        if let Some((server, prefs)) = self.server.lock().take() {
            server.stop();
            audit.record(vault, server_event("stopped", &prefs));
        }
    }
}

fn server_event(action: &str, prefs: &TftpPrefs) -> AuditEvent {
    AuditEvent::TftpServer {
        action: action.into(),
        bind: prefs.bind_addr().map(|a| a.to_string()).unwrap_or_default(),
        root: prefs.root.clone(),
        allow_write: prefs.allow_write,
    }
}

/// "upload" when the file goes to the device (it reads from us), like serial transfers.
fn audit_direction(d: Direction) -> &'static str {
    match d {
        Direction::Read => "upload",
        Direction::Write => "download",
    }
}

fn apply<R: Runtime>(
    app: &AppHandle<R>,
    log: &Mutex<VecDeque<LogEntry>>,
    vault: &Arc<Mutex<Vault>>,
    audit: &AuditQueue,
    event: ServerEvent,
) {
    let mut log = log.lock();
    let entry = match event {
        ServerEvent::Started {
            id,
            peer,
            file,
            direction,
            size,
        } => {
            log.push_front(LogEntry {
                id,
                at: cairn_core::audit::now(),
                peer,
                file,
                direction,
                size,
                bytes: 0,
                state: "running",
                error: None,
            });
            log.front().cloned()
        }
        ServerEvent::Progress { id, bytes } => log.iter_mut().find(|e| e.id == id).map(|e| {
            e.bytes = bytes;
            e.clone()
        }),
        ServerEvent::Finished {
            id,
            bytes,
            ok,
            error,
        } => log.iter_mut().find(|e| e.id == id).map(|e| {
            e.bytes = bytes;
            e.state = if ok { "done" } else { "failed" };
            e.error = error;
            audit.record(
                vault,
                AuditEvent::FileTransferred {
                    session_id: format!("tftp {}", e.peer),
                    protocol: "tftp".into(),
                    direction: audit_direction(e.direction).into(),
                    file: e.file.clone(),
                    bytes,
                    ok,
                    error: e.error.clone(),
                },
            );
            e.clone()
        }),
        ServerEvent::Refused {
            peer,
            file,
            direction,
            reason,
        } => {
            log.push_front(LogEntry {
                id: 0,
                at: cairn_core::audit::now(),
                peer,
                file,
                direction,
                size: None,
                bytes: 0,
                state: "refused",
                error: Some(reason),
            });
            log.front().cloned()
        }
    };
    log.truncate(LOG_LEN);
    drop(log);
    if let Some(entry) = entry {
        let _ = app.emit(TRANSFER_EVENT, entry);
    }
}

fn prefs(state: &AppState) -> CommandResult<TftpPrefs> {
    Ok(state.vault.lock().with_conn(tftp::prefs)?)
}

#[tauri::command]
pub fn tftp_status(
    state: State<'_, AppState>,
    service: State<'_, TftpService>,
) -> CommandResult<TftpStatus> {
    Ok(service.status(prefs(&state)?))
}

#[tauri::command]
pub fn tftp_prefs_update(state: State<'_, AppState>, prefs: TftpPrefs) -> CommandResult<TftpPrefs> {
    Ok(state
        .vault
        .lock()
        .with_conn(|c| tftp::save_prefs(c, &prefs))?)
}

/// Save the preferences and start serving.
#[tauri::command]
pub async fn tftp_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    service: State<'_, TftpService>,
    prefs: TftpPrefs,
) -> CommandResult<TftpStatus> {
    require_unlocked(&state)?;
    prefs.validate()?;
    let prefs = state
        .vault
        .lock()
        .with_conn(|c| tftp::save_prefs(c, &prefs))?;
    service.stop(&state.vault, &state.audit);
    let cfg = ServerConfig {
        root: PathBuf::from(&prefs.root),
        bind: prefs.bind_addr()?,
        allow_read: prefs.allow_read,
        allow_write: prefs.allow_write,
        overwrite: prefs.overwrite,
    };
    let (log, vault, audit) = (
        service.log.clone(),
        state.vault.clone(),
        state.audit.clone(),
    );
    let sink = Arc::new(move |e| apply(&app, &log, &vault, &audit, e));
    let server = TftpServer::start(cfg, sink).await?;
    state
        .audit
        .record(&state.vault, server_event("started", &prefs));
    *service.server.lock() = Some((server, prefs.clone()));
    Ok(service.status(prefs))
}

#[tauri::command]
pub fn tftp_stop(
    state: State<'_, AppState>,
    service: State<'_, TftpService>,
) -> CommandResult<TftpStatus> {
    service.stop(&state.vault, &state.audit);
    Ok(service.status(prefs(&state)?))
}

#[tauri::command]
pub fn tftp_clear_log(service: State<'_, TftpService>) {
    service.log.lock().retain(|e| e.state == "running");
}

/// A local address to offer for binding.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAddress {
    pub interface: String,
    pub address: String,
}

/// This computer's IP addresses (for choosing what the server listens on).
#[tauri::command]
pub fn local_addresses() -> Vec<LocalAddress> {
    let mut out: Vec<LocalAddress> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| match i.ip() {
            IpAddr::V4(_) => true,
            // Link-local IPv6 needs a scope id that devices rarely accept in commands.
            IpAddr::V6(v6) => !v6.is_unicast_link_local(),
        })
        .map(|i| LocalAddress {
            interface: i.name.clone(),
            address: i.ip().to_string(),
        })
        .collect();
    out.sort_by(|a, b| {
        let loop_a = a.address.starts_with("127.") || a.address == "::1";
        let loop_b = b.address.starts_with("127.") || b.address == "::1";
        loop_a.cmp(&loop_b).then(a.interface.cmp(&b.interface))
    });
    out
}
