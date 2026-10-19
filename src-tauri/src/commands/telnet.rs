//! Telnet and raw TCP sessions, including reverse Telnet to console servers.

use super::session::{audited_output, require_unlocked};
use crate::error::{CommandError, CommandResult};
use crate::sessions::{autologin, DeviceRef, Extra, SessionId, SessionManager, SessionMessage};
use crate::state::AppState;
use cairn_core::audit::AuditEvent;
use cairn_core::login::LoginPlan;
use cairn_core::terminal::TerminalSession;
use cairn_proto_telnet::console::ConsoleServerKind;
use cairn_proto_telnet::{TelnetOptions, TelnetSession};
use serde::Deserialize;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

/// A physical console-server port, mapped to a TCP port by the server's convention.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsolePort {
    pub kind: ConsoleServerKind,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelnetRequest {
    pub host: String,
    /// TCP port; ignored when `console` is set.
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub raw: bool,
    #[serde(default)]
    pub console: Option<ConsolePort>,
    #[serde(default = "default_timeout")]
    pub connect_timeout_secs: u32,
}

fn default_port() -> u16 {
    23
}

fn default_timeout() -> u32 {
    10
}

fn bad<T>(m: &str) -> CommandResult<T> {
    Err(cairn_core::CoreError::Validation(m.into()).into())
}

/// Validate and resolve the console-server mapping.
pub(crate) fn resolve(req: &TelnetRequest) -> CommandResult<TelnetOptions> {
    let host = req.host.trim();
    if host.is_empty() || host.len() > 253 || host.chars().any(char::is_whitespace) {
        return bad("Enter a valid hostname or IP address.");
    }
    let port = match req.console {
        Some(c) => match c.kind.tcp_port(c.port) {
            Some(p) => p,
            None => return bad("That console port number is out of range."),
        },
        None => req.port,
    };
    if port == 0 {
        return bad("The port must be between 1 and 65535.");
    }
    if req.connect_timeout_secs == 0 || req.connect_timeout_secs > 300 {
        return bad("The connect timeout must be between 1 and 300 seconds.");
    }
    Ok(TelnetOptions {
        host: host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned(),
        port,
        raw: req.raw,
        connect_timeout_secs: req.connect_timeout_secs,
    })
}

/// Open a Telnet (or raw TCP) session. `connected` arrives on `on_event` once the
/// TCP connection is up.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn telnet_open(
    state: State<'_, AppState>,
    sessions: State<'_, Arc<SessionManager>>,
    request: TelnetRequest,
    credential_id: Option<i64>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionMessage>,
) -> CommandResult<SessionId> {
    require_unlocked(&state)?;
    let opts = resolve(&request)?;
    let login = match super::saved::credential(&state, credential_id)? {
        Some((profile, secrets)) => super::devices::full_login(Some(&profile), &secrets),
        None => LoginPlan::default(),
    };
    start(
        &state, &sessions, opts, None, login, cols, rows, on_data, on_event,
    )
}

/// Start a Telnet session (also used for inventory devices).
#[allow(clippy::too_many_arguments)]
pub(crate) fn start(
    state: &AppState,
    sessions: &Arc<SessionManager>,
    opts: TelnetOptions,
    device: Option<DeviceRef>,
    login: LoginPlan,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionMessage>,
) -> CommandResult<SessionId> {
    let protocol = if opts.raw { "raw" } else { "telnet" };
    let target = opts.target();
    let id = sessions.allocate_id();
    let output = audited_output(
        state,
        &id,
        protocol,
        &target,
        device.as_ref(),
        (cols, rows),
        on_data,
        on_event,
    );
    let device = device.map(|d| d.hostname);
    let output = autologin::wrap(output, login, sessions, &id);
    let (vault, audit) = (state.vault.clone(), state.audit.clone());
    let (out, sid, tgt) = (output.clone(), id.clone(), target.clone());
    let on_connected = Box::new(move || {
        audit.record(
            &vault,
            AuditEvent::SessionStarted {
                session_id: sid,
                protocol: protocol.into(),
                target: tgt,
                username: None,
                device,
                host_key_fingerprint: None,
            },
        );
        out.message(SessionMessage::Connected);
    });
    let runtime = tokio::runtime::Handle::current();
    let mut control = None;
    let id = sessions.open_with_id::<CommandError>(id, output, |sink| {
        let s = Arc::new(TelnetSession::start(
            &runtime,
            opts,
            cols,
            rows,
            sink,
            on_connected,
        ));
        control = Some(s.clone());
        Ok(s as Arc<dyn TerminalSession>)
    })?;
    if let Some(s) = control {
        sessions.set_extra(&id, Extra::Telnet(s));
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(host: &str, port: u16, console: Option<ConsolePort>) -> TelnetRequest {
        TelnetRequest {
            host: host.into(),
            port,
            raw: false,
            console,
            connect_timeout_secs: 10,
        }
    }

    #[test]
    fn maps_console_ports_and_validates() {
        let og = Some(ConsolePort {
            kind: ConsoleServerKind::Opengear,
            port: 7,
        });
        assert_eq!(resolve(&req("cs1", 23, og)).expect("ok").port, 2007);
        assert_eq!(
            resolve(&req("[fe80::1]", 23, None)).expect("ok").host,
            "fe80::1"
        );
        assert!(resolve(&req("", 23, None)).is_err());
        assert!(resolve(&req("a b", 23, None)).is_err());
        assert!(resolve(&req("h", 0, None)).is_err());
        let bad_port = Some(ConsolePort {
            kind: ConsoleServerKind::Avocent,
            port: 0,
        });
        assert!(resolve(&req("h", 23, bad_port)).is_err());
    }
}
