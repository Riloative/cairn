//! Shared application state managed by Tauri.

use cairn_core::Vault;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::SystemTime;

#[derive(Debug)]
pub struct AppState {
    pub vault: Arc<Mutex<Vault>>,
    /// Wall-clock time of the last user input reported by the frontend.
    pub last_activity: Arc<Mutex<SystemTime>>,
}

impl AppState {
    pub fn new(vault: Vault) -> Self {
        Self {
            vault: Arc::new(Mutex::new(vault)),
            last_activity: Arc::new(Mutex::new(SystemTime::now())),
        }
    }

    pub fn touch(&self) {
        *self.last_activity.lock() = SystemTime::now();
    }
}
