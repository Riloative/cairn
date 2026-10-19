//! Credential profiles. Metadata is listed to the UI; secrets (password, private key,
//! key passphrase, enable secret) stay in `credential_secrets` and Rust memory.
//!
//! The only ways a secret leaves this module are [`secrets`] (used by Rust to connect)
//! and [`reveal`] / [`for_copy`], which audit every use.

use super::{gone, record, unique, validate};
use crate::audit::{self, AuditEvent};
use crate::error::CoreError;
use crate::secret::SecretString;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::json;
use zeroize::Zeroizing;

/// What the UI sees: no secret values, only whether each one is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialProfile {
    pub id: i64,
    pub name: String,
    pub username: String,
    pub key_path: Option<String>,
    /// Send `enable` and the enable secret after login when a `>` prompt appears.
    pub auto_enable: bool,
    pub notes: String,
    pub has_password: bool,
    pub has_key_data: bool,
    pub has_key_passphrase: bool,
    pub has_enable_secret: bool,
}

/// How a save treats one secret.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum SecretUpdate {
    #[default]
    Keep,
    Clear,
    Set {
        value: SecretString,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub auto_enable: bool,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub password: SecretUpdate,
    #[serde(default)]
    pub key_data: SecretUpdate,
    #[serde(default)]
    pub key_passphrase: SecretUpdate,
    #[serde(default)]
    pub enable_secret: SecretUpdate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretField {
    Password,
    KeyData,
    KeyPassphrase,
    EnableSecret,
}

impl SecretField {
    const ALL: [SecretField; 4] = [
        SecretField::Password,
        SecretField::KeyData,
        SecretField::KeyPassphrase,
        SecretField::EnableSecret,
    ];

    fn column(self) -> &'static str {
        match self {
            SecretField::Password => "password",
            SecretField::KeyData => "key_data",
            SecretField::KeyPassphrase => "key_passphrase",
            SecretField::EnableSecret => "enable_secret",
        }
    }

    /// Name used in audit entries and messages.
    pub fn label(self) -> &'static str {
        match self {
            SecretField::Password => "password",
            SecretField::KeyData => "private key",
            SecretField::KeyPassphrase => "key passphrase",
            SecretField::EnableSecret => "enable secret",
        }
    }

    fn audit_key(self) -> &'static str {
        match self {
            SecretField::Password => "password",
            SecretField::KeyData => "keyData",
            SecretField::KeyPassphrase => "keyPassphrase",
            SecretField::EnableSecret => "enableSecret",
        }
    }
}

/// A profile's secrets, for connecting. Zeroed on drop.
#[derive(Debug, Clone, Default)]
pub struct Secrets {
    pub password: Option<SecretString>,
    pub key_data: Option<SecretString>,
    pub key_passphrase: Option<SecretString>,
    pub enable_secret: Option<SecretString>,
}

impl Secrets {
    fn get(&self, field: SecretField) -> Option<&SecretString> {
        match field {
            SecretField::Password => self.password.as_ref(),
            SecretField::KeyData => self.key_data.as_ref(),
            SecretField::KeyPassphrase => self.key_passphrase.as_ref(),
            SecretField::EnableSecret => self.enable_secret.as_ref(),
        }
    }
}

const COLS: &str = "SELECT p.id, p.name, p.username, p.key_path, p.auto_enable, p.notes,
    s.password IS NOT NULL, s.key_data IS NOT NULL, s.key_passphrase IS NOT NULL,
    s.enable_secret IS NOT NULL
    FROM credential_profiles p LEFT JOIN credential_secrets s ON s.profile_id = p.id";

fn row(r: &Row<'_>) -> rusqlite::Result<CredentialProfile> {
    Ok(CredentialProfile {
        id: r.get(0)?,
        name: r.get(1)?,
        username: r.get(2)?,
        key_path: r.get(3)?,
        auto_enable: r.get(4)?,
        notes: r.get(5)?,
        has_password: r.get::<_, Option<bool>>(6)?.unwrap_or(false),
        has_key_data: r.get::<_, Option<bool>>(7)?.unwrap_or(false),
        has_key_passphrase: r.get::<_, Option<bool>>(8)?.unwrap_or(false),
        has_enable_secret: r.get::<_, Option<bool>>(9)?.unwrap_or(false),
    })
}

pub fn list(conn: &Connection) -> Result<Vec<CredentialProfile>, CoreError> {
    let mut stmt = conn.prepare(&format!("{COLS} ORDER BY p.name COLLATE NOCASE"))?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<CredentialProfile>, CoreError> {
    Ok(conn
        .query_row(&format!("{COLS} WHERE p.id = ?1"), [id], row)
        .optional()?)
}

fn has(p: &CredentialProfile, field: SecretField) -> bool {
    match field {
        SecretField::Password => p.has_password,
        SecretField::KeyData => p.has_key_data,
        SecretField::KeyPassphrase => p.has_key_passphrase,
        SecretField::EnableSecret => p.has_enable_secret,
    }
}

fn update_of(input: &CredentialInput, field: SecretField) -> &SecretUpdate {
    match field {
        SecretField::Password => &input.password,
        SecretField::KeyData => &input.key_data,
        SecretField::KeyPassphrase => &input.key_passphrase,
        SecretField::EnableSecret => &input.enable_secret,
    }
}

fn check_secret(field: SecretField, value: &SecretString) -> Result<(), CoreError> {
    let s = value.expose();
    if s.is_empty() {
        return Err(CoreError::Validation(format!(
            "The {} is empty; clear it instead.",
            field.label()
        )));
    }
    match field {
        SecretField::KeyData => {
            if s.len() > 64 * 1024 || !s.contains("PRIVATE KEY") {
                return Err(CoreError::Validation(
                    "Paste a private key in OpenSSH or PEM format (-----BEGIN … PRIVATE KEY-----)."
                        .into(),
                ));
            }
        }
        _ if s.len() > 1024 => {
            return Err(CoreError::Validation(format!(
                "The {} is longer than 1024 characters.",
                field.label()
            )));
        }
        _ => {}
    }
    Ok(())
}

/// Audit view of a profile: metadata plus `set` / `changed` markers, never values.
fn audit_view(
    p: &CredentialProfile,
    input: Option<&CredentialInput>,
    old: Option<&CredentialProfile>,
) -> serde_json::Value {
    let mut v = json!({
        "name": p.name,
        "username": p.username,
        "keyPath": p.key_path,
        "autoEnable": p.auto_enable,
        "notes": p.notes,
    });
    for field in SecretField::ALL {
        let replaced = matches!(
            input.map(|i| update_of(i, field)),
            Some(SecretUpdate::Set { .. })
        ) && old.is_some_and(|o| has(o, field));
        let marker = match (has(p, field), replaced) {
            (false, _) => json!(null),
            (true, false) => json!("set"),
            (true, true) => json!("changed"),
        };
        v[field.audit_key()] = marker;
    }
    v
}

pub fn save(conn: &Connection, input: &CredentialInput) -> Result<CredentialProfile, CoreError> {
    let name = validate::name(&input.name, "profile name", 100)?;
    let username = validate::text(&input.username, "username", 255)?;
    let notes = validate::text(&input.notes, "notes", 10_000)?;
    let key_path = match input.key_path.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(p) if p.len() > 1024 || p.chars().any(char::is_control) => {
            return Err(CoreError::Validation("The key path is invalid.".into()))
        }
        Some(p) => Some(p.to_owned()),
    };
    for field in SecretField::ALL {
        if let SecretUpdate::Set { value } = update_of(input, field) {
            check_secret(field, value)?;
        }
    }
    let now = audit::now();
    let tx = conn.unchecked_transaction()?;
    let dup = || format!("A credential profile named {name} already exists.");
    let (old, id) = if input.id == 0 {
        tx.execute(
            "INSERT INTO credential_profiles (name, username, key_path, auto_enable, notes,
             created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![name, username, key_path, input.auto_enable, notes, now],
        )
        .map_err(|e| unique(e, dup))?;
        (None, tx.last_insert_rowid())
    } else {
        let old = get(&tx, input.id)?.ok_or_else(|| gone("credential profile"))?;
        tx.execute(
            "UPDATE credential_profiles SET name = ?2, username = ?3, key_path = ?4,
             auto_enable = ?5, notes = ?6, updated_at = ?7 WHERE id = ?1",
            params![
                input.id,
                name,
                username,
                key_path,
                input.auto_enable,
                notes,
                now
            ],
        )
        .map_err(|e| unique(e, dup))?;
        (Some(old), input.id)
    };
    tx.execute(
        "INSERT OR IGNORE INTO credential_secrets (profile_id) VALUES (?1)",
        [id],
    )?;
    for field in SecretField::ALL {
        let sql = format!(
            "UPDATE credential_secrets SET {} = ?2 WHERE profile_id = ?1",
            field.column()
        );
        match update_of(input, field) {
            SecretUpdate::Keep => {}
            SecretUpdate::Clear => {
                tx.execute(&sql, params![id, Option::<String>::None])?;
            }
            SecretUpdate::Set { value } => {
                tx.execute(&sql, params![id, value.expose()])?;
            }
        }
    }
    let saved = get(&tx, id)?.ok_or_else(|| gone("credential profile"))?;
    let new_view = audit_view(&saved, Some(input), old.as_ref());
    let old_view = old.as_ref().map(|o| audit_view(o, None, None));
    record(
        &tx,
        "credential",
        id,
        &saved.name,
        old_view.as_ref(),
        Some(&new_view),
    )?;
    tx.commit()?;
    Ok(saved)
}

/// Delete a profile and its secrets; devices using it keep existing without one.
pub fn delete(conn: &Connection, id: i64) -> Result<(), CoreError> {
    let tx = conn.unchecked_transaction()?;
    let old = get(&tx, id)?.ok_or_else(|| gone("credential profile"))?;
    // secure_delete is on, so the freed pages are zeroed.
    tx.execute("DELETE FROM credential_profiles WHERE id = ?1", [id])?;
    let view = audit_view(&old, None, None);
    record(&tx, "credential", id, &old.name, Some(&view), None)?;
    tx.commit()?;
    Ok(())
}

fn secret_col(r: &Row<'_>, idx: usize) -> rusqlite::Result<Option<SecretString>> {
    let v: Option<String> = r.get(idx)?;
    Ok(v.map(|s| {
        let s = Zeroizing::new(s);
        SecretString::new(s.as_str().to_owned())
    }))
}

/// Load a profile's secrets for connecting (not audited: connecting is audited itself).
pub fn secrets(conn: &Connection, id: i64) -> Result<Secrets, CoreError> {
    Ok(conn
        .query_row(
            "SELECT password, key_data, key_passphrase, enable_secret
             FROM credential_secrets WHERE profile_id = ?1",
            [id],
            |r| {
                Ok(Secrets {
                    password: secret_col(r, 0)?,
                    key_data: secret_col(r, 1)?,
                    key_passphrase: secret_col(r, 2)?,
                    enable_secret: secret_col(r, 3)?,
                })
            },
        )
        .optional()?
        .unwrap_or_default())
}

fn read_audited(
    conn: &Connection,
    id: i64,
    field: SecretField,
    event: impl FnOnce(i64, String, String) -> AuditEvent,
) -> Result<SecretString, CoreError> {
    let profile = get(conn, id)?.ok_or_else(|| gone("credential profile"))?;
    let secrets = secrets(conn, id)?;
    let value = secrets
        .get(field)
        .cloned()
        .ok_or_else(|| CoreError::Validation(format!("This profile has no {}.", field.label())))?;
    audit::append(conn, &event(id, profile.name, field.label().to_owned()))?;
    Ok(value)
}

/// Show a secret to the user. Audited.
pub fn reveal(conn: &Connection, id: i64, field: SecretField) -> Result<SecretString, CoreError> {
    read_audited(conn, id, field, |profile_id, name, field| {
        AuditEvent::CredentialRevealed {
            profile_id,
            name,
            field,
        }
    })
}

/// Fetch a secret for the clipboard (Rust writes and later clears it). Audited.
pub fn for_copy(conn: &Connection, id: i64, field: SecretField) -> Result<SecretString, CoreError> {
    read_audited(conn, id, field, |profile_id, name, field| {
        AuditEvent::CredentialCopied {
            profile_id,
            name,
            field,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::super::testutil;
    use super::*;

    fn input(name: &str) -> CredentialInput {
        CredentialInput {
            id: 0,
            name: name.into(),
            username: "admin".into(),
            key_path: None,
            auto_enable: true,
            notes: String::new(),
            password: SecretUpdate::Set {
                value: "s3cret-pw".into(),
            },
            key_data: SecretUpdate::Keep,
            key_passphrase: SecretUpdate::Keep,
            enable_secret: SecretUpdate::Set {
                value: "en4ble".into(),
            },
        }
    }

    #[test]
    fn secrets_are_stored_but_never_listed_or_audited() {
        let c = testutil::conn();
        let p = save(&c, &input("Lab switches")).expect("save");
        assert!(p.has_password && p.has_enable_secret && !p.has_key_data);
        let listed = serde_json::to_string(&list(&c).expect("list")).expect("json");
        assert!(!listed.contains("s3cret-pw"));
        let s = secrets(&c, p.id).expect("secrets");
        assert_eq!(
            s.password.as_ref().map(SecretString::expose),
            Some("s3cret-pw")
        );
        assert_eq!(
            s.enable_secret.as_ref().map(SecretString::expose),
            Some("en4ble")
        );

        // Change the password, keep the enable secret, clear nothing else.
        let mut change = input("Lab switches");
        change.id = p.id;
        change.password = SecretUpdate::Set {
            value: "n3w-pw".into(),
        };
        change.enable_secret = SecretUpdate::Keep;
        save(&c, &change).expect("update");
        let s = secrets(&c, p.id).expect("secrets");
        assert_eq!(
            s.password.as_ref().map(SecretString::expose),
            Some("n3w-pw")
        );
        assert_eq!(
            s.enable_secret.as_ref().map(SecretString::expose),
            Some("en4ble")
        );

        let log = testutil::changes(&c);
        let text = serde_json::to_string(&log).expect("json");
        assert!(!text.contains("s3cret") && !text.contains("n3w-pw") && !text.contains("en4ble"));
        assert_eq!(log[1]["changes"][0]["field"], "password");
        assert_eq!(log[1]["changes"][0]["new"], "changed");
    }

    #[test]
    fn clear_reveal_and_copy_are_audited() {
        let c = testutil::conn();
        let p = save(&c, &input("Core")).expect("save");
        let v = reveal(&c, p.id, SecretField::Password).expect("reveal");
        assert_eq!(v.expose(), "s3cret-pw");
        for_copy(&c, p.id, SecretField::EnableSecret).expect("copy");
        let kinds: Vec<String> = crate::audit::recent(&c, 10)
            .expect("recent")
            .into_iter()
            .map(|e| e.kind)
            .collect();
        assert_eq!(kinds[0], "credential_copied");
        assert_eq!(kinds[1], "credential_revealed");

        let mut clear = input("Core");
        clear.id = p.id;
        clear.password = SecretUpdate::Clear;
        clear.enable_secret = SecretUpdate::Keep;
        let p = save(&c, &clear).expect("clear");
        assert!(!p.has_password);
        assert!(reveal(&c, p.id, SecretField::Password).is_err());
    }

    #[test]
    fn validation() {
        let c = testutil::conn();
        let mut bad_key = input("K");
        bad_key.key_data = SecretUpdate::Set {
            value: "not a key".into(),
        };
        assert!(save(&c, &bad_key).is_err());
        save(&c, &input("Dup")).expect("first");
        assert_eq!(
            save(&c, &input("Dup")).expect_err("dup").to_string(),
            "A credential profile named Dup already exists."
        );
        let p = list(&c).expect("list").remove(0);
        delete(&c, p.id).expect("delete");
        assert!(secrets(&c, p.id).expect("secrets").password.is_none());
    }
}
