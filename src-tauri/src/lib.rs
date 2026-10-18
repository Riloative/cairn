//! Tauri application layer for Cairn.
//!
//! This crate is intentionally thin: commands validate input, call into the `cairn-*`
//! crates and map their errors to user-facing payloads.

mod audit_queue;
mod autolock;
mod commands;
mod error;
mod prompts;
mod sessions;
mod state;

use cairn_core::Vault;
use tauri::Manager;

/// Build and run the Tauri application.
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(state::AppState::new(Vault::new(dir)));
            app.manage(sessions::SessionManager::new());
            app.manage(commands::serial::PortWatcher::default());
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
            commands::session::session_prompt_reply,
            commands::session::session_break,
            commands::serial::serial_ports,
            commands::serial::serial_ports_watch,
            commands::serial::serial_ports_unwatch,
            commands::serial::serial_open,
            commands::serial::serial_set_lines,
            commands::serial::serial_send_files,
            commands::serial::serial_receive_files,
            commands::serial::serial_transfer_cancel,
            commands::telnet::telnet_open,
            commands::ssh::ssh_open,
            commands::ssh::ssh_reconnect,
            commands::ssh::ssh_forget,
            commands::ssh::known_hosts_list,
            commands::ssh::known_hosts_remove,
            commands::inventory::inventory_snapshot,
            commands::inventory::location_save,
            commands::inventory::location_delete,
            commands::inventory::vendor_add,
            commands::inventory::device_save,
            commands::inventory::device_delete,
            commands::inventory::device_duplicate,
            commands::inventory::interfaces_list,
            commands::inventory::interface_save,
            commands::inventory::interfaces_bulk_create,
            commands::inventory::interfaces_delete,
            commands::inventory::interfaces_expand,
            commands::inventory::vlan_save,
            commands::inventory::vlan_delete,
            commands::inventory::field_save,
            commands::inventory::field_delete,
            commands::inventory::view_save,
            commands::inventory::view_delete,
            commands::inventory::credential_save,
            commands::inventory::credential_delete,
            commands::inventory::credential_reveal,
            commands::inventory::credential_copy,
            commands::devices::device_connect,
            commands::map::map_snapshot,
            commands::map::link_save,
            commands::map::link_delete,
            commands::map::map_positions_save,
            commands::map::zone_save,
            commands::map::zone_delete,
            commands::map::map_prefs_update,
            commands::map::floor_plan_image,
            commands::map::floor_plan_upload,
            commands::map::floor_plan_place,
            commands::map::floor_plan_delete,
            commands::map::map_export,
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
