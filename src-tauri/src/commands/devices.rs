//! Connecting to inventory devices. Options are built in Rust from the device and its
//! credential profile, so stored secrets never pass through the frontend.

use super::session::require_unlocked;
use crate::error::{CommandError, CommandResult};
use crate::sessions::{DeviceRef, SessionId, SessionManager, SessionMessage};
use crate::state::AppState;
use cairn_core::inventory::credentials::{self, CredentialProfile, Secrets};
use cairn_core::inventory::{devices, ConnectionMethod, Device};
use cairn_core::login::LoginPlan;
use cairn_core::CoreError;
use cairn_proto_serial::{LineSettings, NewlineMapping, SerialOptions};
use cairn_proto_ssh::{AlgorithmPolicy, AuthMethod, ConnectOptions, Hop};
use cairn_proto_telnet::console::ConsoleServerKind;
use cairn_proto_telnet::TelnetOptions;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceOpened {
    pub session_id: SessionId,
    /// For SSH: the handle used by `ssh_reconnect` / `ssh_forget`.
    pub connection_id: Option<String>,
    pub protocol: &'static str,
    pub title: String,
    pub vendor: String,
}

/// What to start for a device's connection method.
#[derive(Debug)]
pub(crate) enum Plan {
    Ssh(ConnectOptions, LoginPlan),
    Telnet(TelnetOptions, LoginPlan),
    Serial(SerialOptions, LoginPlan),
}

fn invalid(msg: impl Into<String>) -> CommandError {
    CoreError::Validation(msg.into()).into()
}

/// `user@host:port`, `host`, `[v6::addr]:port`.
pub(crate) fn parse_target(s: &str) -> Option<(Option<String>, String, Option<u16>)> {
    let s = s.trim();
    if s.is_empty() || s.contains(char::is_whitespace) {
        return None;
    }
    let (user, rest) = match s.rsplit_once('@') {
        Some((u, r)) if !u.is_empty() => (Some(u.to_owned()), r),
        Some(_) => return None,
        None => (None, s),
    };
    if let Some(inner) = rest.strip_prefix('[') {
        let (host, after) = inner.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(p) => Some(p.parse().ok().filter(|p| *p > 0)?),
            None if after.is_empty() => None,
            None => return None,
        };
        return Some((user, host.to_owned(), port));
    }
    match rest.matches(':').count() {
        0 => (!rest.is_empty()).then(|| (user, rest.to_owned(), None)),
        1 => {
            let (h, p) = rest.split_once(':')?;
            let port = p.parse().ok().filter(|p| *p > 0)?;
            (!h.is_empty()).then(|| (user, h.to_owned(), Some(port)))
        }
        // A bare IPv6 address.
        _ => Some((user, rest.to_owned(), None)),
    }
}

/// The address to connect to: the management IP, else the hostname.
fn address(d: &Device) -> String {
    if d.mgmt_ip.is_empty() {
        d.hostname.clone()
    } else {
        d.mgmt_ip.clone()
    }
}

/// Destination auth from the profile, strongest first, then interactive fallbacks.
fn ssh_auth(profile: Option<&CredentialProfile>, secrets: &Secrets) -> Vec<AuthMethod> {
    let mut out = Vec::new();
    if let (Some(p), Some(data)) = (profile, &secrets.key_data) {
        out.push(AuthMethod::KeyData {
            label: p.name.clone(),
            data: data.clone(),
            passphrase: secrets.key_passphrase.clone(),
        });
    }
    if let Some(path) = profile.and_then(|p| p.key_path.as_deref()) {
        out.push(AuthMethod::KeyFile {
            path: PathBuf::from(path),
            passphrase: secrets.key_passphrase.clone(),
        });
    }
    if let Some(pw) = &secrets.password {
        out.push(AuthMethod::Password {
            password: Some(pw.clone()),
        });
    }
    if out.is_empty() {
        out.push(AuthMethod::Agent);
    }
    out.push(AuthMethod::KeyboardInteractive);
    out.push(AuthMethod::Password { password: None });
    out
}

fn enable_only(profile: Option<&CredentialProfile>, secrets: &Secrets) -> LoginPlan {
    LoginPlan {
        username: None,
        password: None,
        enable_secret: profile
            .filter(|p| p.auto_enable)
            .and(secrets.enable_secret.clone()),
    }
}

/// Telnet and console logins: answer username, password and (optionally) enable.
fn full_login(profile: Option<&CredentialProfile>, secrets: &Secrets) -> LoginPlan {
    LoginPlan {
        username: profile
            .map(|p| p.username.clone())
            .filter(|u| !u.is_empty()),
        password: secrets.password.clone(),
        ..enable_only(profile, secrets)
    }
}

pub(crate) fn plan(
    device: &Device,
    index: usize,
    profile: Option<&CredentialProfile>,
    secrets: &Secrets,
) -> CommandResult<Plan> {
    let method = device
        .connections
        .get(index)
        .ok_or_else(|| invalid("That connection method no longer exists."))?;
    match method {
        ConnectionMethod::Ssh {
            port,
            username,
            legacy,
            jumps,
            agent_forwarding,
        } => {
            let user = if username.is_empty() {
                profile.map(|p| p.username.clone()).unwrap_or_default()
            } else {
                username.clone()
            };
            if user.is_empty() {
                return Err(invalid(format!(
                    "Set a username for {} (in its SSH connection or credential profile).",
                    device.hostname
                )));
            }
            let legacy = serde_json::from_value(serde_json::json!({ "legacy": legacy }))
                .map_err(|_| invalid("This device has an unknown legacy algorithm."))?;
            let algorithms: AlgorithmPolicy = legacy;
            let mut hops = Vec::new();
            for part in jumps.split(',').map(str::trim).filter(|p| !p.is_empty()) {
                let (u, host, p) = parse_target(part)
                    .ok_or_else(|| invalid(format!("Jump host '{part}' is not user@host:port.")))?;
                hops.push(Hop {
                    host,
                    port: p.unwrap_or(22),
                    username: u.unwrap_or_else(|| user.clone()),
                    auth: vec![
                        AuthMethod::Agent,
                        AuthMethod::KeyboardInteractive,
                        AuthMethod::Password { password: None },
                    ],
                    algorithms: algorithms.clone(),
                });
            }
            hops.push(Hop {
                host: address(device),
                port: *port,
                username: user,
                auth: ssh_auth(profile, secrets),
                algorithms,
            });
            Ok(Plan::Ssh(
                ConnectOptions {
                    hops,
                    proxy: None,
                    keepalive_secs: 30,
                    keepalive_max: 3,
                    connect_timeout_secs: 15,
                    agent_forwarding: *agent_forwarding,
                },
                enable_only(profile, secrets),
            ))
        }
        ConnectionMethod::Telnet { port, raw } => Ok(Plan::Telnet(
            TelnetOptions {
                host: address(device),
                port: *port,
                raw: *raw,
                connect_timeout_secs: 10,
            },
            full_login(profile, secrets),
        )),
        ConnectionMethod::ConsoleServer {
            host,
            server,
            port,
            raw,
        } => {
            let kind: ConsoleServerKind = serde_json::from_value(serde_json::json!(server))
                .map_err(|_| invalid("Unknown console server type."))?;
            let tcp = kind
                .tcp_port(*port)
                .ok_or_else(|| invalid("That console port number is out of range."))?;
            Ok(Plan::Telnet(
                TelnetOptions {
                    host: host.clone(),
                    port: tcp,
                    raw: *raw,
                    connect_timeout_secs: 10,
                },
                full_login(profile, secrets),
            ))
        }
        ConnectionMethod::Serial {
            path,
            settings,
            newline,
            local_echo,
        } => {
            let settings: LineSettings = if settings.is_null() {
                LineSettings::default()
            } else {
                serde_json::from_value(settings.clone())
                    .map_err(|_| invalid("This device's serial settings are invalid."))?
            };
            let newline: NewlineMapping = if newline.is_null() {
                NewlineMapping::default()
            } else {
                serde_json::from_value(newline.clone())
                    .map_err(|_| invalid("This device's newline settings are invalid."))?
            };
            Ok(Plan::Serial(
                SerialOptions {
                    path: path.clone(),
                    settings,
                    newline,
                    local_echo: *local_echo,
                },
                full_login(profile, secrets),
            ))
        }
        ConnectionMethod::Rdp { .. } => Err(invalid(
            "RDP connections open in an RDP tab (device_rdp_open), not a terminal.",
        )),
        ConnectionMethod::Web { .. } => Err(invalid(
            "Web UIs open in your browser; use Open web UI instead.",
        )),
    }
}

/// Open a session to an inventory device using one of its connection methods.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn device_connect(
    state: State<'_, AppState>,
    sessions: State<'_, Arc<SessionManager>>,
    device_id: i64,
    method: usize,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionMessage>,
) -> CommandResult<DeviceOpened> {
    require_unlocked(&state)?;
    let (device, profile, secrets) = state.vault.lock().with_conn(|c| {
        let device = devices::get(c, device_id)?
            .ok_or_else(|| CoreError::Validation("That device no longer exists.".into()))?;
        let profile = match device.credential_id {
            Some(id) => credentials::get(c, id)?,
            None => None,
        };
        let secrets = match &profile {
            Some(p) => credentials::secrets(c, p.id)?,
            None => Secrets::default(),
        };
        Ok((device, profile, secrets))
    })?;
    let plan = plan(&device, method, profile.as_ref(), &secrets)?;
    drop(secrets);
    let name = Some(DeviceRef {
        id: device.id,
        hostname: device.hostname.clone(),
        record: device.record_sessions,
    });
    let opened = |session_id, connection_id, protocol| DeviceOpened {
        session_id,
        connection_id,
        protocol,
        title: device.hostname.clone(),
        vendor: device.vendor.clone(),
    };
    match plan {
        Plan::Ssh(opts, login) => {
            let target = super::ssh::SshTarget {
                opts,
                device: name,
                login,
            };
            let o = super::ssh::open(&state, &sessions, target, cols, rows, on_data, on_event)?;
            Ok(opened(o.session_id, Some(o.connection_id), "ssh"))
        }
        Plan::Telnet(opts, login) => {
            let id = super::telnet::start(
                &state, &sessions, opts, name, login, cols, rows, on_data, on_event,
            )?;
            Ok(opened(id, None, "telnet"))
        }
        Plan::Serial(opts, login) => {
            let id = super::serial::start(&state, &sessions, opts, name, login, on_data, on_event)?;
            Ok(opened(id, None, "serial"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cairn_core::SecretString;
    use std::collections::BTreeMap;

    fn device(connections: Vec<ConnectionMethod>) -> Device {
        Device {
            id: 1,
            hostname: "core-sw1".into(),
            mgmt_ip: "10.0.0.1".into(),
            device_type: cairn_core::inventory::DeviceType::Switch,
            vendor: "Cisco".into(),
            model: String::new(),
            serial: String::new(),
            firmware: String::new(),
            building_id: None,
            floor_id: None,
            room_id: None,
            rack_id: None,
            rack_u: None,
            u_height: 1,
            credential_id: Some(1),
            connections,
            vlans: vec![],
            tags: vec![],
            notes: String::new(),
            custom: BTreeMap::new(),
            interface_count: 0,
            record_sessions: false,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn profile(auto_enable: bool) -> CredentialProfile {
        CredentialProfile {
            id: 1,
            name: "Lab".into(),
            username: "admin".into(),
            key_path: None,
            auto_enable,
            notes: String::new(),
            has_password: true,
            has_key_data: false,
            has_key_passphrase: false,
            has_enable_secret: true,
        }
    }

    fn secrets() -> Secrets {
        Secrets {
            password: Some(SecretString::from("pw")),
            key_data: None,
            key_passphrase: None,
            enable_secret: Some(SecretString::from("en")),
        }
    }

    fn ssh(username: &str, jumps: &str, legacy: &[&str]) -> ConnectionMethod {
        ConnectionMethod::Ssh {
            port: 2222,
            username: username.into(),
            legacy: legacy.iter().map(|s| (*s).to_owned()).collect(),
            jumps: jumps.into(),
            agent_forwarding: false,
        }
    }

    #[test]
    fn ssh_uses_the_profile_and_enables() {
        let d = device(vec![ssh("", "ops@bastion:2200", &["dh-group1-sha1"])]);
        let Plan::Ssh(opts, login) = plan(&d, 0, Some(&profile(true)), &secrets()).expect("plan")
        else {
            panic!("not ssh");
        };
        assert_eq!(opts.hops.len(), 2);
        assert_eq!(opts.hops[0].host, "bastion");
        assert_eq!(opts.hops[0].username, "ops");
        assert_eq!(opts.hops[0].port, 2200);
        let dest = &opts.hops[1];
        assert_eq!((dest.host.as_str(), dest.port), ("10.0.0.1", 2222));
        assert_eq!(dest.username, "admin");
        assert!(dest.algorithms.has_legacy());
        assert!(matches!(
            &dest.auth[0],
            AuthMethod::Password { password: Some(p) } if p.expose() == "pw"
        ));
        assert!(login.username.is_none() && login.password.is_none());
        assert_eq!(
            login.enable_secret.as_ref().map(SecretString::expose),
            Some("en")
        );
        // Without auto-enable the enable secret is not typed.
        let Plan::Ssh(_, login) = plan(&d, 0, Some(&profile(false)), &secrets()).expect("plan")
        else {
            panic!("not ssh");
        };
        assert!(login.is_empty());
    }

    #[test]
    fn ssh_needs_a_username_and_valid_legacy_ids() {
        let d = device(vec![ssh("", "", &[])]);
        assert!(plan(&d, 0, None, &Secrets::default()).is_err());
        let d = device(vec![ssh("root", "", &["nope"])]);
        assert!(plan(&d, 0, None, &Secrets::default()).is_err());
        let d = device(vec![ssh("root", "", &[])]);
        let Plan::Ssh(opts, _) = plan(&d, 0, None, &Secrets::default()).expect("plan") else {
            panic!("not ssh");
        };
        assert!(matches!(opts.hops[0].auth[0], AuthMethod::Agent));
        assert!(plan(&d, 5, None, &Secrets::default()).is_err());
    }

    #[test]
    fn telnet_console_and_serial_log_in() {
        let d = device(vec![
            ConnectionMethod::ConsoleServer {
                host: "cs1".into(),
                server: "opengear".into(),
                port: 7,
                raw: false,
            },
            ConnectionMethod::Serial {
                path: "/dev/ttyUSB0".into(),
                settings: serde_json::json!({"baud": 115200, "dataBits": "eight",
                    "parity": "none", "stopBits": "one", "flowControl": "none"}),
                newline: serde_json::Value::Null,
                local_echo: false,
            },
            ConnectionMethod::Web {
                url: "https://10.0.0.1".into(),
            },
        ]);
        let Plan::Telnet(t, login) = plan(&d, 0, Some(&profile(true)), &secrets()).expect("cs")
        else {
            panic!("not telnet");
        };
        assert_eq!((t.host.as_str(), t.port), ("cs1", 2007));
        assert_eq!(login.username.as_deref(), Some("admin"));
        assert!(login.password.is_some() && login.enable_secret.is_some());
        let Plan::Serial(s, _) = plan(&d, 1, None, &Secrets::default()).expect("serial") else {
            panic!("not serial");
        };
        assert_eq!(s.settings.baud, 115200);
        assert!(plan(&d, 2, None, &Secrets::default()).is_err());
    }

    #[test]
    fn parses_jump_targets() {
        assert_eq!(
            parse_target("ops@[2001:db8::1]:22"),
            Some((Some("ops".into()), "2001:db8::1".into(), Some(22)))
        );
        assert_eq!(
            parse_target("bastion"),
            Some((None, "bastion".into(), None))
        );
        assert_eq!(
            parse_target("fe80::1"),
            Some((None, "fe80::1".into(), None))
        );
        assert_eq!(parse_target("h:0"), None);
        assert_eq!(parse_target("@h"), None);
        assert_eq!(parse_target("ops@"), None);
        assert_eq!(parse_target("a b"), None);
    }
}
