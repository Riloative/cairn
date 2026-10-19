//! Port forwards on open SSH sessions, and per-device presets.

use super::session::require_unlocked;
use crate::error::CommandResult;
use crate::state::AppState;
use cairn_core::audit::AuditEvent;
use cairn_core::tools::forwards::{self, ForwardPreset};
use cairn_core::tools::ForwardSpec;
use cairn_proto_ssh::forward::{self, Forward, ForwardCounters};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::State;

struct Active {
    session_id: String,
    target: String,
    preset_id: Option<i64>,
    forward: Arc<Forward>,
}

/// Forwards started in this run of the app.
#[derive(Default)]
pub struct ForwardService {
    next: AtomicU64,
    active: Mutex<BTreeMap<u64, Active>>,
}

impl std::fmt::Debug for ForwardService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForwardService").finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub id: u64,
    pub session_id: String,
    pub target: String,
    pub preset_id: Option<i64>,
    pub spec: ForwardSpec,
    pub summary: String,
    pub bound_port: u16,
    pub counters: ForwardCounters,
}

fn info(id: u64, a: &Active) -> ForwardInfo {
    let mut spec = a.forward.spec.clone();
    spec.bind_port = a.forward.bound_port;
    ForwardInfo {
        id,
        session_id: a.session_id.clone(),
        target: a.target.clone(),
        preset_id: a.preset_id,
        summary: spec.summary(),
        spec,
        bound_port: a.forward.bound_port,
        counters: a.forward.stats.snapshot(),
    }
}

fn audit(state: &AppState, a: &Active, action: &str, error: Option<String>) {
    let mut spec = a.forward.spec.clone();
    spec.bind_port = a.forward.bound_port;
    state.audit.record(
        &state.vault,
        AuditEvent::PortForward {
            session_id: a.session_id.clone(),
            target: a.target.clone(),
            forward: spec.summary(),
            action: action.into(),
            error,
        },
    );
}

async fn start_one(
    state: &AppState,
    service: &ForwardService,
    session_id: &str,
    spec: ForwardSpec,
    preset_id: Option<i64>,
) -> CommandResult<ForwardInfo> {
    let conn = state.ssh_connection(session_id)?;
    let target = conn.target.clone();
    match forward::start(conn, spec.clone()).await {
        Ok(f) => {
            let id = service.next.fetch_add(1, Ordering::Relaxed) + 1;
            let active = Active {
                session_id: session_id.to_owned(),
                target,
                preset_id,
                forward: Arc::new(f),
            };
            audit(state, &active, "started", None);
            let out = info(id, &active);
            service.active.lock().insert(id, active);
            Ok(out)
        }
        Err(e) => {
            state.audit.record(
                &state.vault,
                AuditEvent::PortForward {
                    session_id: session_id.to_owned(),
                    target,
                    forward: spec.summary(),
                    action: "failed".into(),
                    error: Some(e.to_string()),
                },
            );
            Err(e.into())
        }
    }
}

#[tauri::command]
pub async fn forward_start(
    state: State<'_, AppState>,
    service: State<'_, ForwardService>,
    session_id: String,
    spec: ForwardSpec,
) -> CommandResult<ForwardInfo> {
    require_unlocked(&state)?;
    start_one(&state, &service, &session_id, spec.clean()?, None).await
}

#[tauri::command]
pub async fn forward_stop(
    state: State<'_, AppState>,
    service: State<'_, ForwardService>,
    id: u64,
) -> CommandResult<()> {
    let active = service.active.lock().remove(&id);
    if let Some(a) = active {
        a.forward.stop().await;
        audit(&state, &a, "stopped", None);
    }
    Ok(())
}

/// Running forwards with live counters. Forwards whose session ended are dropped
/// (and audited as stopped).
#[tauri::command]
pub fn forwards_list(
    state: State<'_, AppState>,
    service: State<'_, ForwardService>,
) -> Vec<ForwardInfo> {
    let mut active = service.active.lock();
    let ended: Vec<u64> = active
        .iter()
        .filter(|(_, a)| a.forward.is_stopped() || state.ssh_connection(&a.session_id).is_err())
        .map(|(id, _)| *id)
        .collect();
    for id in ended {
        if let Some(a) = active.remove(&id) {
            audit(&state, &a, "stopped", Some("the session ended".into()));
        }
    }
    active.iter().map(|(id, a)| info(*id, a)).collect()
}

/// Start the device's auto-start presets on a freshly connected session.
#[tauri::command]
pub async fn forwards_autostart(
    state: State<'_, AppState>,
    service: State<'_, ForwardService>,
    session_id: String,
    device_id: i64,
) -> CommandResult<Vec<ForwardInfo>> {
    require_unlocked(&state)?;
    let presets = state
        .vault
        .lock()
        .with_conn(|c| forwards::for_device(c, device_id))?;
    let mut started = Vec::new();
    for p in presets.into_iter().filter(|p| p.auto_start) {
        let already = service
            .active
            .lock()
            .values()
            .any(|a| a.session_id == session_id && a.preset_id == Some(p.id));
        if !already {
            // One failing preset (port in use) must not block the others; it is audited.
            if let Ok(i) = start_one(&state, &service, &session_id, p.spec, Some(p.id)).await {
                started.push(i);
            }
        }
    }
    Ok(started)
}

#[tauri::command]
pub fn forward_presets_list(state: State<'_, AppState>) -> CommandResult<Vec<ForwardPreset>> {
    Ok(state.vault.lock().with_conn(forwards::list)?)
}

#[tauri::command]
pub fn forward_preset_save(
    state: State<'_, AppState>,
    preset: ForwardPreset,
) -> CommandResult<ForwardPreset> {
    Ok(state
        .vault
        .lock()
        .with_conn(|c| forwards::save(c, &preset))?)
}

#[tauri::command]
pub fn forward_preset_delete(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    Ok(state.vault.lock().with_conn(|c| forwards::delete(c, id))?)
}
