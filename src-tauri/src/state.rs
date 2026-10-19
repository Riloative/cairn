//! Shared application state managed by Tauri.

use crate::audit_queue::AuditQueue;
use crate::commands::ssh::SshTarget;
use crate::prompts::PromptBroker;
use cairn_core::Vault;
use cairn_proto_ssh::connect::Connection;
use cairn_proto_ssh::{SshError, SshSession};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::SystemTime;

#[derive(Debug)]
pub struct AppState {
    pub vault: Arc<Mutex<Vault>>,
    /// Wall-clock time of the last user input reported by the frontend.
    pub last_activity: Arc<Mutex<SystemTime>>,
    pub prompts: Arc<PromptBroker>,
    pub audit: Arc<AuditQueue>,
    /// SSH connection options per open tab, kept (secrets zeroized on drop) so a dropped
    /// session can be reconnected without the frontend holding credentials.
    pub ssh_connections: Mutex<HashMap<String, Arc<SshTarget>>>,
    /// Open SSH sessions by session id, for SFTP, port forwards and config grab on
    /// their connection. Weak: the session manager owns them.
    pub ssh_sessions: Mutex<HashMap<String, Weak<SshSession>>>,
}

impl AppState {
    pub fn new(vault: Vault) -> Self {
        Self {
            vault: Arc::new(Mutex::new(vault)),
            last_activity: Arc::new(Mutex::new(SystemTime::now())),
            prompts: Arc::new(PromptBroker::default()),
            audit: Arc::new(AuditQueue::default()),
            ssh_connections: Mutex::new(HashMap::new()),
            ssh_sessions: Mutex::new(HashMap::new()),
        }
    }

    /// The live connection of an SSH session.
    pub fn ssh_connection(&self, session_id: &str) -> Result<Arc<Connection>, SshError> {
        let mut sessions = self.ssh_sessions.lock();
        sessions.retain(|_, s| s.strong_count() > 0);
        sessions
            .get(session_id)
            .and_then(Weak::upgrade)
            .and_then(|s| s.connection())
            .ok_or(SshError::NotConnected)
    }

    pub fn touch(&self) {
        *self.last_activity.lock() = SystemTime::now();
    }
}
