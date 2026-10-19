//! Bridges an RDP session to the UI and applies the certificate policy.
//!
//! Frames and cursor bitmaps go out on a binary channel; lifecycle events and prompts
//! on a JSON channel. Server certificates are pinned in Cairn's known-hosts store
//! (key type `x509`): a trusted certificate is accepted silently, an unknown one is
//! offered for trust-on-first-use, a changed one gets the full warning. Decisions and
//! session start/end are audited.

use super::ssh::TauriInteract;
use super::{SessionMessage, SessionOutput};
use crate::audit_queue::AuditQueue;
use crate::prompts::{PromptAnswer, PromptBroker};
use cairn_core::audit::AuditEvent;
use cairn_core::known_hosts::{self, HostKeyStatus};
use cairn_core::{SecretString, Vault};
use cairn_proto_rdp::{cert, CertInfo, Dialer, RdpError, RdpEvent, RdpInteract, Transport};
use cairn_proto_ssh::{ConnectOptions, HostKeyInfo, HostKeyVerdict, Interact, Progress, Prompt};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::Serialize;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Instant;
use tauri::ipc::{Channel, InvokeResponseBody};

/// Messages on an RDP session's JSON channel.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RdpMessage {
    Event {
        event: RdpEvent,
    },
    /// The server certificate needs the user's decision; answer with
    /// `session_prompt_reply` (`hostKey`).
    #[serde(rename_all = "camelCase")]
    Certificate {
        prompt_id: u64,
        cert: CertInfo,
        status: HostKeyStatus,
    },
    /// No stored password: ask for one (`secrets` with one value).
    #[serde(rename_all = "camelCase")]
    Credentials {
        prompt_id: u64,
        username: String,
        target: String,
    },
    /// SSH tunnel progress, host key and authentication prompts.
    Ssh {
        message: SessionMessage,
    },
}

/// Audit labels for the session.
#[derive(Debug, Clone)]
pub struct RdpContext {
    pub session_id: String,
    pub target: String,
    pub username: String,
    pub device: Option<String>,
}

pub struct TauriRdp {
    pub frames: Channel<InvokeResponseBody>,
    pub events: Channel<RdpMessage>,
    pub broker: Arc<PromptBroker>,
    pub vault: Arc<Mutex<Vault>>,
    pub audit: Arc<AuditQueue>,
    pub ctx: RdpContext,
    /// Called once when the session has ended (drops it from the registry).
    pub on_closed: Box<dyn Fn() + Send + Sync>,
    /// Fingerprint accepted for this connection, for the session-start entry.
    fingerprint: Mutex<Option<String>>,
    started: Mutex<Option<Instant>>,
}

impl std::fmt::Debug for TauriRdp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TauriRdp").field("ctx", &self.ctx).finish()
    }
}

impl TauriRdp {
    pub fn new(
        frames: Channel<InvokeResponseBody>,
        events: Channel<RdpMessage>,
        broker: Arc<PromptBroker>,
        vault: Arc<Mutex<Vault>>,
        audit: Arc<AuditQueue>,
        ctx: RdpContext,
        on_closed: Box<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            frames,
            events,
            broker,
            vault,
            audit,
            ctx,
            on_closed,
            fingerprint: Mutex::new(None),
            started: Mutex::new(None),
        }
    }

    fn send(&self, msg: RdpMessage) {
        // The webview may be gone (window closing); nothing to deliver then.
        let _ = self.events.send(msg);
    }
}

/// Look the certificate up; `None` if the vault is locked.
fn stored_status(vault: &Mutex<Vault>, cert: &CertInfo) -> Option<HostKeyStatus> {
    vault
        .lock()
        .with_conn(|c| {
            let known = known_hosts::lookup(c, &cert.host, cert.port)?;
            let status = known_hosts::status(&known, cert::KEY_TYPE, &cert.digest);
            if status == HostKeyStatus::Trusted {
                known_hosts::touch(c, &cert.host, cert.port, cert::KEY_TYPE)?;
            }
            Ok(status)
        })
        .ok()
}

fn trust(vault: &Mutex<Vault>, cert: &CertInfo) -> bool {
    vault
        .lock()
        .with_conn(|c| {
            known_hosts::trust(
                c,
                &cert.host,
                cert.port,
                cert::KEY_TYPE,
                &cert.fingerprint,
                &cert.digest,
            )
        })
        .is_ok()
}

impl RdpInteract for TauriRdp {
    fn certificate(&self, cert: CertInfo) -> BoxFuture<'static, bool> {
        let (events, broker, vault, audit) = (
            self.events.clone(),
            self.broker.clone(),
            self.vault.clone(),
            self.audit.clone(),
        );
        *self.fingerprint.lock() = Some(cert.fingerprint.clone());
        Box::pin(async move {
            let Some(status) = stored_status(&vault, &cert) else {
                // Locked mid-connect: never trust silently.
                return false;
            };
            if status == HostKeyStatus::Trusted {
                return true;
            }
            let (guard, rx) = broker.register();
            let _ = events.send(RdpMessage::Certificate {
                prompt_id: guard.id,
                cert: cert.clone(),
                status: status.clone(),
            });
            let accepted = matches!(rx.await, Ok(PromptAnswer::HostKey { accept: true }));
            drop(guard);
            if accepted && trust(&vault, &cert) {
                true
            } else {
                audit.record(
                    &vault,
                    AuditEvent::HostKeyRejected {
                        host: cert.host.clone(),
                        port: cert.port,
                        fingerprint: cert.fingerprint.clone(),
                        changed: matches!(status, HostKeyStatus::Changed { .. }),
                    },
                );
                false
            }
        })
    }

    fn event(&self, event: RdpEvent) {
        match &event {
            RdpEvent::Connected { .. } => {
                *self.started.lock() = Some(Instant::now());
                self.audit.record(
                    &self.vault,
                    AuditEvent::SessionStarted {
                        session_id: self.ctx.session_id.clone(),
                        protocol: "rdp".into(),
                        target: self.ctx.target.clone(),
                        username: Some(self.ctx.username.clone()),
                        device: self.ctx.device.clone(),
                        host_key_fingerprint: self.fingerprint.lock().clone(),
                    },
                );
            }
            RdpEvent::Closed { graceful, message } => {
                // Only sessions that got a desktop have a start entry to close.
                if let Some(started) = self.started.lock().take() {
                    self.audit.record(
                        &self.vault,
                        AuditEvent::SessionEnded {
                            session_id: self.ctx.session_id.clone(),
                            protocol: "rdp".into(),
                            target: self.ctx.target.clone(),
                            duration_secs: started.elapsed().as_secs(),
                            reason: if *graceful {
                                "closed".into()
                            } else {
                                format!("error: {message}")
                            },
                        },
                    );
                }
                (self.on_closed)();
            }
            _ => {}
        }
        self.send(RdpMessage::Event { event });
    }

    fn frame(&self, message: Vec<u8>) {
        let _ = self.frames.send(InvokeResponseBody::Raw(message));
    }
}

/// Ask the user for the RDP password. `None` when cancelled.
pub async fn ask_password(
    events: &Channel<RdpMessage>,
    broker: &PromptBroker,
    username: &str,
    target: &str,
) -> Option<SecretString> {
    let (guard, rx) = broker.register();
    let _ = events.send(RdpMessage::Credentials {
        prompt_id: guard.id,
        username: username.to_owned(),
        target: target.to_owned(),
    });
    let answer = rx.await;
    drop(guard);
    match answer {
        Ok(PromptAnswer::Secrets { mut values }) if !values.is_empty() => Some(values.remove(0)),
        _ => None,
    }
}

/// Relays the tunnel's SSH questions and progress onto the RDP channel.
struct TunnelOutput(Channel<RdpMessage>);

impl SessionOutput for TunnelOutput {
    fn data(&self, _: Vec<u8>) {}

    fn message(&self, message: SessionMessage) {
        let _ = self.0.send(RdpMessage::Ssh { message });
    }
}

/// The tunnel's SSH interaction: host keys and prompts as for any SSH session, but no
/// banner and no session audit of its own (the RDP session is audited).
struct TunnelInteract(TauriInteract);

impl Interact for TunnelInteract {
    fn host_key(&self, info: HostKeyInfo) -> BoxFuture<'static, HostKeyVerdict> {
        self.0.host_key(info)
    }

    fn prompt(&self, prompt: Prompt) -> BoxFuture<'static, Option<Vec<SecretString>>> {
        self.0.prompt(prompt)
    }

    fn banner(&self, _: String) {}

    fn progress(&self, progress: Progress) {
        self.0.output.message(SessionMessage::Progress { progress });
    }
}

/// Where the tunnel's SSH progress and prompts go: the RDP session's event channel.
pub fn tunnel_output(events: Channel<RdpMessage>) -> Arc<dyn SessionOutput> {
    Arc::new(TunnelOutput(events))
}

/// Dial the RDP server through an SSH connection (`direct-tcpip`). `ssh` answers the
/// tunnel's host-key and authentication questions (output from [`tunnel_output`]). The
/// SSH connection lives as long as the RDP stream.
pub fn tunnel_dialer(opts: ConnectOptions, host: String, port: u16, ssh: TauriInteract) -> Dialer {
    Box::pin(async move {
        let interact = Arc::new(TunnelInteract(ssh));
        let conn = cairn_proto_ssh::connect::connect(&opts, interact)
            .await
            .map_err(|e| RdpError::Tunnel(e.to_string()))?;
        let channel = conn
            .handle
            .channel_open_direct_tcpip(host.clone(), u32::from(port), "127.0.0.1", 0)
            .await
            .map_err(|e| {
                RdpError::Tunnel(format!(
                    "the SSH server could not reach {host}:{port} ({e})"
                ))
            })?;
        // The SSH channel stream is not `Sync`; bridge it through an in-memory pipe.
        let (ours, theirs) = tokio::io::duplex(256 * 1024);
        tokio::spawn(async move {
            let _conn = conn;
            let mut remote = channel.into_stream();
            let mut theirs = theirs;
            let _ = tokio::io::copy_bidirectional(&mut remote, &mut theirs).await;
        });
        let local = SocketAddr::from((Ipv4Addr::LOCALHOST, 0));
        Ok((Box::new(ours) as Transport, local))
    })
}
