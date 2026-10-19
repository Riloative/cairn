//! Terminal session commands.

use crate::error::{CommandError, CommandResult};
use crate::prompts::PromptAnswer;
use crate::sessions::log::{log_path, LoggingOutput};
use crate::sessions::output::{AuditedOutput, ChannelOutput};
use crate::sessions::record::RecordingOutput;
use crate::sessions::{DeviceRef, Extra, SessionId, SessionManager, SessionMessage, SessionOutput};
use crate::state::AppState;
use cairn_core::audit::AuditEvent;
use cairn_core::recording::NewRecording;
use cairn_core::terminal::TerminalSession;
use cairn_core::VaultStatus;
use cairn_pty::{Container, LocalPty, ShellSpec};
use std::sync::Arc;
use std::time::Instant;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::State;

/// Header carrying the session id on raw-body `session_write` calls.
pub const SESSION_HEADER: &str = "x-cairn-session";

/// Channel output wrapped with logging and recording (when turned on) and session-end
/// auditing.
#[allow(clippy::too_many_arguments)]
pub(crate) fn audited_output(
    state: &AppState,
    session_id: &str,
    protocol: &'static str,
    target: &str,
    device: Option<&DeviceRef>,
    (cols, rows): (u16, u16),
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionMessage>,
) -> Arc<dyn SessionOutput> {
    let channel: Arc<dyn SessionOutput> = Arc::new(ChannelOutput {
        data: on_data,
        events: on_event,
    });
    let settings = state
        .vault
        .lock()
        .with_conn(cairn_core::settings::load)
        .unwrap_or_default();
    let logging = settings.session_logging;
    let inner = match (logging, state.vault.lock().dir().to_path_buf()) {
        (true, dir) => {
            let path = log_path(&dir.join("logs"), protocol, target, session_id);
            match LoggingOutput::create(channel.clone(), &path) {
                Ok(l) => Arc::new(l) as Arc<dyn SessionOutput>,
                // Never block a session because its log cannot be written.
                Err(_) => channel,
            }
        }
        (false, _) => channel,
    };
    let record = settings.record_sessions || device.is_some_and(|d| d.record);
    let inner = match record {
        true => {
            let meta = NewRecording {
                session_id: session_id.to_owned(),
                protocol: protocol.to_owned(),
                target: target.to_owned(),
                device_id: device.map(|d| d.id),
                device: device.map(|d| d.hostname.clone()).unwrap_or_default(),
                cols,
                rows,
                started_at: cairn_core::audit::now(),
            };
            match state.recorders.start(&state.vault, &meta) {
                Some(recording) => Arc::new(RecordingOutput {
                    inner,
                    recording,
                    recorders: state.recorders.clone(),
                    session_id: session_id.to_owned(),
                }) as Arc<dyn SessionOutput>,
                // Never block a session because its recording cannot be created.
                None => inner,
            }
        }
        false => inner,
    };
    Arc::new(AuditedOutput {
        inner,
        vault: state.vault.clone(),
        audit: state.audit.clone(),
        session_id: session_id.to_owned(),
        protocol,
        target: target.to_owned(),
        started: Instant::now(),
    })
}

pub(crate) fn require_unlocked(state: &AppState) -> CommandResult<()> {
    if state.vault.lock().status() == VaultStatus::Unlocked {
        Ok(())
    } else {
        Err(cairn_core::CoreError::Locked.into())
    }
}

fn session(mgr: &SessionManager, id: &str) -> CommandResult<Arc<dyn TerminalSession>> {
    mgr.get(id)
        .ok_or_else(|| cairn_core::terminal::TerminalError::Closed.into())
}

/// Open a local shell. `spec` defaults to the user's login shell.
#[tauri::command]
pub fn session_open_local(
    state: State<'_, AppState>,
    sessions: State<'_, Arc<SessionManager>>,
    spec: Option<ShellSpec>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionMessage>,
) -> CommandResult<SessionId> {
    require_unlocked(&state)?;
    let spec = spec.unwrap_or_default();
    let program = spec
        .program
        .clone()
        .unwrap_or_else(cairn_pty::default_shell);
    let id = sessions.allocate_id();
    let output = audited_output(
        &state,
        &id,
        "local",
        &program,
        None,
        (cols, rows),
        on_data,
        on_event,
    );
    let id = sessions.open_with_id(id, output, |sink| {
        LocalPty::spawn(&spec, cols, rows, sink)
            .map(|p| Arc::new(p) as Arc<dyn TerminalSession>)
            .map_err(CommandError::from)
    })?;
    state.audit.record(
        &state.vault,
        AuditEvent::SessionStarted {
            session_id: id.clone(),
            protocol: "local".into(),
            target: program,
            username: None,
            device: None,
            host_key_fingerprint: None,
        },
    );
    Ok(id)
}

/// Answer a host-key or credential prompt raised by a connecting session.
#[tauri::command]
pub fn session_prompt_reply(state: State<'_, AppState>, prompt_id: u64, answer: PromptAnswer) {
    // An unknown id means the session already went away; nothing to do.
    state.prompts.answer(prompt_id, answer);
}

/// Send input. The body is the raw bytes; the session id is in [`SESSION_HEADER`].
#[tauri::command]
pub fn session_write(
    sessions: State<'_, Arc<SessionManager>>,
    request: Request<'_>,
) -> CommandResult<()> {
    let id = request
        .headers()
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| CommandError::internal("missing session header"))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::internal(
            "session_write expects a binary body",
        ));
    };
    Ok(session(&sessions, id)?.write(bytes)?)
}

#[tauri::command]
pub fn session_resize(
    state: State<'_, AppState>,
    sessions: State<'_, Arc<SessionManager>>,
    id: SessionId,
    cols: u16,
    rows: u16,
) -> CommandResult<()> {
    session(&sessions, &id)?.resize(cols, rows)?;
    state.recorders.resize(&id, cols, rows);
    Ok(())
}

/// Send BREAK on a serial or Telnet session.
#[tauri::command]
pub async fn session_break(
    sessions: State<'_, Arc<SessionManager>>,
    id: SessionId,
) -> CommandResult<()> {
    match sessions.extra(&id) {
        // Holds the line for `BREAK_DURATION`; keep it off the async runtime.
        Some(Extra::Serial(c)) => {
            tauri::async_runtime::spawn_blocking(move || c.session.send_break())
                .await
                .map_err(|e| CommandError::internal(format!("break failed: {e}")))??
        }
        Some(Extra::Telnet(t)) => t.send_break()?,
        None => {
            return Err(cairn_core::CoreError::Validation(
                "This session does not support BREAK.".into(),
            )
            .into())
        }
    }
    Ok(())
}

#[tauri::command]
pub fn session_close(sessions: State<'_, Arc<SessionManager>>, id: SessionId) {
    sessions.close(&id);
}

/// A detected container and the command that opens a shell in it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerLauncher {
    #[serde(flatten)]
    pub container: Container,
    pub spec: ShellSpec,
}

/// Podman / Toolbox / Distrobox containers for quick-launch (empty on macOS).
#[tauri::command]
pub async fn local_containers() -> CommandResult<Vec<ContainerLauncher>> {
    let found = tauri::async_runtime::spawn_blocking(cairn_pty::containers::detect)
        .await
        .map_err(|e| CommandError::internal(format!("container detection failed: {e}")))?;
    Ok(found
        .into_iter()
        .map(|c| ContainerLauncher {
            spec: c.shell_spec(),
            container: c,
        })
        .collect())
}

/// The shell used for new local terminals.
#[tauri::command]
pub fn local_default_shell() -> String {
    cairn_pty::default_shell()
}
