//! Typed application settings stored in the encrypted database.

use crate::audit::{self, AuditEvent};
use crate::diff;
use crate::error::CoreError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// App theme. `System` follows the OS light/dark preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Midnight,
    Graphite,
    Obsidian,
    Paper,
    Porcelain,
    Sand,
}

/// All user settings. New fields must have serde defaults so older databases load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub theme: Theme,
    /// Dark theme used when `theme` is `System` and the OS is in dark mode.
    pub system_dark_theme: Theme,
    /// Light theme used when `theme` is `System` and the OS is in light mode.
    pub system_light_theme: Theme,
    /// Lock after this many idle minutes; 0 disables idle locking.
    pub auto_lock_minutes: u32,
    pub lock_on_sleep: bool,
    pub sidebar_collapsed: bool,
    pub reduce_motion: bool,
    /// Also trust keys found in `~/.ssh/known_hosts` (read-only).
    pub read_openssh_known_hosts: bool,
    /// Desktop notification when a session drops unexpectedly.
    pub notify_on_disconnect: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            system_dark_theme: Theme::Midnight,
            system_light_theme: Theme::Paper,
            auto_lock_minutes: 15,
            lock_on_sleep: true,
            sidebar_collapsed: false,
            reduce_motion: false,
            read_openssh_known_hosts: true,
            notify_on_disconnect: true,
        }
    }
}

/// Longest idle timeout we accept (24 h).
pub const MAX_AUTO_LOCK_MINUTES: u32 = 24 * 60;

const DARK: [Theme; 3] = [Theme::Midnight, Theme::Graphite, Theme::Obsidian];
const LIGHT: [Theme; 3] = [Theme::Paper, Theme::Porcelain, Theme::Sand];

impl Settings {
    pub fn validate(&self) -> Result<(), CoreError> {
        if self.auto_lock_minutes > MAX_AUTO_LOCK_MINUTES {
            return Err(CoreError::Validation(format!(
                "Auto-lock must be between 0 (off) and {MAX_AUTO_LOCK_MINUTES} minutes."
            )));
        }
        if !DARK.contains(&self.system_dark_theme) {
            return Err(CoreError::Validation(
                "The theme used for dark mode must be a dark theme.".into(),
            ));
        }
        if !LIGHT.contains(&self.system_light_theme) {
            return Err(CoreError::Validation(
                "The theme used for light mode must be a light theme.".into(),
            ));
        }
        Ok(())
    }
}

const KEY: &str = "app";

/// Load settings, falling back to defaults when none are stored.
pub fn load(conn: &Connection) -> Result<Settings, CoreError> {
    load_doc(conn, KEY)
}

/// Validate and save settings, auditing a field-level diff. Returns the saved settings.
pub fn save(conn: &Connection, new: &Settings) -> Result<Settings, CoreError> {
    new.validate()?;
    save_doc(conn, KEY, None, new)
}

/// Load a JSON settings document stored under `key`, or its default.
pub fn load_doc<T: DeserializeOwned + Default>(
    conn: &Connection,
    key: &str,
) -> Result<T, CoreError> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?;
    match raw {
        Some(json) => Ok(serde_json::from_str(&json)?),
        None => Ok(T::default()),
    }
}

/// Save a settings document and audit the changed fields (prefixed with `prefix.` when
/// given). Callers validate first. Unchanged documents are not written or audited.
pub fn save_doc<T: Serialize + DeserializeOwned + Default + Clone>(
    conn: &Connection,
    key: &str,
    prefix: Option<&str>,
    new: &T,
) -> Result<T, CoreError> {
    let old: T = load_doc(conn, key)?;
    let mut changes = diff::diff(&old, new)?;
    if changes.is_empty() {
        return Ok(old);
    }
    if let Some(prefix) = prefix {
        for c in &mut changes {
            c.field = format!("{prefix}.{}", c.field);
        }
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, serde_json::to_string(new)?],
    )?;
    audit::append(&tx, &AuditEvent::SettingsChanged { changes })?;
    tx.commit()?;
    Ok(new.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use zeroize::Zeroizing;

    fn conn() -> Connection {
        db::open_in_memory(&Zeroizing::new([9u8; 32])).expect("db")
    }

    #[test]
    fn defaults_when_empty() {
        let s = load(&conn()).expect("load");
        assert_eq!(s, Settings::default());
        assert_eq!(s.auto_lock_minutes, 15);
        assert!(s.lock_on_sleep);
    }

    #[test]
    fn save_persists_and_audits_the_diff() {
        let c = conn();
        let new = Settings {
            theme: Theme::Sand,
            auto_lock_minutes: 5,
            ..Default::default()
        };
        save(&c, &new).expect("save");
        assert_eq!(load(&c).expect("load"), new);
        let entries = audit::recent(&c, 10).expect("audit");
        assert_eq!(entries.len(), 1);
        let changes = entries[0].payload["changes"].as_array().expect("changes");
        let fields: Vec<&str> = changes.iter().filter_map(|c| c["field"].as_str()).collect();
        assert_eq!(fields, ["autoLockMinutes", "theme"]);
    }

    #[test]
    fn unchanged_save_is_not_audited() {
        let c = conn();
        save(&c, &Settings::default()).expect("save");
        assert!(audit::recent(&c, 10).expect("audit").is_empty());
    }

    #[test]
    fn validation_rejects_bad_values() {
        let c = conn();
        let too_long = Settings {
            auto_lock_minutes: MAX_AUTO_LOCK_MINUTES + 1,
            ..Default::default()
        };
        assert!(matches!(save(&c, &too_long), Err(CoreError::Validation(_))));
        let wrong_kind = Settings {
            system_dark_theme: Theme::Paper,
            ..Default::default()
        };
        assert!(matches!(
            save(&c, &wrong_kind),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn missing_fields_take_defaults() {
        let s: Settings = serde_json::from_str(r#"{"theme":"graphite"}"#).expect("parse");
        assert_eq!(s.theme, Theme::Graphite);
        assert_eq!(s.auto_lock_minutes, 15);
    }
}
