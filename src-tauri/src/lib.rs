//! Tauri application layer for Cairn.
//!
//! This crate is intentionally thin: commands validate input, call into the `cairn-*`
//! crates and map their errors to user-facing payloads.

mod autolock;
mod commands;
mod error;
mod sessions;
mod state;

use cairn_core::Vault;
use tauri::Manager;

/// Build and run the Tauri application.
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(state::AppState::new(Vault::new(dir)));
            app.manage(sessions::SessionManager::new());
            autolock::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::app::ui_log_error,
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
            commands::session::session_open_local,
            commands::session::session_write,
            commands::session::session_resize,
            commands::session::session_close,
            commands::session::local_containers,
            commands::session::local_default_shell,
            commands::terminal::terminal_prefs_get,
            commands::terminal::terminal_prefs_update,
        ])
        .build(tauri::generate_context!())
        .map(|app| {
            app.run(|handle, event| {
                if let tauri::RunEvent::Exit = event {
                    // Kill child shells and drop connections before the process exits.
                    handle
                        .state::<std::sync::Arc<sessions::SessionManager>>()
                        .close_all();
                }
            })
        });
    if let Err(err) = result {
        // Nothing to recover to: the webview could not start.
        eprintln!("Cairn failed to start: {err}");
        std::process::exit(1);
    }
}
