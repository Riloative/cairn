//! Establishing an authenticated SSH connection, optionally through a proxy and a chain
//! of jump hosts (ProxyJump).

use crate::algorithms::{AlgorithmPolicy, LegacyAlgorithm};
use crate::clock::PromptClock;
use crate::error::{connect_error, SshError};
use crate::hostkey::HostKeyInfo;
use crate::interact::{HostKeyVerdict, Interact, Progress, Prompt};
use crate::proxy::{connect_via, ProxyConfig};
use cairn_core::SecretString;
use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{Channel, ChannelOpenFailure};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::Mutex;

/// How to authenticate on one hop. Methods are tried in order.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AuthMethod {
    /// Use keys from the running ssh-agent (`SSH_AUTH_SOCK`).
    Agent,
    /// A private key file; asks for the passphrase if it is encrypted and none is given.
    #[serde(rename_all = "camelCase")]
    KeyFile {
        path: PathBuf,
        passphrase: Option<SecretString>,
    },
    /// A private key held in the vault (OpenSSH/PEM text).
    #[serde(rename_all = "camelCase")]
    KeyData {
        label: String,
        data: SecretString,
        passphrase: Option<SecretString>,
    },
    /// Keyboard-interactive (RADIUS/TACACS+ OTP and similar prompts).
    KeyboardInteractive,
    /// Password; asks the user when `password` is `None`.
    Password { password: Option<SecretString> },
}

/// One SSH server in the chain.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hop {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: Vec<AuthMethod>,
    #[serde(default)]
    pub algorithms: AlgorithmPolicy,
}

impl Hop {
    pub fn target(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOptions {
    /// Jump hosts first, the destination last. Must not be empty.
    pub hops: Vec<Hop>,
    /// Proxy for the first hop's TCP connection.
    pub proxy: Option<ProxyConfig>,
    /// Send a keepalive after this many seconds of silence (0 disables).
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: u32,
    /// Give up after this many unanswered keepalives.
    #[serde(default = "default_keepalive_max")]
    pub keepalive_max: u32,
    #[serde(default = "default_connect_timeout")]
    pub connect_timeout_secs: u32,
    /// Forward the local ssh-agent to the destination. Off by default.
    #[serde(default)]
    pub agent_forwarding: bool,
}

fn default_keepalive() -> u32 {
    30
}
fn default_keepalive_max() -> u32 {
    3
}
fn default_connect_timeout() -> u32 {
    15
}

/// An authenticated connection; keeps jump-host connections alive.
pub struct Connection {
    /// Jump hosts, in order; dropped (disconnected) with the connection.
    _jumps: Vec<Handle<ClientHandler>>,
    pub handle: Handle<ClientHandler>,
    pub host_key: Option<HostKeyInfo>,
    pub target: String,
    /// Remote (ssh -R) forwards: where connections the server forwards to us go.
    pub routes: RemoteRoutes,
}

/// Where the server's forwarded connections for one remote listener go.
#[derive(Debug, Clone)]
pub struct RemoteRoute {
    pub dest_host: String,
    pub dest_port: u16,
    pub stats: Arc<crate::forward::ForwardStats>,
}

/// Remote listeners by (address, port) as requested from the server.
pub type RemoteRoutes = Arc<std::sync::Mutex<HashMap<(String, u32), RemoteRoute>>>;

/// The route for a forwarded connection. Servers may report the listen address
/// differently than requested ("localhost" vs "127.0.0.1"), so a unique port matches too.
fn find_route(routes: &RemoteRoutes, address: &str, port: u32) -> Option<RemoteRoute> {
    let routes = routes.lock().ok()?;
    if let Some(r) = routes.get(&(address.to_owned(), port)) {
        return Some(r.clone());
    }
    let mut by_port = routes.iter().filter(|((_, p), _)| *p == port);
    match (by_port.next(), by_port.next()) {
        (Some((_, r)), None) => Some(r.clone()),
        _ => None,
    }
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection")
            .field("target", &self.target)
            .finish()
    }
}

/// russh event handler for one hop.
pub struct ClientHandler {
    host: String,
    port: u16,
    interact: Arc<dyn Interact>,
    agent_forwarding: bool,
    host_key: Arc<Mutex<Option<HostKeyInfo>>>,
    clock: Arc<PromptClock>,
    /// Remote-forward routes (destination hop only).
    routes: Option<RemoteRoutes>,
}

impl std::fmt::Debug for ClientHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientHandler")
            .field("host", &self.host)
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Host certificates are verified like plain keys (by their public key); Cairn does
        // not trust SSH CAs implicitly.
        let key = match key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            russh::keys::PublicKeyOrCertificate::Certificate(cert) => {
                PublicKey::new(cert.public_key().clone(), "")
            }
        };
        let info = HostKeyInfo::from_key(&self.host, self.port, &key);
        let verdict = self
            .clock
            .pause_during(self.interact.host_key(info.clone()))
            .await;
        if verdict == HostKeyVerdict::Accept {
            *self.host_key.lock().await = Some(info);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.interact.banner(banner.to_owned());
        Ok(())
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if !self.agent_forwarding {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        reply.accept().await;
        tokio::spawn(bridge_agent(channel));
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let route = self
            .routes
            .as_ref()
            .and_then(|r| find_route(r, connected_address, connected_port));
        let Some(route) = route else {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(crate::forward::bridge_remote(channel, route));
        Ok(())
    }
}

/// Pipe a forwarded-agent channel to the local agent socket.
#[cfg(unix)]
async fn bridge_agent(channel: Channel<client::Msg>) {
    let Some(sock) = std::env::var_os("SSH_AUTH_SOCK") else {
        let _ = channel.close().await;
        return;
    };
    match tokio::net::UnixStream::connect(sock).await {
        Ok(mut agent) => {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut agent).await;
        }
        Err(_) => {
            let _ = channel.close().await;
        }
    }
}

#[cfg(not(unix))]
async fn bridge_agent(channel: Channel<client::Msg>) {
    let _ = channel.close().await;
}

fn config(opts: &ConnectOptions, policy: &AlgorithmPolicy) -> Arc<client::Config> {
    Arc::new(client::Config {
        preferred: policy.preferred(),
        keepalive_interval: (opts.keepalive_secs > 0)
            .then(|| Duration::from_secs(u64::from(opts.keepalive_secs))),
        keepalive_max: opts.keepalive_max as usize,
        inactivity_timeout: None,
        nodelay: true,
        ..Default::default()
    })
}

/// Connect, verify host keys and authenticate every hop.
pub async fn connect(
    opts: &ConnectOptions,
    interact: Arc<dyn Interact>,
) -> Result<Connection, SshError> {
    let last = opts
        .hops
        .len()
        .checked_sub(1)
        .ok_or_else(|| SshError::Protocol("no destination given".into()))?;
    let timeout = Duration::from_secs(u64::from(opts.connect_timeout_secs.max(1)));
    let clock = Arc::new(PromptClock::default());
    let mut jumps: Vec<Handle<ClientHandler>> = Vec::new();
    let mut host_key = None;
    let routes = RemoteRoutes::default();

    for (index, hop) in opts.hops.iter().enumerate() {
        let target = hop.target();
        interact.progress(Progress::Connecting {
            index,
            target: target.clone(),
        });
        let slot = Arc::new(Mutex::new(None));
        let handler = ClientHandler {
            host: hop.host.clone(),
            port: hop.port,
            interact: interact.clone(),
            agent_forwarding: opts.agent_forwarding && index == last,
            host_key: slot.clone(),
            clock: clock.clone(),
            routes: (index == last).then(|| routes.clone()),
        };
        let cfg = config(opts, &hop.algorithms);

        let handshake = async {
            match jumps.last() {
                None => {
                    let stream = match &opts.proxy {
                        Some(p) => connect_via(p, &hop.host, hop.port).await?,
                        None => TcpStream::connect((hop.host.as_str(), hop.port))
                            .await
                            .map_err(|e| resolve_or_connect_error(e, &hop.host, &target))?,
                    };
                    client::connect_stream(cfg, stream, handler)
                        .await
                        .map_err(|e| SshError::from_russh(e, &target))
                }
                Some(prev) => {
                    let channel = prev
                        .channel_open_direct_tcpip(
                            hop.host.clone(),
                            u32::from(hop.port),
                            "127.0.0.1",
                            0,
                        )
                        .await
                        .map_err(|e| SshError::Connect {
                            target: target.clone(),
                            message: format!("the jump host could not open a tunnel ({e})"),
                        })?;
                    client::connect_stream(cfg, channel.into_stream(), handler)
                        .await
                        .map_err(|e| SshError::from_russh(e, &target))
                }
            }
        };
        let timed_out = || SshError::Timeout {
            target: target.clone(),
        };
        let mut handle = clock
            .timeout(timeout, handshake)
            .await
            .map_err(|_| timed_out())??;

        interact.progress(Progress::Authenticating {
            index,
            user: hop.username.clone(),
            target: target.clone(),
        });
        let prompts = PausingInteract {
            inner: interact.as_ref(),
            clock: &clock,
        };
        clock
            .timeout(timeout, authenticate(&mut handle, hop, &prompts))
            .await
            .map_err(|_| timed_out())??;
        host_key = slot.lock().await.clone();
        jumps.push(handle);
    }

    let handle = jumps
        .pop()
        .ok_or_else(|| SshError::Protocol("no destination given".into()))?;
    Ok(Connection {
        _jumps: jumps,
        handle,
        host_key,
        target: opts.hops[last].target(),
        routes,
    })
}

/// Forwards prompts to the user with the connect timeout paused.
struct PausingInteract<'a> {
    inner: &'a dyn Interact,
    clock: &'a PromptClock,
}

impl PausingInteract<'_> {
    async fn prompt(&self, p: Prompt) -> Option<Vec<SecretString>> {
        self.clock.pause_during(self.inner.prompt(p)).await
    }
}

fn resolve_or_connect_error(e: std::io::Error, host: &str, target: &str) -> SshError {
    // getaddrinfo failures surface as `Other`/`Uncategorized` with a resolver message.
    let msg = e.to_string().to_lowercase();
    if msg.contains("lookup")
        || msg.contains("name or service not known")
        || msg.contains("nodename")
    {
        SshError::Resolve {
            host: host.to_owned(),
        }
    } else {
        connect_error(e, target)
    }
}

fn remaining(methods: &russh::MethodSet) -> Vec<String> {
    methods
        .iter()
        .map(|m| String::from(<&str>::from(m)))
        .collect()
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    hop: &Hop,
    interact: &PausingInteract<'_>,
) -> Result<(), SshError> {
    let target = hop.target();
    let mut left: Vec<String> = Vec::new();
    for method in &hop.auth {
        let outcome = match method {
            AuthMethod::Agent => auth_agent(handle, hop).await?,
            AuthMethod::KeyFile { path, passphrase } => {
                let label = path.display().to_string();
                let data = std::fs::read_to_string(path).map_err(|e| SshError::Key {
                    path: label.clone(),
                    message: e.to_string(),
                })?;
                auth_key(handle, hop, &label, &data, passphrase.as_ref(), interact).await?
            }
            AuthMethod::KeyData {
                label,
                data,
                passphrase,
            } => {
                auth_key(
                    handle,
                    hop,
                    label,
                    data.expose(),
                    passphrase.as_ref(),
                    interact,
                )
                .await?
            }
            AuthMethod::KeyboardInteractive => auth_kbd(handle, hop, interact).await?,
            AuthMethod::Password { password } => {
                let password = match password {
                    Some(p) => p.clone(),
                    None => {
                        let answers = interact
                            .prompt(Prompt::Password {
                                user: hop.username.clone(),
                                target: target.clone(),
                            })
                            .await
                            .ok_or(SshError::AuthCancelled)?;
                        answers
                            .into_iter()
                            .next()
                            .unwrap_or_else(|| SecretString::from(""))
                    }
                };
                handle
                    .authenticate_password(hop.username.clone(), password.expose())
                    .await
                    .map_err(|e| SshError::from_russh(e, &target))?
            }
        };
        match outcome {
            AuthResult::Success => return Ok(()),
            AuthResult::Failure {
                remaining_methods, ..
            } => left = remaining(&remaining_methods),
        }
    }
    Err(SshError::AuthFailed {
        user: hop.username.clone(),
        target,
        remaining: left,
    })
}

/// Pick the RSA signature hash: the best the server advertises; SHA-1 only if allowed.
async fn rsa_hash(handle: &Handle<ClientHandler>, hop: &Hop) -> Option<Option<HashAlg>> {
    let legacy = hop.algorithms.allows(LegacyAlgorithm::SshRsaSha1);
    match handle.best_supported_rsa_hash().await {
        Ok(Some(Some(h))) => Some(Some(h)),
        // Server only accepts ssh-rsa (SHA-1).
        Ok(Some(None)) => legacy.then_some(None),
        // No server-sig-algs extension: old servers usually only know ssh-rsa.
        Ok(None) | Err(_) => Some(if legacy { None } else { Some(HashAlg::Sha256) }),
    }
}

async fn auth_key(
    handle: &mut Handle<ClientHandler>,
    hop: &Hop,
    label: &str,
    data: &str,
    passphrase: Option<&SecretString>,
    interact: &PausingInteract<'_>,
) -> Result<AuthResult, SshError> {
    let key_err = |e: russh::keys::Error| SshError::Key {
        path: label.to_owned(),
        message: e.to_string(),
    };
    let key = match russh::keys::decode_secret_key(data, passphrase.map(|p| p.expose())) {
        Ok(k) => k,
        Err(russh::keys::Error::KeyIsEncrypted) if passphrase.is_none() => {
            let answer = interact
                .prompt(Prompt::Passphrase {
                    key: label.to_owned(),
                })
                .await
                .ok_or(SshError::AuthCancelled)?;
            let pass = answer
                .into_iter()
                .next()
                .unwrap_or_else(|| SecretString::from(""));
            russh::keys::decode_secret_key(data, Some(pass.expose())).map_err(key_err)?
        }
        Err(e) => return Err(key_err(e)),
    };
    let hash = if key.algorithm().is_rsa() {
        match rsa_hash(handle, hop).await {
            Some(h) => h,
            None => {
                return Ok(AuthResult::Failure {
                    remaining_methods: russh::MethodSet::empty(),
                    partial_success: false,
                })
            }
        }
    } else {
        None
    };
    let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
    handle
        .authenticate_publickey(hop.username.clone(), key)
        .await
        .map_err(|e| SshError::from_russh(e, &hop.target()))
}

#[cfg(unix)]
async fn auth_agent(handle: &mut Handle<ClientHandler>, hop: &Hop) -> Result<AuthResult, SshError> {
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| SshError::Agent(e.to_string()))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| SshError::Agent(e.to_string()))?;
    let mut last = AuthResult::Failure {
        remaining_methods: russh::MethodSet::empty(),
        partial_success: false,
    };
    for id in identities {
        let key = id.public_key().into_owned();
        let hash = if key.algorithm().is_rsa() {
            match rsa_hash(handle, hop).await {
                Some(h) => h,
                None => continue,
            }
        } else {
            None
        };
        last = handle
            .authenticate_publickey_with(hop.username.clone(), key, hash, &mut agent)
            .await
            .map_err(|e| SshError::Agent(e.to_string()))?;
        if matches!(last, AuthResult::Success) {
            break;
        }
    }
    Ok(last)
}

#[cfg(not(unix))]
async fn auth_agent(_: &mut Handle<ClientHandler>, _: &Hop) -> Result<AuthResult, SshError> {
    Err(SshError::Agent("not supported on this platform".into()))
}

async fn auth_kbd(
    handle: &mut Handle<ClientHandler>,
    hop: &Hop,
    interact: &PausingInteract<'_>,
) -> Result<AuthResult, SshError> {
    let target = hop.target();
    let map = |e| SshError::from_russh(e, &target);
    let mut response = handle
        .authenticate_keyboard_interactive_start(hop.username.clone(), None)
        .await
        .map_err(map)?;
    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(AuthResult::Success),
            KeyboardInteractiveAuthResponse::Failure {
                remaining_methods,
                partial_success,
            } => {
                return Ok(AuthResult::Failure {
                    remaining_methods,
                    partial_success,
                })
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let answers: Vec<String> = if prompts.is_empty() {
                    Vec::new()
                } else {
                    interact
                        .prompt(Prompt::KeyboardInteractive {
                            user: hop.username.clone(),
                            target: target.clone(),
                            name,
                            instructions,
                            prompts: prompts
                                .into_iter()
                                .map(|p| crate::interact::InteractivePrompt {
                                    text: p.prompt,
                                    echo: p.echo,
                                })
                                .collect(),
                        })
                        .await
                        .ok_or(SshError::AuthCancelled)?
                        .iter()
                        .map(|s| s.expose().to_owned())
                        .collect()
                };
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(map)?;
            }
        }
    }
}
