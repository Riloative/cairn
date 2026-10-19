//! RDP session commands and the external-client fallback.
//!
//! A session id is returned at once; connecting (including a password prompt or an SSH
//! tunnel) happens in the background and reports on the session's event channel.
//! Credentials are resolved in Rust from the device's credential profile and never
//! reach the frontend.

use super::devices::parse_target;
use super::session::require_unlocked;
use crate::error::{CommandError, CommandResult};
use crate::sessions::rdp::{self, RdpContext, RdpMessage, TauriRdp};
use crate::sessions::ssh::{SessionContext, TauriInteract};
use crate::state::AppState;
use cairn_core::audit::AuditEvent;
use cairn_core::inventory::credentials::{self, Secrets};
use cairn_core::inventory::{devices, ConnectionMethod, Device};
use cairn_core::{CoreError, SecretString};
use cairn_proto_rdp::{profile, tcp_dialer, ColorDepth, RdpConfig, RdpInput, RdpSession, Security};
use cairn_proto_ssh::{AuthMethod, ConnectOptions, Hop};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::sync::oneshot;

enum Entry {
    /// Waiting for a password; sending on the channel cancels the start.
    Starting(oneshot::Sender<()>),
    Live(Arc<RdpSession>),
}

/// Open RDP sessions by id.
#[derive(Default)]
pub struct RdpService {
    sessions: Arc<Mutex<HashMap<String, Entry>>>,
    next: AtomicU64,
}

impl std::fmt::Debug for RdpService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RdpService")
            .field("open", &self.sessions.lock().len())
            .finish()
    }
}

impl RdpService {
    fn live(&self, id: &str) -> Option<Arc<RdpSession>> {
        match self.sessions.lock().get(id) {
            Some(Entry::Live(s)) => Some(s.clone()),
            _ => None,
        }
    }

    /// Close every session (app exit).
    /// Whether no remote desktop is open.
    pub fn is_empty(&self) -> bool {
        self.sessions.lock().is_empty()
    }

    pub fn close_all(&self) {
        for (_, entry) in self.sessions.lock().drain() {
            match entry {
                Entry::Live(s) => s.close(),
                Entry::Starting(cancel) => {
                    let _ = cancel.send(());
                }
            }
        }
    }
}

/// Ad-hoc connection options from the quick-connect dialog.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpOptions {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: Option<SecretString>,
    #[serde(default)]
    pub domain: String,
    #[serde(default)]
    pub security: Security,
    /// 0×0 follows the window.
    #[serde(default)]
    pub width: u16,
    #[serde(default)]
    pub height: u16,
    #[serde(default = "default_depth")]
    pub color_depth: u8,
    #[serde(default = "default_true")]
    pub clipboard: bool,
    /// SSH jump host (`user@host:port`); empty connects directly.
    #[serde(default)]
    pub tunnel: String,
}

fn default_port() -> u16 {
    3389
}
fn default_depth() -> u8 {
    32
}
fn default_true() -> bool {
    true
}

/// The size of the view the session opens in.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSize {
    pub width: u32,
    pub height: u32,
    /// Device pixel ratio × 100.
    #[serde(default)]
    pub scale: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpOpened {
    pub session_id: String,
    pub title: String,
    /// The desktop size requested (fixed resolution or the view size).
    pub width: u16,
    pub height: u16,
}

fn invalid(msg: impl Into<String>) -> CommandError {
    CoreError::Validation(msg.into()).into()
}

fn validate(o: &RdpOptions) -> CommandResult<()> {
    if o.host.trim().is_empty() || o.host.len() > 253 || o.host.contains(char::is_whitespace) {
        return Err(invalid("Enter a valid hostname or IP address."));
    }
    if o.port == 0 {
        return Err(invalid("The port must be between 1 and 65535."));
    }
    if o.username.trim().is_empty() || o.username.len() > 255 {
        return Err(invalid("Enter a username."));
    }
    if !matches!(o.color_depth, 16 | 32) {
        return Err(invalid("Color depth must be 16 or 32 bits."));
    }
    let side = |v: u16| (profile::MIN_SIDE..=profile::MAX_SIDE).contains(&v);
    if !((o.width == 0 && o.height == 0) || (side(o.width) && side(o.height))) {
        return Err(invalid(
            "The resolution must be 200–8192 pixels per side, or follow the window.",
        ));
    }
    if o.tunnel.len() > 255 {
        return Err(invalid("The SSH tunnel is too long."));
    }
    Ok(())
}

/// `DOMAIN\user` or `user@domain` in the username field fills the domain.
fn split_domain(username: &str, domain: &str) -> (String, Option<String>) {
    if !domain.is_empty() {
        return (username.to_owned(), Some(domain.to_owned()));
    }
    match username.split_once('\\') {
        Some((d, u)) if !d.is_empty() && !u.is_empty() => (u.to_owned(), Some(d.to_owned())),
        _ => (username.to_owned(), None),
    }
}

/// The SSH options for a tunnel spec: agent, keyboard-interactive and password prompts,
/// like SSH jump hosts.
fn tunnel_options(spec: &str, fallback_user: &str) -> CommandResult<ConnectOptions> {
    let (user, host, port) = parse_target(spec)
        .ok_or_else(|| invalid(format!("The SSH tunnel '{spec}' is not user@host:port.")))?;
    Ok(ConnectOptions {
        hops: vec![Hop {
            host,
            port: port.unwrap_or(22),
            username: user.unwrap_or_else(|| fallback_user.to_owned()),
            auth: vec![
                AuthMethod::Agent,
                AuthMethod::KeyboardInteractive,
                AuthMethod::Password { password: None },
            ],
            algorithms: Default::default(),
        }],
        proxy: None,
        keepalive_secs: 30,
        keepalive_max: 3,
        connect_timeout_secs: 15,
        agent_forwarding: false,
    })
}

/// The desktop size to request: the fixed resolution, else the view.
fn desktop_size(o: &RdpOptions, view: ViewSize) -> (u16, u16) {
    if o.width > 0 {
        (o.width, o.height)
    } else {
        profile::clamp_size(view.width, view.height)
    }
}

struct Launch {
    options: RdpOptions,
    device: Option<String>,
    title: String,
}

fn launch(
    state: &AppState,
    service: &RdpService,
    l: Launch,
    view: ViewSize,
    on_frame: Channel<InvokeResponseBody>,
    on_event: Channel<RdpMessage>,
) -> CommandResult<RdpOpened> {
    validate(&l.options)?;
    let id = format!("r{}", service.next.fetch_add(1, Ordering::Relaxed) + 1);
    let (width, height) = desktop_size(&l.options, view);
    let o = l.options;
    let target = format!("{}:{}", o.host, o.port);
    let (username, domain) = split_domain(o.username.trim(), o.domain.trim());
    let tunnel = if o.tunnel.trim().is_empty() {
        None
    } else {
        Some(tunnel_options(o.tunnel.trim(), &username)?)
    };
    let (cancel_tx, cancel_rx) = oneshot::channel();
    service
        .sessions
        .lock()
        .insert(id.clone(), Entry::Starting(cancel_tx));

    let registry = service.sessions.clone();
    let (broker, vault, audit) = (
        state.prompts.clone(),
        state.vault.clone(),
        state.audit.clone(),
    );
    let ctx = RdpContext {
        session_id: id.clone(),
        target: target.clone(),
        username: username.clone(),
        device: l.device.clone(),
    };
    let session_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let password = match o.password.filter(|p| !p.is_empty()) {
            Some(p) => Some(p),
            None => {
                tokio::select! {
                    p = rdp::ask_password(&on_event, &broker, &username, &target) => p,
                    _ = cancel_rx => None,
                }
            }
        };
        let Some(password) = password else {
            registry.lock().remove(&session_id);
            let _ = on_event.send(RdpMessage::Event {
                event: cairn_proto_rdp::RdpEvent::Closed {
                    graceful: true,
                    message: "Cancelled.".into(),
                },
            });
            return;
        };
        let config = RdpConfig {
            host: o.host.clone(),
            port: o.port,
            username: username.clone(),
            password,
            domain,
            security: o.security,
            color_depth: if o.color_depth == 16 {
                ColorDepth::Bpp16
            } else {
                ColorDepth::Bpp32
            },
            width,
            height,
            scale_factor: if (100..=500).contains(&view.scale) {
                view.scale
            } else {
                0
            },
            clipboard: o.clipboard,
        };
        let dialer = match tunnel {
            Some(opts) => rdp::tunnel_dialer(
                opts,
                o.host.clone(),
                o.port,
                TauriInteract {
                    output: rdp::tunnel_output(on_event.clone()),
                    broker: broker.clone(),
                    vault: vault.clone(),
                    audit: audit.clone(),
                    ctx: SessionContext {
                        session_id: session_id.clone(),
                        target: o.tunnel.clone(),
                        username: username.clone(),
                        device: ctx.device.clone(),
                    },
                },
            ),
            None => tcp_dialer(o.host.clone(), o.port),
        };
        let closed_registry = registry.clone();
        let closed_id = session_id.clone();
        let interact = Arc::new(TauriRdp::new(
            on_frame,
            on_event,
            broker,
            vault,
            audit,
            ctx,
            Box::new(move || {
                closed_registry.lock().remove(&closed_id);
            }),
        ));
        let mut sessions = registry.lock();
        // The tab may have been closed while we asked for the password.
        if let Some(Entry::Starting(_)) = sessions.get(&session_id) {
            let session = RdpSession::start(config, dialer, interact);
            sessions.insert(session_id, Entry::Live(Arc::new(session)));
        }
    });
    Ok(RdpOpened {
        session_id: id,
        title: l.title,
        width,
        height,
    })
}

/// Open an ad-hoc RDP session.
#[tauri::command]
pub async fn rdp_open(
    state: State<'_, AppState>,
    service: State<'_, RdpService>,
    options: RdpOptions,
    credential_id: Option<i64>,
    view: ViewSize,
    on_frame: Channel<InvokeResponseBody>,
    on_event: Channel<RdpMessage>,
) -> CommandResult<RdpOpened> {
    require_unlocked(&state)?;
    let mut options = options;
    if let Some((profile, secrets)) = super::saved::credential(&state, credential_id)? {
        if options.username.trim().is_empty() {
            options.username = profile.username.clone();
        }
        if options.password.is_none() {
            options.password = secrets.password.clone();
        }
    }
    let title = options.host.clone();
    launch(
        &state,
        &service,
        Launch {
            options,
            device: None,
            title,
        },
        view,
        on_frame,
        on_event,
    )
}

/// RDP options for a device's connection method, with the profile's credentials.
pub(crate) fn device_options(
    device: &Device,
    index: usize,
    profile_user: Option<&str>,
    secrets: &Secrets,
) -> CommandResult<(RdpOptions, bool)> {
    let Some(ConnectionMethod::Rdp {
        port,
        username,
        domain,
        security,
        width,
        height,
        color_depth,
        clipboard,
        tunnel,
        external,
    }) = device.connections.get(index)
    else {
        return Err(invalid("That RDP connection no longer exists."));
    };
    let user = if username.is_empty() {
        profile_user.unwrap_or_default().to_owned()
    } else {
        username.clone()
    };
    if user.is_empty() {
        return Err(invalid(format!(
            "Set a username for {} (in its RDP connection or credential profile).",
            device.hostname
        )));
    }
    let host = if device.mgmt_ip.is_empty() {
        device.hostname.clone()
    } else {
        device.mgmt_ip.clone()
    };
    Ok((
        RdpOptions {
            host,
            port: *port,
            username: user,
            password: secrets.password.clone(),
            domain: domain.clone(),
            security: if security == "tls" {
                Security::Tls
            } else {
                Security::Nla
            },
            width: *width,
            height: *height,
            color_depth: *color_depth,
            clipboard: *clipboard,
            tunnel: tunnel.clone(),
        },
        *external,
    ))
}

fn load_device(
    state: &AppState,
    device_id: i64,
) -> CommandResult<(Device, Option<String>, Secrets)> {
    Ok(state.vault.lock().with_conn(|c| {
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
        Ok((device, profile.map(|p| p.username), secrets))
    })?)
}

/// Open an RDP session to an inventory device.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn device_rdp_open(
    state: State<'_, AppState>,
    service: State<'_, RdpService>,
    device_id: i64,
    method: usize,
    view: ViewSize,
    on_frame: Channel<InvokeResponseBody>,
    on_event: Channel<RdpMessage>,
) -> CommandResult<RdpOpened> {
    require_unlocked(&state)?;
    let (device, profile_user, secrets) = load_device(&state, device_id)?;
    let (options, _) = device_options(&device, method, profile_user.as_deref(), &secrets)?;
    drop(secrets);
    launch(
        &state,
        &service,
        Launch {
            options,
            device: Some(device.hostname.clone()),
            title: device.hostname.clone(),
        },
        view,
        on_frame,
        on_event,
    )
}

#[tauri::command]
pub fn rdp_input(service: State<'_, RdpService>, session_id: String, events: Vec<RdpInput>) {
    if events.len() <= 512 {
        if let Some(s) = service.live(&session_id) {
            s.input(events);
        }
    }
}

#[tauri::command]
pub fn rdp_resize(service: State<'_, RdpService>, session_id: String, view: ViewSize) {
    if let Some(s) = service.live(&session_id) {
        s.resize(view.width, view.height, view.scale);
    }
}

/// Offer local clipboard text to the server (only when the session allows clipboard).
#[tauri::command]
pub fn rdp_clipboard(service: State<'_, RdpService>, session_id: String, text: String) {
    // A 4 MB cap keeps a runaway paste from stalling the session.
    if text.len() <= 4 << 20 {
        if let Some(s) = service.live(&session_id) {
            s.clipboard(text);
        }
    }
}

#[tauri::command]
pub fn rdp_ctrl_alt_del(service: State<'_, RdpService>, session_id: String) {
    if let Some(s) = service.live(&session_id) {
        s.ctrl_alt_del();
    }
}

/// Close a session (tab closed). Also cancels one that is still asking for a password.
#[tauri::command]
pub fn rdp_close(service: State<'_, RdpService>, session_id: String) {
    match service.sessions.lock().remove(&session_id) {
        Some(Entry::Live(s)) => s.close(),
        Some(Entry::Starting(cancel)) => {
            let _ = cancel.send(());
        }
        None => {}
    }
}

/// Launch the device in an external RDP client: FreeRDP on Linux (password on stdin, never
/// on the command line), an `.rdp` file opened by the system on macOS.
#[tauri::command]
pub async fn rdp_external(
    state: State<'_, AppState>,
    device_id: i64,
    method: usize,
) -> CommandResult<String> {
    require_unlocked(&state)?;
    let (device, profile_user, secrets) = load_device(&state, device_id)?;
    let (o, _) = device_options(&device, method, profile_user.as_deref(), &secrets)?;
    drop(secrets);
    validate(&o)?;
    if !o.tunnel.trim().is_empty() {
        return Err(invalid(
            "SSH tunnels work with Cairn's built-in RDP client only. Turn off \"Open in external client\" for this device.",
        ));
    }
    let launched = external::launch(&o, &state.vault.lock().dir().join("tmp"))?;
    state.audit.record(
        &state.vault,
        AuditEvent::SessionStarted {
            session_id: format!("external-{device_id}"),
            protocol: "rdp".into(),
            target: format!("{}:{}", o.host, o.port),
            username: Some(o.username.clone()),
            device: Some(device.hostname.clone()),
            host_key_fingerprint: None,
        },
    );
    Ok(launched)
}

mod external {
    use super::{invalid, RdpOptions};
    use crate::error::CommandResult;
    use cairn_proto_rdp::Security;
    use std::path::Path;

    /// FreeRDP clients to try, newest first.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    const FREERDP: &[&str] = &[
        "sdl-freerdp3",
        "xfreerdp3",
        "wlfreerdp3",
        "sdl-freerdp",
        "xfreerdp",
        "wlfreerdp",
    ];

    /// FreeRDP arguments. The password is never among them.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub(super) fn freerdp_args(o: &RdpOptions) -> Vec<String> {
        let (user, domain) = super::split_domain(&o.username, &o.domain);
        let mut args = vec![format!("/v:{}:{}", o.host, o.port), format!("/u:{user}")];
        if let Some(d) = domain {
            args.push(format!("/d:{d}"));
        }
        args.push(match o.security {
            Security::Nla => "/sec:nla".into(),
            Security::Tls => "/sec:tls".into(),
        });
        args.push(format!("/bpp:{}", o.color_depth));
        if o.width > 0 {
            args.push(format!("/size:{}x{}", o.width, o.height));
        } else {
            args.push("/dynamic-resolution".into());
        }
        if o.clipboard {
            args.push("+clipboard".into());
        }
        if o.password.is_some() {
            args.push("/from-stdin".into());
        }
        args
    }

    /// An `.rdp` file for the system client (no password: the format cannot hold one
    /// securely).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(super) fn rdp_file(o: &RdpOptions) -> String {
        let (user, domain) = super::split_domain(&o.username, &o.domain);
        let user = match domain {
            Some(d) => format!("{d}\\{user}"),
            None => user,
        };
        let mut lines = vec![
            format!("full address:s:{}:{}", o.host, o.port),
            format!("username:s:{user}"),
            format!("session bpp:i:{}", o.color_depth),
            format!(
                "enablecredsspsupport:i:{}",
                u8::from(o.security == Security::Nla)
            ),
            format!("redirectclipboard:i:{}", u8::from(o.clipboard)),
            "prompt for credentials:i:1".into(),
        ];
        if o.width > 0 {
            lines.push("screen mode id:i:1".into());
            lines.push(format!("desktopwidth:i:{}", o.width));
            lines.push(format!("desktopheight:i:{}", o.height));
        } else {
            lines.push("dynamic resolution:i:1".into());
        }
        lines.join("\r\n") + "\r\n"
    }

    #[cfg(target_os = "macos")]
    pub(super) fn launch(o: &RdpOptions, tmp: &Path) -> CommandResult<String> {
        std::fs::create_dir_all(tmp).map_err(|e| cairn_core::CoreError::io(tmp, e))?;
        let safe: String = o
            .host
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let path = tmp.join(format!("{safe}.rdp"));
        std::fs::write(&path, rdp_file(o)).map_err(|e| cairn_core::CoreError::io(&path, e))?;
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|_| {
                invalid("No app opens .rdp files. Install Windows App (Microsoft Remote Desktop) from the App Store.")
            })?;
        Ok("Opened in the system RDP app".into())
    }

    #[cfg(not(target_os = "macos"))]
    pub(super) fn launch(o: &RdpOptions, _tmp: &Path) -> CommandResult<String> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let path = std::env::var_os("PATH").unwrap_or_default();
        let bin = FREERDP
            .iter()
            .find_map(|name| {
                std::env::split_paths(&path)
                    .map(|dir| dir.join(name))
                    .find(|p| p.is_file())
            })
            .ok_or_else(|| {
                invalid("FreeRDP is not installed. Install it (sudo apt install freerdp3-x11) or turn off \"Open in external client\".")
            })?;
        let mut child = Command::new(&bin)
            .args(freerdp_args(o))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| invalid(format!("Could not start {}: {e}", bin.display())))?;
        if let (Some(pw), Some(mut stdin)) = (&o.password, child.stdin.take()) {
            // FreeRDP reads the password from stdin (`/from-stdin`); it never appears in the
            // process list.
            let _ = writeln!(stdin, "{}", pw.expose());
        }
        let name = bin
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(format!("Opened in {name}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> RdpOptions {
        serde_json::from_value(serde_json::json!({
            "host": "srv1", "username": "CORP\\admin", "password": "hunter2-secret"
        }))
        .expect("options")
    }

    #[test]
    fn options_default_and_validate() {
        let o = opts();
        assert_eq!(
            (o.port, o.color_depth, o.security),
            (3389, 32, Security::Nla)
        );
        assert!(o.clipboard);
        assert!(validate(&o).is_ok());
        assert!(validate(&RdpOptions {
            width: 1920,
            ..opts()
        })
        .is_err());
        assert!(validate(&RdpOptions {
            width: 1920,
            height: 1080,
            ..opts()
        })
        .is_ok());
        assert!(validate(&RdpOptions {
            host: " ".into(),
            ..opts()
        })
        .is_err());
        assert!(!format!("{o:?}").contains("hunter2"), "password in Debug");
    }

    #[test]
    fn splits_domain_from_the_username() {
        assert_eq!(
            split_domain("CORP\\admin", ""),
            ("admin".into(), Some("CORP".into()))
        );
        assert_eq!(
            split_domain("admin@corp.local", ""),
            ("admin@corp.local".into(), None)
        );
        assert_eq!(
            split_domain("admin", "LAB"),
            ("admin".into(), Some("LAB".into()))
        );
    }

    #[test]
    fn desktop_size_follows_the_view_unless_fixed() {
        let view = ViewSize {
            width: 1501,
            height: 900,
            scale: 200,
        };
        assert_eq!(desktop_size(&opts(), view), (1500, 900));
        let fixed = RdpOptions {
            width: 1280,
            height: 1024,
            ..opts()
        };
        assert_eq!(desktop_size(&fixed, view), (1280, 1024));
    }

    #[test]
    fn tunnel_spec_becomes_an_ssh_hop() {
        let o = tunnel_options("ops@bastion:2222", "admin").expect("spec");
        assert_eq!(o.hops[0].host, "bastion");
        assert_eq!((o.hops[0].port, o.hops[0].username.as_str()), (2222, "ops"));
        let o = tunnel_options("bastion", "admin").expect("spec");
        assert_eq!((o.hops[0].port, o.hops[0].username.as_str()), (22, "admin"));
        assert!(tunnel_options("ops@", "admin").is_err());
    }

    #[test]
    fn freerdp_args_never_carry_the_password() {
        let args = external::freerdp_args(&opts());
        assert!(args.contains(&"/v:srv1:3389".to_string()));
        assert!(args.contains(&"/u:admin".to_string()));
        assert!(args.contains(&"/d:CORP".to_string()));
        assert!(args.contains(&"/from-stdin".to_string()));
        assert!(args.contains(&"/dynamic-resolution".to_string()));
        assert!(!args.iter().any(|a| a.contains("hunter2")));
    }

    #[test]
    fn rdp_file_has_address_user_and_no_password() {
        let file = external::rdp_file(&RdpOptions {
            width: 1280,
            height: 720,
            ..opts()
        });
        assert!(file.contains("full address:s:srv1:3389\r\n"));
        assert!(file.contains("username:s:CORP\\admin\r\n"));
        assert!(file.contains("desktopwidth:i:1280"));
        assert!(!file.contains("hunter2"));
    }
}
