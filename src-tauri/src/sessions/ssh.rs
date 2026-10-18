//! Bridges the SSH engine's questions to the UI and applies the host-key policy:
//!
//! 1. A key trusted in Cairn's own store is accepted silently.
//! 2. Otherwise, if enabled, a matching entry in `~/.ssh/known_hosts` is accepted and
//!    imported into Cairn's store (audited).
//! 3. Otherwise the user decides: trust-on-first-use for unknown keys, a full-screen
//!    warning (type "accept") for changed keys. Decisions are audited.

use super::{SessionMessage, SessionOutput};
use crate::audit_queue::AuditQueue;
use crate::prompts::{PromptAnswer, PromptBroker};
use cairn_core::audit::AuditEvent;
use cairn_core::known_hosts::{self, HostKeyStatus};
use cairn_core::{settings, SecretString, Vault};
use cairn_proto_ssh::hostkey::{default_openssh_known_hosts, lookup_openssh_known_hosts};
use cairn_proto_ssh::{HostKeyInfo, HostKeyVerdict, Interact, OpenSshLookup, Progress, Prompt};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use std::sync::Arc;

/// Per-session context for audit entries.
#[derive(Debug, Clone)]
pub struct SessionContext {
    pub session_id: String,
    pub target: String,
    pub username: String,
    pub device: Option<String>,
}

pub struct TauriInteract {
    pub output: Arc<dyn SessionOutput>,
    pub broker: Arc<PromptBroker>,
    pub vault: Arc<Mutex<Vault>>,
    pub audit: Arc<AuditQueue>,
    pub ctx: SessionContext,
}

impl std::fmt::Debug for TauriInteract {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TauriInteract")
            .field("ctx", &self.ctx)
            .finish()
    }
}

/// Look the key up in Cairn's store; `None` if the vault is locked.
fn stored_status(vault: &Mutex<Vault>, info: &HostKeyInfo) -> Option<HostKeyStatus> {
    vault
        .lock()
        .with_conn(|c| {
            let known = known_hosts::lookup(c, &info.host, info.port)?;
            let status = known_hosts::status(&known, &info.key_type, &info.public_key);
            if status == HostKeyStatus::Trusted {
                known_hosts::touch(c, &info.host, info.port, &info.key_type)?;
            }
            Ok(status)
        })
        .ok()
}

fn openssh_status(vault: &Mutex<Vault>, info: &HostKeyInfo) -> OpenSshLookup {
    let enabled = vault
        .lock()
        .with_conn(settings::load)
        .map(|s| s.read_openssh_known_hosts)
        .unwrap_or(false);
    let (Some(path), true) = (default_openssh_known_hosts(), enabled) else {
        return OpenSshLookup::Unknown;
    };
    match russh_key(&info.public_key) {
        Some(key) => lookup_openssh_known_hosts(&path, &info.host, info.port, &key),
        None => OpenSshLookup::Unknown,
    }
}

fn russh_key(openssh: &str) -> Option<cairn_proto_ssh::hostkey::PublicKey> {
    cairn_proto_ssh::hostkey::PublicKey::from_openssh(openssh).ok()
}

fn trust(vault: &Mutex<Vault>, info: &HostKeyInfo) -> bool {
    vault
        .lock()
        .with_conn(|c| {
            known_hosts::trust(
                c,
                &info.host,
                info.port,
                &info.key_type,
                &info.fingerprint,
                &info.public_key,
            )
        })
        .is_ok()
}

impl Interact for TauriInteract {
    fn host_key(&self, info: HostKeyInfo) -> BoxFuture<'static, HostKeyVerdict> {
        let (output, broker, vault, audit) = (
            self.output.clone(),
            self.broker.clone(),
            self.vault.clone(),
            self.audit.clone(),
        );
        Box::pin(async move {
            let Some(status) = stored_status(&vault, &info) else {
                // Locked mid-connect: never trust silently.
                return HostKeyVerdict::Reject;
            };
            if status == HostKeyStatus::Trusted {
                return HostKeyVerdict::Accept;
            }
            let openssh = openssh_status(&vault, &info);
            if status == HostKeyStatus::Unknown && openssh == OpenSshLookup::Match {
                return if trust(&vault, &info) {
                    HostKeyVerdict::Accept
                } else {
                    HostKeyVerdict::Reject
                };
            }
            let (guard, rx) = broker.register();
            output.message(SessionMessage::HostKey {
                prompt_id: guard.id,
                info: info.clone(),
                status: status.clone(),
                openssh: match openssh {
                    OpenSshLookup::Match => "match",
                    OpenSshLookup::Mismatch => "mismatch",
                    OpenSshLookup::Unknown => "unknown",
                },
            });
            let accepted = matches!(rx.await, Ok(PromptAnswer::HostKey { accept: true }));
            drop(guard);
            if accepted && trust(&vault, &info) {
                HostKeyVerdict::Accept
            } else {
                audit.record(
                    &vault,
                    AuditEvent::HostKeyRejected {
                        host: info.host.clone(),
                        port: info.port,
                        fingerprint: info.fingerprint.clone(),
                        changed: matches!(status, HostKeyStatus::Changed { .. }),
                    },
                );
                HostKeyVerdict::Reject
            }
        })
    }

    fn prompt(&self, prompt: Prompt) -> BoxFuture<'static, Option<Vec<SecretString>>> {
        let (output, broker) = (self.output.clone(), self.broker.clone());
        Box::pin(async move {
            let (guard, rx) = broker.register();
            output.message(SessionMessage::Prompt {
                prompt_id: guard.id,
                prompt,
            });
            let answer = rx.await;
            drop(guard);
            match answer {
                Ok(PromptAnswer::Secrets { values }) => Some(values),
                _ => None,
            }
        })
    }

    fn banner(&self, text: String) {
        // Banners use bare LF; the terminal needs CRLF.
        let text = text.replace("\r\n", "\n").replace('\n', "\r\n");
        self.output.data(text.into_bytes());
    }

    fn progress(&self, progress: Progress) {
        if let Progress::Connected { host_key } = &progress {
            self.audit.record(
                &self.vault,
                AuditEvent::SessionStarted {
                    session_id: self.ctx.session_id.clone(),
                    protocol: "ssh".into(),
                    target: self.ctx.target.clone(),
                    username: Some(self.ctx.username.clone()),
                    device: self.ctx.device.clone(),
                    host_key_fingerprint: host_key.as_ref().map(|k| k.fingerprint.clone()),
                },
            );
        }
        self.output.message(SessionMessage::Progress { progress });
    }
}
