//! Cairn core: domain models, database, vault, audit log and settings.
//!
//! This crate has no UI dependency. The Tauri layer (`src-tauri`) calls into it and maps
//! [`UserFacingError`] values to messages shown in the frontend.

pub mod audit;
pub mod db;
pub mod diff;
pub mod error;
pub mod kdf;
pub mod protocol;
pub mod secret;
pub mod settings;
pub mod vault;

pub use error::{CoreError, ErrorPayload, UserFacingError};
pub use protocol::Protocol;
pub use secret::SecretString;
pub use vault::{Vault, VaultStatus};

/// Product name used in paths, window titles and audit entries.
pub const APP_NAME: &str = "Cairn";

/// Version of the core crate (kept in lockstep with the app version).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
