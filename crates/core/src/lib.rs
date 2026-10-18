//! Cairn core: domain models, database, vault, audit log and settings.
//!
//! This crate has no UI dependency. The Tauri layer (`src-tauri`) calls into it and maps
//! [`UserFacingError`] values to messages shown in the frontend.

pub mod error;
pub mod protocol;

pub use error::UserFacingError;
pub use protocol::Protocol;

/// Product name used in paths, window titles and audit entries.
pub const APP_NAME: &str = "Cairn";

/// Version of the core crate (kept in lockstep with the app version).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
