//! Append-only, tamper-evident audit log.
//!
//! Each entry stores the SHA-256 hash of the previous entry; the entry's own hash covers
//! its sequence number, timestamp, kind, payload and the previous hash. Changing,
//! removing or reordering any entry breaks the chain, which [`verify`] detects. The
//! table also has triggers that reject UPDATE and DELETE.

use crate::diff::FieldChange;
use crate::error::CoreError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Hash used as `prev_hash` of the first entry.
pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// What happened to an inventory entity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeAction {
    Created,
    Updated,
    Deleted,
}

/// Why the app locked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LockReason {
    Manual,
    Idle,
    SystemSleep,
}

/// A typed audit event. Serialized with a `kind` tag; never contains secrets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuditEvent {
    VaultCreated,
    AppUnlocked,
    AppLocked {
        reason: LockReason,
    },
    /// Recorded while locked in the plaintext sidecar, copied into the log on the next
    /// successful unlock with the original time.
    UnlockFailed {
        at: String,
    },
    MasterPasswordChanged,
    SettingsChanged {
        changes: Vec<FieldChange>,
    },
    IntegrityVerified {
        ok: bool,
        entries: u64,
    },
    #[serde(rename_all = "camelCase")]
    HostKeyTrusted {
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
        /// Set when this replaced a different (changed) key.
        replaced_fingerprint: Option<String>,
    },
    /// The user refused a host key (unknown or changed).
    #[serde(rename_all = "camelCase")]
    HostKeyRejected {
        host: String,
        port: u16,
        fingerprint: String,
        changed: bool,
    },
    #[serde(rename_all = "camelCase")]
    SessionStarted {
        session_id: String,
        protocol: String,
        target: String,
        username: Option<String>,
        /// Device id once inventory exists (M4); free-form label until then.
        device: Option<String>,
        host_key_fingerprint: Option<String>,
    },
    /// File sent or received over a session (Xmodem/Ymodem now; SFTP/SCP/TFTP later).
    #[serde(rename_all = "camelCase")]
    FileTransferred {
        session_id: String,
        protocol: String,
        direction: String,
        file: String,
        bytes: u64,
        ok: bool,
        error: Option<String>,
    },
    /// An inventory entity was created, updated or deleted, with a field-level diff.
    #[serde(rename_all = "camelCase")]
    InventoryChanged {
        entity: String,
        entity_id: i64,
        name: String,
        action: ChangeAction,
        changes: Vec<FieldChange>,
    },
    /// Something was exported to a file (map diagram now; data and backups in M8).
    #[serde(rename_all = "camelCase")]
    DataExported {
        what: String,
        format: String,
        path: String,
    },
    /// A stored secret was shown in the UI.
    #[serde(rename_all = "camelCase")]
    CredentialRevealed {
        profile_id: i64,
        name: String,
        field: String,
    },
    /// A stored secret was copied to the clipboard (cleared again after 30 s).
    #[serde(rename_all = "camelCase")]
    CredentialCopied {
        profile_id: i64,
        name: String,
        field: String,
    },
    #[serde(rename_all = "camelCase")]
    SessionEnded {
        session_id: String,
        protocol: String,
        target: String,
        duration_secs: u64,
        reason: String,
    },
}

impl AuditEvent {
    /// The `kind` tag, stored in its own column for filtering.
    pub fn kind(&self) -> &'static str {
        match self {
            AuditEvent::VaultCreated => "vault_created",
            AuditEvent::AppUnlocked => "app_unlocked",
            AuditEvent::AppLocked { .. } => "app_locked",
            AuditEvent::UnlockFailed { .. } => "unlock_failed",
            AuditEvent::MasterPasswordChanged => "master_password_changed",
            AuditEvent::SettingsChanged { .. } => "settings_changed",
            AuditEvent::IntegrityVerified { .. } => "integrity_verified",
            AuditEvent::HostKeyTrusted { .. } => "host_key_trusted",
            AuditEvent::HostKeyRejected { .. } => "host_key_rejected",
            AuditEvent::SessionStarted { .. } => "session_started",
            AuditEvent::SessionEnded { .. } => "session_ended",
            AuditEvent::FileTransferred { .. } => "file_transferred",
            AuditEvent::InventoryChanged { .. } => "inventory_changed",
            AuditEvent::CredentialRevealed { .. } => "credential_revealed",
            AuditEvent::DataExported { .. } => "data_exported",
            AuditEvent::CredentialCopied { .. } => "credential_copied",
        }
    }
}

/// A stored audit entry.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub seq: i64,
    pub ts: String,
    pub kind: String,
    pub payload: serde_json::Value,
    pub prev_hash: String,
    pub hash: String,
}

/// Result of an integrity check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub ok: bool,
    pub entries: u64,
    /// Sequence number of the first entry that fails verification.
    pub first_bad_seq: Option<i64>,
}

fn entry_hash(seq: i64, ts: &str, kind: &str, payload: &str, prev_hash: &str) -> String {
    let mut h = Sha256::new();
    for part in [
        prev_hash.as_bytes(),
        seq.to_string().as_bytes(),
        ts.as_bytes(),
        kind.as_bytes(),
        payload.as_bytes(),
    ] {
        // Length-prefix each field so boundaries cannot be shifted.
        h.update((part.len() as u64).to_be_bytes());
        h.update(part);
    }
    hex::encode(h.finalize())
}

/// Current UTC time in RFC 3339 with milliseconds.
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Append an event with the current time.
pub fn append(conn: &Connection, event: &AuditEvent) -> Result<AuditEntry, CoreError> {
    append_at(conn, event, &now())
}

/// Append an event with an explicit timestamp.
///
/// Runs inside a SAVEPOINT so it composes with a caller's open transaction (e.g. a
/// settings change and its audit entry commit together).
pub fn append_at(conn: &Connection, event: &AuditEvent, ts: &str) -> Result<AuditEntry, CoreError> {
    conn.execute_batch("SAVEPOINT audit_append")?;
    match append_inner(conn, event, ts) {
        Ok(entry) => {
            conn.execute_batch("RELEASE audit_append")?;
            Ok(entry)
        }
        Err(e) => {
            // Best effort: the original error is more useful than a rollback failure.
            let _ = conn.execute_batch("ROLLBACK TO audit_append; RELEASE audit_append");
            Err(e)
        }
    }
}

fn append_inner(conn: &Connection, event: &AuditEvent, ts: &str) -> Result<AuditEntry, CoreError> {
    let last: Option<(i64, String)> = conn
        .query_row(
            "SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (seq, prev_hash) = match last {
        Some((s, h)) => (s + 1, h),
        None => (1, GENESIS_HASH.to_owned()),
    };
    let kind = event.kind();
    let payload = serde_json::to_string(event)?;
    let hash = entry_hash(seq, ts, kind, &payload, &prev_hash);
    conn.execute(
        "INSERT INTO audit_log (seq, ts, kind, payload, prev_hash, hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![seq, ts, kind, payload, prev_hash, hash],
    )?;
    Ok(AuditEntry {
        seq,
        ts: ts.to_owned(),
        kind: kind.to_owned(),
        payload: serde_json::from_str(&payload)?,
        prev_hash,
        hash,
    })
}

/// Re-check the whole chain.
pub fn verify(conn: &Connection) -> Result<IntegrityReport, CoreError> {
    let mut stmt =
        conn.prepare("SELECT seq, ts, kind, payload, prev_hash, hash FROM audit_log ORDER BY seq")?;
    let mut rows = stmt.query([])?;
    let mut expected_prev = GENESIS_HASH.to_owned();
    let mut expected_seq = 1i64;
    let mut entries = 0u64;
    while let Some(r) = rows.next()? {
        let seq: i64 = r.get(0)?;
        let ts: String = r.get(1)?;
        let kind: String = r.get(2)?;
        let payload: String = r.get(3)?;
        let prev_hash: String = r.get(4)?;
        let hash: String = r.get(5)?;
        entries += 1;
        let valid = seq == expected_seq
            && prev_hash == expected_prev
            && entry_hash(seq, &ts, &kind, &payload, &prev_hash) == hash;
        if !valid {
            return Ok(IntegrityReport {
                ok: false,
                entries,
                first_bad_seq: Some(seq),
            });
        }
        expected_prev = hash;
        expected_seq += 1;
    }
    Ok(IntegrityReport {
        ok: true,
        entries,
        first_bad_seq: None,
    })
}

/// Most recent entries, newest first.
pub fn recent(conn: &Connection, limit: u32) -> Result<Vec<AuditEntry>, CoreError> {
    let mut stmt = conn.prepare(
        "SELECT seq, ts, kind, payload, prev_hash, hash FROM audit_log ORDER BY seq DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (seq, ts, kind, payload, prev_hash, hash) = row?;
        out.push(AuditEntry {
            seq,
            ts,
            kind,
            payload: serde_json::from_str(&payload)?,
            prev_hash,
            hash,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use zeroize::Zeroizing;

    fn conn() -> Connection {
        db::open_in_memory(&Zeroizing::new([3u8; 32])).expect("db")
    }

    fn seed(c: &Connection) {
        append(c, &AuditEvent::VaultCreated).expect("append");
        append(c, &AuditEvent::AppUnlocked).expect("append");
        append(
            c,
            &AuditEvent::AppLocked {
                reason: LockReason::Idle,
            },
        )
        .expect("append");
    }

    #[test]
    fn chain_links_entries() {
        let c = conn();
        let a = append(&c, &AuditEvent::VaultCreated).expect("append");
        let b = append(&c, &AuditEvent::AppUnlocked).expect("append");
        assert_eq!(a.seq, 1);
        assert_eq!(a.prev_hash, GENESIS_HASH);
        assert_eq!(b.prev_hash, a.hash);
        assert_eq!(b.kind, "app_unlocked");
    }

    #[test]
    fn intact_chain_verifies() {
        let c = conn();
        seed(&c);
        let r = verify(&c).expect("verify");
        assert_eq!(
            r,
            IntegrityReport {
                ok: true,
                entries: 3,
                first_bad_seq: None
            }
        );
    }

    #[test]
    fn empty_log_verifies() {
        assert!(verify(&conn()).expect("verify").ok);
    }

    #[test]
    fn update_and_delete_are_rejected() {
        let c = conn();
        seed(&c);
        assert!(c
            .execute("UPDATE audit_log SET kind='x' WHERE seq=2", [])
            .is_err());
        assert!(c.execute("DELETE FROM audit_log WHERE seq=2", []).is_err());
    }

    /// Simulate an attacker who bypasses the triggers (e.g. editing the decrypted file).
    fn tamper(c: &Connection, sql: &str) {
        c.execute_batch(&format!(
            "DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete; {sql}"
        ))
        .expect("tamper");
    }

    #[test]
    fn detects_modified_payload() {
        let c = conn();
        seed(&c);
        tamper(
            &c,
            "UPDATE audit_log SET payload='{\"kind\":\"app_unlocked\"}' WHERE seq=3",
        );
        let r = verify(&c).expect("verify");
        assert!(!r.ok);
        assert_eq!(r.first_bad_seq, Some(3));
    }

    #[test]
    fn detects_deleted_entry() {
        let c = conn();
        seed(&c);
        tamper(&c, "DELETE FROM audit_log WHERE seq=2");
        let r = verify(&c).expect("verify");
        assert!(!r.ok);
        assert_eq!(r.first_bad_seq, Some(3));
    }

    #[test]
    fn detects_rehashed_entry_without_relinking() {
        let c = conn();
        seed(&c);
        // Rewrite entry 2 and recompute its own hash: entry 3's prev_hash no longer matches.
        let payload = "{\"kind\":\"vault_created\"}";
        let prev: String = c
            .query_row("SELECT prev_hash FROM audit_log WHERE seq=2", [], |r| {
                r.get(0)
            })
            .expect("row");
        let ts: String = c
            .query_row("SELECT ts FROM audit_log WHERE seq=2", [], |r| r.get(0))
            .expect("row");
        let h = entry_hash(2, &ts, "vault_created", payload, &prev);
        tamper(
            &c,
            &format!(
                "UPDATE audit_log SET kind='vault_created', payload='{payload}', hash='{h}' WHERE seq=2"
            ),
        );
        assert_eq!(verify(&c).expect("verify").first_bad_seq, Some(3));
    }

    #[test]
    fn recent_returns_newest_first_with_payload() {
        let c = conn();
        seed(&c);
        let r = recent(&c, 2).expect("recent");
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].seq, 3);
        assert_eq!(r[0].payload["reason"], "idle");
    }

    #[test]
    fn event_kind_matches_serde_tag() {
        let events = [
            AuditEvent::VaultCreated,
            AuditEvent::AppUnlocked,
            AuditEvent::AppLocked {
                reason: LockReason::Manual,
            },
            AuditEvent::UnlockFailed { at: now() },
            AuditEvent::MasterPasswordChanged,
            AuditEvent::SettingsChanged { changes: vec![] },
            AuditEvent::IntegrityVerified {
                ok: true,
                entries: 1,
            },
            AuditEvent::HostKeyTrusted {
                host: "h".into(),
                port: 22,
                key_type: "ssh-ed25519".into(),
                fingerprint: "f".into(),
                replaced_fingerprint: None,
            },
            AuditEvent::HostKeyRejected {
                host: "h".into(),
                port: 22,
                fingerprint: "f".into(),
                changed: true,
            },
            AuditEvent::InventoryChanged {
                entity: "device".into(),
                entity_id: 1,
                name: "sw1".into(),
                action: ChangeAction::Created,
                changes: vec![],
            },
            AuditEvent::CredentialRevealed {
                profile_id: 1,
                name: "lab".into(),
                field: "password".into(),
            },
            AuditEvent::CredentialCopied {
                profile_id: 1,
                name: "lab".into(),
                field: "password".into(),
            },
            AuditEvent::DataExported {
                what: "map".into(),
                format: "pdf".into(),
                path: "/tmp/x.pdf".into(),
            },
            AuditEvent::SessionStarted {
                session_id: "s1".into(),
                protocol: "ssh".into(),
                target: "h:22".into(),
                username: Some("admin".into()),
                device: None,
                host_key_fingerprint: None,
            },
            AuditEvent::FileTransferred {
                session_id: "s1".into(),
                protocol: "ymodem".into(),
                direction: "send".into(),
                file: "ios.bin".into(),
                bytes: 10,
                ok: true,
                error: None,
            },
            AuditEvent::SessionEnded {
                session_id: "s1".into(),
                protocol: "ssh".into(),
                target: "h:22".into(),
                duration_secs: 5,
                reason: "exited".into(),
            },
        ];
        for e in events {
            let v = serde_json::to_value(&e).expect("serialize");
            assert_eq!(v["kind"], e.kind());
        }
    }
}
