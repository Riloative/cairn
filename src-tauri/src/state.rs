//! Shared application state managed by Tauri.

use crate::audit_queue::AuditQueue;
use crate::prompts::PromptBroker;
use cairn_core::Vault;
use cairn_proto_ssh::ConnectOptions;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
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
    pub ssh_connections: Mutex<HashMap<String, Arc<ConnectOptions>>>,
}

impl AppState {
    pub fn new(vault: Vault) -> Self {
        Self {
            vault: Arc::new(Mutex::new(vault)),
            last_activity: Arc::new(Mutex::new(SystemTime::now())),
            prompts: Arc::new(PromptBroker::default()),
            audit: Arc::new(AuditQueue::default()),
            ssh_connections: Mutex::new(HashMap::new()),
        }
    }

    pub fn touch(&self) {
        *self.last_activity.lock() = SystemTime::now();
    }
}
