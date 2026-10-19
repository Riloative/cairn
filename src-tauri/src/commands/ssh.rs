//! SSH session commands and Cairn's known-hosts list.

use super::session::{audited_output, require_unlocked};
use crate::error::{CommandError, CommandResult};
use crate::sessions::ssh::{SessionContext, TauriInteract};
use crate::sessions::{autologin, DeviceRef, SessionId, SessionManager, SessionMessage};
use crate::state::AppState;
use cairn_core::inventory::credentials::{CredentialProfile, Secrets};
use cairn_core::known_hosts::{self, KnownHost};
use cairn_core::login::LoginPlan;
use cairn_core::terminal::TerminalSession;
use cairn_proto_ssh::{AuthMethod, ConnectOptions, SshSession};
use serde::Serialize;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

/// What a (re)connect needs: options with credentials, kept in Rust only.
#[derive(Debug)]
pub struct SshTarget {
    pub opts: ConnectOptions,
    /// The inventory device, for audit entries and recording.
    pub device: Option<DeviceRef>,
    /// Enable-secret answering for devices with "auto-enter enable".
    pub login: LoginPlan,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOpened {
    pub session_id: SessionId,
    /// Handle for `ssh_reconnect` / `ssh_forget`; connection options stay in Rust.
    pub connection_id: String,
}

pub(crate) fn validate(opts: &ConnectOptions) -> CommandResult<()> {
    let bad = |m: &str| Err(cairn_core::CoreError::Validation(m.into()).into());
    if opts.hops.is_empty() {
        return bad("Enter a host to connect to.");
    }
    if opts.hops.len() > 8 {
        return bad("At most 8 jump hosts are supported.");
    }
    for hop in &opts.hops {
        if hop.host.trim().is_empty() || hop.host.len() > 253 {
            return bad("Enter a valid hostname or IP address.");
        }
        if hop.port == 0 {
            return bad("The port must be between 1 and 65535.");
        }
        if hop.username.trim().is_empty() || hop.username.len() > 255 {
            return bad("Enter a username.");
        }
        if hop.auth.is_empty() {
            return bad("Choose an authentication method.");
        }
    }
    if opts.keepalive_secs > 3600 || opts.connect_timeout_secs > 300 {
        return bad("Keepalive or timeout values are out of range.");
    }
    Ok(())
}

fn start(
    state: &AppState,
    sessions: &Arc<SessionManager>,
    target: Arc<SshTarget>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionMessage>,
) -> CommandResult<SessionId> {
    let opts = &target.opts;
    let last = opts
        .hops
        .last()
        .ok_or_else(|| CommandError::internal("no destination"))?;
    let target_label = last.target();
    let id = sessions.allocate_id();
    let output = audited_output(
        state,
        &id,
        "ssh",
        &target_label,
        target.device.as_ref(),
        (cols, rows),
        on_data,
        on_event,
    );
    let output = autologin::wrap(output, target.login.clone(), sessions, &id);
    let interact = Arc::new(TauriInteract {
        output: output.clone(),
        broker: state.prompts.clone(),
        vault: state.vault.clone(),
        audit: state.audit.clone(),
        ctx: SessionContext {
            session_id: id.clone(),
            target: target_label,
            username: last.username.clone(),
            device: target.device.as_ref().map(|d| d.hostname.clone()),
        },
    });
    let runtime = tokio::runtime::Handle::current();
    let registry = &state.ssh_sessions;
    let key = id.clone();
    sessions.open_with_id::<CommandError>(id, output, move |sink| {
        let session = Arc::new(SshSession::start(
            &runtime,
            target.opts.clone(),
            cols,
            rows,
            interact,
            sink,
        ));
        registry.lock().insert(key, Arc::downgrade(&session));
        Ok(session as Arc<dyn TerminalSession>)
    })
}

/// Start a session and remember its target for `ssh_reconnect`.
pub(crate) fn open(
    state: &AppState,
    sessions: &Arc<SessionManager>,
    target: SshTarget,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionMessage>,
) -> CommandResult<SshOpened> {
    validate(&target.opts)?;
    let target = Arc::new(target);
    let session_id = start(
        state,
        sessions,
        target.clone(),
        cols,
        rows,
        on_data,
        on_event,
    )?;
    let connection_id = format!("c-{session_id}");
    state
        .ssh_connections
        .lock()
        .insert(connection_id.clone(), target);
    Ok(SshOpened {
        session_id,
        connection_id,
    })
}

/// Use a credential profile for the destination (last hop): its username when the form
/// left it empty, its key and password before the form's own methods, and its enable
/// secret for the login.
fn with_profile(
    mut options: ConnectOptions,
    profile: &CredentialProfile,
    secrets: &Secrets,
) -> (ConnectOptions, LoginPlan) {
    if let Some(hop) = options.hops.last_mut() {
        if hop.username.trim().is_empty() {
            hop.username = profile.username.clone();
        }
        let mut auth = super::devices::ssh_auth(Some(profile), secrets);
        // The form's own choices (a key file, the agent) still follow; methods of a kind
        // the profile already tries are dropped, except key files (other keys).
        let tried: Vec<_> = auth.iter().map(std::mem::discriminant).collect();
        auth.extend(hop.auth.drain(..).filter(|m| {
            matches!(m, AuthMethod::KeyFile { .. }) || !tried.contains(&std::mem::discriminant(m))
        }));
        hop.auth = auth;
    }
    (options, super::devices::enable_only(Some(profile), secrets))
}

/// Open an SSH session. Progress, host-key and credential prompts arrive on `on_event`.
/// With `credential_id` (a saved connection's profile) the profile's username, key,
/// password and enable secret are used first, filled in here in Rust.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_open(
    state: State<'_, AppState>,
    sessions: State<'_, Arc<SessionManager>>,
    options: ConnectOptions,
    credential_id: Option<i64>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionMessage>,
) -> CommandResult<SshOpened> {
    require_unlocked(&state)?;
    let (options, login) = match super::saved::credential(&state, credential_id)? {
        Some((profile, secrets)) => with_profile(options, &profile, &secrets),
        None => (options, LoginPlan::default()),
    };
    let target = SshTarget {
        opts: options,
        device: None,
        login,
    };
    open(&state, &sessions, target, cols, rows, on_data, on_event)
}

/// Reconnect a dropped session with the same options (and stored credentials).
#[tauri::command]
pub async fn ssh_reconnect(
    state: State<'_, AppState>,
    sessions: State<'_, Arc<SessionManager>>,
    connection_id: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionMessage>,
) -> CommandResult<SessionId> {
    require_unlocked(&state)?;
    let target = state
        .ssh_connections
        .lock()
        .get(&connection_id)
        .cloned()
        .ok_or_else(|| CommandError::internal("this connection is no longer available"))?;
    start(&state, &sessions, target, cols, rows, on_data, on_event)
}

/// Drop stored connection options (tab closed). Secrets are zeroized on drop.
#[tauri::command]
pub fn ssh_forget(state: State<'_, AppState>, connection_id: String) {
    state.ssh_connections.lock().remove(&connection_id);
}

#[tauri::command]
pub fn known_hosts_list(state: State<'_, AppState>) -> CommandResult<Vec<KnownHost>> {
    Ok(state.vault.lock().with_conn(known_hosts::all)?)
}

#[tauri::command]
pub fn known_hosts_remove(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    key_type: String,
) -> CommandResult<()> {
    Ok(state
        .vault
        .lock()
        .with_conn(|c| known_hosts::remove(c, &host, port, &key_type))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cairn_core::SecretString;
    use cairn_proto_ssh::{AuthMethod, Hop};

    fn opts(host: &str, user: &str) -> ConnectOptions {
        ConnectOptions {
            hops: vec![Hop {
                host: host.into(),
                port: 22,
                username: user.into(),
                auth: vec![AuthMethod::Agent],
                algorithms: Default::default(),
            }],
            proxy: None,
            keepalive_secs: 30,
            keepalive_max: 3,
            connect_timeout_secs: 15,
            agent_forwarding: false,
        }
    }

    #[test]
    fn a_credential_profile_fills_username_auth_and_enable() {
        let profile = CredentialProfile {
            id: 7,
            name: "netops".into(),
            username: "admin".into(),
            key_path: None,
            auto_enable: true,
            notes: String::new(),
            has_password: true,
            has_key_data: false,
            has_key_passphrase: false,
            has_enable_secret: true,
        };
        let secrets = Secrets {
            password: Some(SecretString::new("pw".into())),
            enable_secret: Some(SecretString::new("en".into())),
            ..Secrets::default()
        };
        let mut form = opts("sw1", "");
        form.hops[0].auth = vec![
            AuthMethod::KeyFile {
                path: "/home/me/.ssh/id_ed25519".into(),
                passphrase: None,
            },
            AuthMethod::KeyboardInteractive,
        ];
        let (o, login) = with_profile(form, &profile, &secrets);
        let hop = &o.hops[0];
        assert_eq!(hop.username, "admin");
        assert!(validate(&o).is_ok());
        // The profile's password first; the form's key file kept; no duplicate kinds.
        assert!(matches!(
            &hop.auth[0],
            AuthMethod::Password { password: Some(_) }
        ));
        assert!(hop
            .auth
            .iter()
            .any(|m| matches!(m, AuthMethod::KeyFile { .. })));
        let interactive = hop
            .auth
            .iter()
            .filter(|m| matches!(m, AuthMethod::KeyboardInteractive))
            .count();
        assert_eq!(interactive, 1);
        assert!(login.enable_secret.is_some());

        // A username typed in the form wins over the profile's.
        let (o, _) = with_profile(opts("sw1", "ops"), &profile, &secrets);
        assert_eq!(o.hops[0].username, "ops");
    }

    #[test]
    fn validation() {
        assert!(validate(&opts("sw1", "admin")).is_ok());
        assert!(validate(&opts("", "admin")).is_err());
        assert!(validate(&opts("sw1", "")).is_err());
        let mut o = opts("sw1", "admin");
        o.hops[0].auth.clear();
        assert!(validate(&o).is_err());
        let mut o = opts("sw1", "admin");
        o.hops.clear();
        assert!(validate(&o).is_err());
    }

    #[test]
    fn options_deserialize_from_the_frontend_shape() {
        let json = r#"{
          "hops": [{"host":"10.0.0.1","port":22,"username":"admin",
                    "auth":[{"kind":"password","password":"pw"},{"kind":"keyboardInteractive"}],
                    "algorithms":{"legacy":["dh-group1-sha1"]}}],
          "proxy": {"kind":"socks5","host":"127.0.0.1","port":1080,"username":null,"password":null},
          "agentForwarding": true
        }"#;
        let o: ConnectOptions = serde_json::from_str(json).expect("parse");
        assert_eq!(o.keepalive_secs, 30);
        assert!(o.agent_forwarding);
        assert!(o.hops[0].algorithms.has_legacy());
        assert!(
            !format!("{o:?}").contains(r#""pw""#),
            "password must not appear in Debug"
        );
    }
}
