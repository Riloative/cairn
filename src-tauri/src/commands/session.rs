//! Terminal session commands.

use crate::error::{CommandError, CommandResult};
use crate::sessions::{SessionId, SessionManager, SessionMessage, SessionOutput};
use crate::state::AppState;
use cairn_core::terminal::TerminalSession;
use cairn_core::VaultStatus;
use cairn_pty::{Container, LocalPty, ShellSpec};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::State;

/// Header carrying the session id on raw-body `session_write` calls.
pub const SESSION_HEADER: &str = "x-cairn-session";

struct ChannelOutput {
    data: Channel<InvokeResponseBody>,
    events: Channel<SessionMessage>,
}

impl SessionOutput for ChannelOutput {
    fn data(&self, bytes: Vec<u8>) {
        // The webview may already be gone (window closing); output is then irrelevant.
        let _ = self.data.send(InvokeResponseBody::Raw(bytes));
    }
    fn message(&self, msg: SessionMessage) {
        let _ = self.events.send(msg);
    }
}

fn require_unlocked(state: &AppState) -> CommandResult<()> {
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
    let output = Arc::new(ChannelOutput {
        data: on_data,
        events: on_event,
    });
    sessions.open(output, |sink| {
        LocalPty::spawn(&spec, cols, rows, sink)
            .map(|p| Arc::new(p) as Arc<dyn TerminalSession>)
            .map_err(CommandError::from)
    })
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
    sessions: State<'_, Arc<SessionManager>>,
    id: SessionId,
    cols: u16,
    rows: u16,
) -> CommandResult<()> {
    Ok(session(&sessions, &id)?.resize(cols, rows)?)
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
