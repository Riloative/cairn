//! Tauri application layer for Cairn.
//!
//! This crate is intentionally thin: commands validate input, call into the `cairn-*`
//! crates and map their errors to user-facing payloads.

mod autolock;
mod commands;
mod error;
mod state;

use cairn_core::Vault;
use tauri::Manager;

/// Build and run the Tauri application.
pub fn run() {
    let result = tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(state::AppState::new(Vault::new(dir)));
            autolock::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::vault::vault_status,
            commands::vault::vault_setup,
            commands::vault::vault_unlock,
            commands::vault::vault_lock,
            commands::vault::vault_change_password,
            commands::vault::activity_ping,
            commands::settings::settings_get,
            commands::settings::settings_update,
            commands::audit::audit_recent,
            commands::audit::audit_verify,
        ])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        // Nothing to recover to: the webview could not start.
        eprintln!("Cairn failed to start: {err}");
        std::process::exit(1);
    }
}
