//! Saved connections: named Quick Connect targets that reopen in one click without
//! being inventory devices. The form is stored as JSON for the frontend to fill back
//! in; it never holds a secret. Credentials come from an optional credential profile,
//! which the Tauri layer resolves in Rust when the connection opens.

use crate::audit;
use crate::error::CoreError;
use crate::inventory::validate;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    /// "ssh", "telnet", "serial" or "rdp".
    pub protocol: String,
    /// The Quick Connect form for `protocol`, without secrets.
    pub settings: Value,
    #[serde(default)]
    pub credential_id: Option<i64>,
    #[serde(default)]
    pub last_used_at: Option<String>,
}

const PROTOCOLS: [&str; 4] = ["ssh", "telnet", "serial", "rdp"];
const MAX_SETTINGS: usize = 16 * 1024;
/// Keys that would carry a secret; the frontend drops them, this is the backstop.
const SECRET_KEYS: [&str; 4] = ["password", "passphrase", "secret", "enableSecret"];
const COLS: &str =
    "SELECT id, name, protocol, settings, credential_id, last_used_at FROM saved_connections";

fn row(r: &Row<'_>) -> rusqlite::Result<SavedConnection> {
    let settings: String = r.get(3)?;
    Ok(SavedConnection {
        id: r.get(0)?,
        name: r.get(1)?,
        protocol: r.get(2)?,
        settings: serde_json::from_str(&settings).unwrap_or(Value::Null),
        credential_id: r.get(4)?,
        last_used_at: r.get(5)?,
    })
}

fn has_secret(v: &Value) -> bool {
    match v {
        Value::Object(map) => map.iter().any(|(k, v)| {
            let filled = !matches!(v, Value::Null) && v.as_str() != Some("");
            (SECRET_KEYS.contains(&k.as_str()) && filled) || has_secret(v)
        }),
        Value::Array(items) => items.iter().any(has_secret),
        _ => false,
    }
}

fn clean(input: &SavedConnection) -> Result<(SavedConnection, String), CoreError> {
    let protocol = input.protocol.trim().to_ascii_lowercase();
    if !PROTOCOLS.contains(&protocol.as_str()) {
        return Err(CoreError::Validation(format!(
            "\"{}\" is not a protocol Cairn can save (SSH, Telnet, Serial or RDP).",
            input.protocol
        )));
    }
    if !input.settings.is_object() {
        return Err(CoreError::Validation(
            "The connection settings are missing.".into(),
        ));
    }
    if has_secret(&input.settings) {
        return Err(CoreError::Validation(
            "Passwords are not stored with a saved connection. Pick a credential profile, or leave it empty to be asked when connecting.".into(),
        ));
    }
    let json = serde_json::to_string(&input.settings)?;
    if json.len() > MAX_SETTINGS {
        return Err(CoreError::Validation(
            "These connection settings are too large to save.".into(),
        ));
    }
    Ok((
        SavedConnection {
            name: validate::name(&input.name, "name", 120)?,
            protocol,
            ..input.clone()
        },
        json,
    ))
}

/// All saved connections, most recently used first, then by name.
pub fn list(conn: &Connection) -> Result<Vec<SavedConnection>, CoreError> {
    let mut stmt = conn.prepare(&format!(
        "{COLS} ORDER BY last_used_at IS NULL, last_used_at DESC, name COLLATE NOCASE"
    ))?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<SavedConnection>, CoreError> {
    Ok(conn
        .query_row(&format!("{COLS} WHERE id = ?1"), [id], row)
        .optional()?)
}

/// Create (`id == 0`) or update a saved connection.
pub fn save(conn: &Connection, input: &SavedConnection) -> Result<SavedConnection, CoreError> {
    let (s, settings) = clean(input)?;
    let dup = |e: rusqlite::Error| {
        match e {
        rusqlite::Error::SqliteFailure(f, _)
            if f.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            CoreError::Validation(format!(
                "A saved connection named \"{}\" already exists, or its credential profile was deleted.",
                s.name
            ))
        }
        e => CoreError::Database(e),
    }
    };
    let id = if s.id == 0 {
        conn.execute(
            "INSERT INTO saved_connections (name, protocol, settings, credential_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![s.name, s.protocol, settings, s.credential_id, audit::now()],
        )
        .map_err(dup)?;
        conn.last_insert_rowid()
    } else {
        let n = conn
            .execute(
                "UPDATE saved_connections SET name = ?2, protocol = ?3, settings = ?4,
                 credential_id = ?5 WHERE id = ?1",
                params![s.id, s.name, s.protocol, settings, s.credential_id],
            )
            .map_err(dup)?;
        if n == 0 {
            return Err(CoreError::Validation(
                "This saved connection no longer exists.".into(),
            ));
        }
        s.id
    };
    get(conn, id)?.ok_or_else(|| CoreError::Validation("The connection was not saved.".into()))
}

/// Remember that the connection was just opened (orders the list).
pub fn touch(conn: &Connection, id: i64) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE saved_connections SET last_used_at = ?2 WHERE id = ?1",
        params![id, audit::now()],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), CoreError> {
    conn.execute("DELETE FROM saved_connections WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ssh(name: &str) -> SavedConnection {
        SavedConnection {
            id: 0,
            name: name.into(),
            protocol: "ssh".into(),
            settings: json!({ "destination": "admin@10.0.0.1", "auth": "password", "password": "" }),
            credential_id: None,
            last_used_at: None,
        }
    }

    #[test]
    fn crud_ordering_and_validation() {
        let c = crate::inventory::testutil::conn();
        let a = save(&c, &ssh(" core-sw1 ")).expect("save");
        assert_eq!(a.name, "core-sw1");
        assert_eq!(a.settings["destination"], "admin@10.0.0.1");
        let b = save(&c, &ssh("edge-r1")).expect("save");
        assert!(save(&c, &ssh("CORE-SW1")).is_err(), "names are unique");
        assert!(save(&c, &ssh("  ")).is_err());
        assert!(save(
            &c,
            &SavedConnection {
                protocol: "ftp".into(),
                ..ssh("x")
            }
        )
        .is_err());
        assert!(save(
            &c,
            &SavedConnection {
                settings: json!("nope"),
                ..ssh("x")
            }
        )
        .is_err());

        // Never used: by name. Used: most recent first.
        let names = |c: &Connection| -> Vec<String> {
            list(c).expect("list").into_iter().map(|s| s.name).collect()
        };
        assert_eq!(names(&c), ["core-sw1", "edge-r1"]);
        touch(&c, b.id).expect("touch");
        assert_eq!(names(&c), ["edge-r1", "core-sw1"]);

        let renamed = save(
            &c,
            &SavedConnection {
                name: "core-sw1a".into(),
                ..a.clone()
            },
        )
        .expect("update");
        assert_eq!(renamed.id, a.id);
        delete(&c, a.id).expect("delete");
        assert_eq!(names(&c), ["edge-r1"]);
    }

    #[test]
    fn refuses_settings_with_a_secret() {
        let c = crate::inventory::testutil::conn();
        let with_pw = SavedConnection {
            settings: json!({ "destination": "r1", "password": "hunter2" }),
            ..ssh("r1")
        };
        assert!(matches!(
            save(&c, &with_pw),
            Err(CoreError::Validation(m)) if m.contains("Passwords are not stored")
        ));
        let nested = SavedConnection {
            settings: json!({ "hops": [{ "auth": { "passphrase": "x" } }] }),
            ..ssh("r2")
        };
        assert!(save(&c, &nested).is_err());
    }

    #[test]
    fn deleting_the_credential_profile_keeps_the_connection() {
        let c = crate::inventory::testutil::conn();
        c.execute(
            "INSERT INTO credential_profiles (id, name, username, created_at, updated_at)
             VALUES (7, 'netops', 'admin', '', '')",
            [],
        )
        .expect("profile");
        let s = save(
            &c,
            &SavedConnection {
                credential_id: Some(7),
                ..ssh("core")
            },
        )
        .expect("save");
        c.execute("DELETE FROM credential_profiles WHERE id = 7", [])
            .expect("delete profile");
        assert_eq!(
            get(&c, s.id).expect("get").expect("kept").credential_id,
            None
        );
    }
}
