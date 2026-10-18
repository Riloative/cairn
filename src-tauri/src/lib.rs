//! Tauri application layer for Cairn.
//!
//! This crate is intentionally thin: commands validate input, call into the `cairn-*`
//! crates and map their errors to user-facing payloads.

mod commands;

/// Build and run the Tauri application.
pub fn run() {
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::app::app_info])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        // Nothing to recover to: the webview could not start.
        eprintln!("Cairn failed to start: {err}");
        std::process::exit(1);
    }
}
