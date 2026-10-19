//! Configuration snapshots grabbed from devices, kept per device with a timestamp.

use crate::audit;
use crate::error::CoreError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Largest configuration stored (big chassis configs are a few MB).
pub const MAX_CONFIG: usize = 16 * 1024 * 1024;

/// A snapshot without its content (history lists).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: i64,
    pub device_id: i64,
    pub taken_at: String,
    pub command: String,
    pub sha256: String,
    pub lines: usize,
    pub bytes: usize,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(flatten)]
    pub info: SnapshotInfo,
    pub content: String,
}

const COLS: &str =
    "SELECT id, device_id, taken_at, command, sha256, note, content FROM config_snapshots";

fn row(r: &Row<'_>) -> rusqlite::Result<Snapshot> {
    let content: String = r.get(6)?;
    Ok(Snapshot {
        info: SnapshotInfo {
            id: r.get(0)?,
            device_id: r.get(1)?,
            taken_at: r.get(2)?,
            command: r.get(3)?,
            sha256: r.get(4)?,
            note: r.get(5)?,
            lines: content.lines().count(),
            bytes: content.len(),
        },
        content,
    })
}

fn digest(content: &str) -> String {
    hex::encode(Sha256::digest(content.as_bytes()))
}

/// Store a snapshot. Returns its info and whether it differs from the previous one.
pub fn save(
    conn: &Connection,
    device_id: i64,
    command: &str,
    content: &str,
) -> Result<(SnapshotInfo, bool), CoreError> {
    if content.len() > MAX_CONFIG {
        return Err(CoreError::Validation(
            "The configuration is larger than 16 MB and was not stored.".into(),
        ));
    }
    if content.trim().is_empty() {
        return Err(CoreError::Validation(
            "The device returned an empty configuration.".into(),
        ));
    }
    let sha = digest(content);
    let previous: Option<String> = conn
        .query_row(
            "SELECT sha256 FROM config_snapshots WHERE device_id = ?1
             ORDER BY taken_at DESC, id DESC LIMIT 1",
            [device_id],
            |r| r.get(0),
        )
        .optional()?;
    conn.execute(
        "INSERT INTO config_snapshots (device_id, taken_at, command, content, sha256)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![device_id, audit::now(), command, content, sha],
    )?;
    let id = conn.last_insert_rowid();
    let info = get(conn, id)?
        .ok_or_else(|| CoreError::Validation("The snapshot was not stored.".into()))?
        .info;
    Ok((info, previous.as_deref() != Some(sha.as_str())))
}

/// History of a device, newest first, without contents.
pub fn list(conn: &Connection, device_id: i64) -> Result<Vec<SnapshotInfo>, CoreError> {
    let mut stmt = conn.prepare(&format!(
        "{COLS} WHERE device_id = ?1 ORDER BY taken_at DESC, id DESC"
    ))?;
    let rows = stmt.query_map([device_id], row)?;
    Ok(rows.map(|r| r.map(|s| s.info)).collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Snapshot>, CoreError> {
    Ok(conn
        .query_row(&format!("{COLS} WHERE id = ?1"), [id], row)
        .optional()?)
}

pub fn set_note(conn: &Connection, id: i64, note: &str) -> Result<(), CoreError> {
    let note = crate::inventory::validate::text(note, "note", 500)?;
    conn.execute(
        "UPDATE config_snapshots SET note = ?2 WHERE id = ?1",
        params![id, note],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), CoreError> {
    conn.execute("DELETE FROM config_snapshots WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inventory::testutil;

    #[test]
    fn stores_history_and_detects_changes() {
        let c = testutil::conn();
        let d = testutil::device(&c, "sw1");
        let (a, changed) = save(&c, d, "show running-config", "hostname sw1\n!\n").expect("a");
        assert!(changed, "first snapshot counts as a change");
        assert_eq!(a.lines, 2);
        let (_, changed) = save(&c, d, "show running-config", "hostname sw1\n!\n").expect("b");
        assert!(!changed);
        let (c3, changed) = save(&c, d, "show running-config", "hostname sw2\n!\n").expect("c");
        assert!(changed);
        let history = list(&c, d).expect("list");
        assert_eq!(history.len(), 3);
        assert_eq!(history[0].id, c3.id, "newest first");
        assert_eq!(
            get(&c, a.id).expect("get").expect("some").content,
            "hostname sw1\n!\n"
        );
        set_note(&c, a.id, "before change").expect("note");
        assert!(save(&c, d, "x", "  \n").is_err());
        delete(&c, a.id).expect("delete");
        assert_eq!(list(&c, d).expect("list").len(), 2);
    }
}
