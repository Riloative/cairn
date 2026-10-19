//! Append-only, tamper-evident audit log.
//!
//! Each entry stores the SHA-256 hash of the previous entry; the entry's own hash covers
//! its sequence number, timestamp, kind, payload and the previous hash. Changing,
//! removing or reordering any entry breaks the chain, which [`verify`] detects. The
//! table also has triggers that reject UPDATE and DELETE.

use crate::csv::CsvWriter;
use crate::diff::FieldChange;
use crate::error::CoreError;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
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
    /// File sent or received over a session (Xmodem/Ymodem, SFTP, SCP) or by the TFTP
    /// server (`session_id` is then the client address).
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
    /// Broadcast input was turned on for these sessions (typed text is never logged).
    #[serde(rename_all = "camelCase")]
    BroadcastStarted {
        targets: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    BroadcastEnded {
        targets: Vec<String>,
        duration_secs: u64,
    },
    /// A device configuration was grabbed (stored as a snapshot when `ok`).
    #[serde(rename_all = "camelCase")]
    ConfigGrabbed {
        device_id: i64,
        device: String,
        command: String,
        bytes: u64,
        changed: bool,
        ok: bool,
        error: Option<String>,
    },
    /// An SSH port forward was started, stopped or failed.
    #[serde(rename_all = "camelCase")]
    PortForward {
        session_id: String,
        target: String,
        forward: String,
        action: String,
        error: Option<String>,
    },
    /// The built-in TFTP server was started or stopped.
    #[serde(rename_all = "camelCase")]
    TftpServer {
        action: String,
        bind: String,
        root: String,
        allow_write: bool,
    },
    /// Entries older than the retention period were removed; the kept chain now starts
    /// at `keep_from` (see [`apply_retention`]).
    #[serde(rename_all = "camelCase")]
    AuditPruned {
        keep_from: i64,
        removed: u64,
        older_than: String,
        retention_days: u32,
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
            AuditEvent::BroadcastStarted { .. } => "broadcast_started",
            AuditEvent::BroadcastEnded { .. } => "broadcast_ended",
            AuditEvent::ConfigGrabbed { .. } => "config_grabbed",
            AuditEvent::PortForward { .. } => "port_forward",
            AuditEvent::TftpServer { .. } => "tftp_server",
            AuditEvent::AuditPruned { .. } => "audit_pruned",
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
    /// Entries before this one were removed by retention (the chain is verified from
    /// here).
    pub pruned_before: Option<i64>,
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

/// Where the kept chain starts after retention pruning: `(keep_from, prev_hash)`.
fn anchor(conn: &Connection) -> Result<Option<(i64, String)>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT keep_from, prev_hash FROM audit_anchor WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

/// Re-check the whole chain (from the retention anchor, if entries were pruned).
pub fn verify(conn: &Connection) -> Result<IntegrityReport, CoreError> {
    let anchor = anchor(conn)?;
    let (mut expected_seq, mut expected_prev) = match &anchor {
        Some((keep_from, prev)) => (*keep_from, prev.clone()),
        None => (1, GENESIS_HASH.to_owned()),
    };
    let pruned_before = anchor.as_ref().map(|(k, _)| *k);
    let bad = |entries, seq| IntegrityReport {
        ok: false,
        entries,
        first_bad_seq: Some(seq),
        pruned_before,
    };
    let mut stmt =
        conn.prepare("SELECT seq, ts, kind, payload, prev_hash, hash FROM audit_log ORDER BY seq")?;
    let mut rows = stmt.query([])?;
    let mut entries = 0u64;
    // The latest prune recorded in the chain must name the anchor's position; otherwise
    // the anchor (and the missing head) was not made by retention.
    let mut last_prune: Option<i64> = None;
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
            return Ok(bad(entries, seq));
        }
        if kind == "audit_pruned" {
            let v: serde_json::Value = serde_json::from_str(&payload)?;
            last_prune = v["keepFrom"].as_i64();
        }
        expected_prev = hash;
        expected_seq += 1;
    }
    if let Some((keep_from, _)) = anchor {
        if last_prune != Some(keep_from) {
            return Ok(bad(entries, keep_from));
        }
    }
    Ok(IntegrityReport {
        ok: true,
        entries,
        first_bad_seq: None,
        pruned_before,
    })
}

/// Remove entries older than `days` (0 keeps everything). Returns how many were removed.
///
/// The prune is recorded as an `audit_pruned` entry and the anchor moves to the first
/// kept entry, so [`verify`] still checks the remaining chain end to end.
pub fn apply_retention(conn: &Connection, days: u32, now: &str) -> Result<u64, CoreError> {
    if days == 0 {
        return Ok(0);
    }
    let now = parse_ts(now)?;
    let cutoff = format_ts(now - chrono::Duration::days(i64::from(days)));
    let old: i64 = conn.query_row(
        "SELECT COUNT(*) FROM audit_log WHERE ts < ?1",
        [&cutoff],
        |r| r.get(0),
    )?;
    if old == 0 {
        return Ok(0);
    }
    conn.execute_batch("SAVEPOINT audit_retention")?;
    let result = (|| {
        // Keep everything from the first entry that is new enough. Entries are appended
        // in time order, but an `unlock_failed` copied in later carries its original
        // time, so stop at the first young entry rather than deleting every old one.
        let first_young: Option<i64> = conn
            .query_row(
                "SELECT MIN(seq) FROM audit_log WHERE ts >= ?1",
                [&cutoff],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let last_seq: i64 =
            conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM audit_log", [], |r| {
                r.get(0)
            })?;
        let keep_from = first_young.unwrap_or(last_seq + 1);
        let removed: i64 = conn.query_row(
            "SELECT COUNT(*) FROM audit_log WHERE seq < ?1",
            [keep_from],
            |r| r.get(0),
        )?;
        // COUNT(*) is never negative.
        let removed = removed.unsigned_abs();
        if removed == 0 {
            return Ok(0);
        }
        append(
            conn,
            &AuditEvent::AuditPruned {
                keep_from,
                removed,
                older_than: cutoff.clone(),
                retention_days: days,
            },
        )?;
        let prev_hash: String = conn.query_row(
            "SELECT prev_hash FROM audit_log WHERE seq = ?1",
            [keep_from],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO audit_anchor (id, keep_from, prev_hash) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET keep_from = excluded.keep_from, prev_hash = excluded.prev_hash",
            params![keep_from, prev_hash],
        )?;
        conn.execute("DELETE FROM audit_log WHERE seq < ?1", [keep_from])?;
        Ok(removed)
    })();
    match result {
        Ok(n) => {
            conn.execute_batch("RELEASE audit_retention")?;
            Ok(n)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO audit_retention; RELEASE audit_retention");
            Err(e)
        }
    }
}

fn parse_ts(ts: &str) -> Result<chrono::DateTime<chrono::Utc>, CoreError> {
    chrono::DateTime::parse_from_rfc3339(ts)
        .map(|t| t.with_timezone(&chrono::Utc))
        .map_err(|_| CoreError::Validation(format!("\"{ts}\" is not a valid date and time.")))
}

/// The stored timestamp format (UTC, milliseconds), which sorts as text.
fn format_ts(t: chrono::DateTime<chrono::Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
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

/// Which entries to show or export. Empty fields do not filter.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AuditFilter {
    /// Inclusive lower bound (RFC 3339).
    pub from: Option<String>,
    /// Exclusive upper bound (RFC 3339).
    pub to: Option<String>,
    /// Event kinds (`session_started`, …); any of them.
    pub kinds: Vec<String>,
    /// Device hostname. Matches entries that name the device and everything that
    /// happened in its sessions (session end, file transfers, port forwards).
    pub device: Option<String>,
    /// Session protocol (`ssh`, `telnet`, `serial`, `rdp`, `local`), including the
    /// entries of sessions with that protocol.
    pub protocol: Option<String>,
    /// Free text searched in the event details.
    pub text: Option<String>,
}

/// One page of filtered entries, newest first.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPage {
    pub entries: Vec<AuditEntry>,
    /// All entries matching the filter.
    pub total: u64,
}

/// Values offered by the audit view's filters.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditFacets {
    pub kinds: Vec<String>,
    pub devices: Vec<String>,
    pub protocols: Vec<String>,
}

/// Session ids of sessions started with `field` = `?`.
const SESSIONS_WHERE: &str = "SELECT json_extract(payload, '$.sessionId') FROM audit_log \
     WHERE kind = 'session_started' AND json_extract(payload, '$.{field}') = ? COLLATE NOCASE";

fn non_empty(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The WHERE clause (without the keyword) and its parameters.
fn filter_sql(f: &AuditFilter) -> Result<(String, Vec<SqlValue>), CoreError> {
    let mut clauses: Vec<String> = vec!["1 = 1".into()];
    let mut params: Vec<SqlValue> = Vec::new();
    if let Some(from) = non_empty(&f.from) {
        clauses.push("ts >= ?".into());
        params.push(SqlValue::Text(format_ts(parse_ts(from)?)));
    }
    if let Some(to) = non_empty(&f.to) {
        clauses.push("ts < ?".into());
        params.push(SqlValue::Text(format_ts(parse_ts(to)?)));
    }
    if !f.kinds.is_empty() {
        clauses.push(format!("kind IN ({})", vec!["?"; f.kinds.len()].join(", ")));
        params.extend(f.kinds.iter().map(|k| SqlValue::Text(k.clone())));
    }
    if let Some(device) = non_empty(&f.device) {
        clauses.push(format!(
            "(json_extract(payload, '$.device') = ? COLLATE NOCASE \
              OR (kind = 'inventory_changed' AND json_extract(payload, '$.entity') = 'device' \
                  AND json_extract(payload, '$.name') = ? COLLATE NOCASE) \
              OR json_extract(payload, '$.sessionId') IN ({}))",
            SESSIONS_WHERE.replace("{field}", "device")
        ));
        params.extend((0..3).map(|_| SqlValue::Text(device.to_owned())));
    }
    if let Some(protocol) = non_empty(&f.protocol) {
        clauses.push(format!(
            "(json_extract(payload, '$.protocol') = ? COLLATE NOCASE \
              OR json_extract(payload, '$.sessionId') IN ({}))",
            SESSIONS_WHERE.replace("{field}", "protocol")
        ));
        params.extend((0..2).map(|_| SqlValue::Text(protocol.to_owned())));
    }
    if let Some(text) = non_empty(&f.text) {
        let escaped = text
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        clauses.push("(payload LIKE ? ESCAPE '\\' OR kind LIKE ? ESCAPE '\\')".into());
        let pattern = format!("%{escaped}%");
        params.push(SqlValue::Text(pattern.clone()));
        params.push(SqlValue::Text(pattern));
    }
    Ok((clauses.join(" AND "), params))
}

fn read_entry(
    r: &rusqlite::Row<'_>,
) -> rusqlite::Result<(i64, String, String, String, String, String)> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
    ))
}

fn to_entry(row: (i64, String, String, String, String, String)) -> Result<AuditEntry, CoreError> {
    let (seq, ts, kind, payload, prev_hash, hash) = row;
    Ok(AuditEntry {
        seq,
        ts,
        kind,
        payload: serde_json::from_str(&payload)?,
        prev_hash,
        hash,
    })
}

/// Filtered entries, newest first: up to `limit` entries older than `before_seq`.
pub fn query(
    conn: &Connection,
    filter: &AuditFilter,
    before_seq: Option<i64>,
    limit: u32,
) -> Result<AuditPage, CoreError> {
    let (where_sql, params) = filter_sql(filter)?;
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM audit_log WHERE {where_sql}"),
        params_from_iter(params.iter()),
        |r| r.get(0),
    )?;
    // COUNT(*) is never negative.
    let total = total.unsigned_abs();
    let mut page_params = params;
    page_params.push(SqlValue::Integer(before_seq.unwrap_or(i64::MAX)));
    page_params.push(SqlValue::Integer(i64::from(limit)));
    let mut stmt = conn.prepare(&format!(
        "SELECT seq, ts, kind, payload, prev_hash, hash FROM audit_log \
         WHERE {where_sql} AND seq < ? ORDER BY seq DESC LIMIT ?"
    ))?;
    let rows = stmt.query_map(params_from_iter(page_params.iter()), read_entry)?;
    let mut entries = Vec::new();
    for row in rows {
        entries.push(to_entry(row?)?);
    }
    Ok(AuditPage { entries, total })
}

/// The kinds, devices and protocols present in the log.
pub fn facets(conn: &Connection) -> Result<AuditFacets, CoreError> {
    let strings = |sql: &str| -> Result<Vec<String>, CoreError> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    };
    Ok(AuditFacets {
        kinds: strings("SELECT DISTINCT kind FROM audit_log ORDER BY kind")?,
        devices: strings(
            // One entry per name regardless of case (the filter ignores case too).
            "SELECT MIN(d) FROM (
                 SELECT json_extract(payload, '$.device') AS d FROM audit_log
                 UNION
                 SELECT json_extract(payload, '$.name') FROM audit_log
                  WHERE kind = 'inventory_changed' AND json_extract(payload, '$.entity') = 'device'
             ) WHERE typeof(d) = 'text' AND d <> '' GROUP BY lower(d) ORDER BY lower(d)",
        )?,
        protocols: strings(
            "SELECT DISTINCT json_extract(payload, '$.protocol') AS p FROM audit_log
              WHERE kind = 'session_started' AND typeof(p) = 'text' ORDER BY p",
        )?,
    })
}

/// Export format for [`export`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
}

/// Write all entries matching `filter`, oldest first. Returns how many were written.
///
/// JSON keeps each entry whole (with hashes, so the chain can be checked elsewhere);
/// CSV flattens the common fields and keeps the full payload in the last column.
pub fn export(
    conn: &Connection,
    filter: &AuditFilter,
    format: ExportFormat,
    out: &mut dyn std::io::Write,
) -> Result<u64, CoreError> {
    let (where_sql, params) = filter_sql(filter)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT seq, ts, kind, payload, prev_hash, hash FROM audit_log \
         WHERE {where_sql} ORDER BY seq"
    ))?;
    let mut rows = stmt.query(params_from_iter(params.iter()))?;
    let io = |e: std::io::Error| CoreError::Io {
        path: "export".into(),
        source: e,
    };
    let mut count = 0u64;
    match format {
        ExportFormat::Json => {
            out.write_all(b"[\n").map_err(io)?;
            while let Some(r) = rows.next()? {
                let entry = to_entry(read_entry(r)?)?;
                if count > 0 {
                    out.write_all(b",\n").map_err(io)?;
                }
                serde_json::to_writer(&mut *out, &entry)?;
                count += 1;
            }
            out.write_all(b"\n]\n").map_err(io)?;
        }
        ExportFormat::Csv => {
            let mut w = CsvWriter::new(&mut *out);
            w.row([
                "seq", "time", "event", "device", "protocol", "target", "username", "details",
                "hash",
            ])
            .map_err(io)?;
            while let Some(r) = rows.next()? {
                let e = to_entry(read_entry(r)?)?;
                let field = |k: &str| match &e.payload[k] {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Null => String::new(),
                    v => v.to_string(),
                };
                let device = match field("device") {
                    d if d.is_empty()
                        && e.kind == "inventory_changed"
                        && field("entity") == "device" =>
                    {
                        field("name")
                    }
                    d => d,
                };
                w.row([
                    e.seq.to_string(),
                    e.ts.clone(),
                    e.kind.clone(),
                    device,
                    field("protocol"),
                    field("target"),
                    field("username"),
                    e.payload.to_string(),
                    e.hash.clone(),
                ])
                .map_err(io)?;
                count += 1;
            }
        }
    }
    Ok(count)
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
                first_bad_seq: None,
                pruned_before: None,
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

    fn started(id: &str, protocol: &str, device: Option<&str>) -> AuditEvent {
        AuditEvent::SessionStarted {
            session_id: id.into(),
            protocol: protocol.into(),
            target: "10.0.0.1:22".into(),
            username: Some("admin".into()),
            device: device.map(Into::into),
            host_key_fingerprint: None,
        }
    }

    fn ended(id: &str, protocol: &str) -> AuditEvent {
        AuditEvent::SessionEnded {
            session_id: id.into(),
            protocol: protocol.into(),
            target: "10.0.0.1:22".into(),
            duration_secs: 3,
            reason: "closed by user".into(),
        }
    }

    /// A small log: two devices, two protocols, a transfer inside an SSH session.
    fn sample(c: &Connection) {
        append_at(c, &AuditEvent::VaultCreated, "2026-01-01T00:00:00.000Z").expect("a");
        append_at(
            c,
            &started("s1", "ssh", Some("sw1")),
            "2026-01-02T10:00:00.000Z",
        )
        .expect("a");
        append_at(
            c,
            &AuditEvent::FileTransferred {
                session_id: "s1".into(),
                protocol: "sftp".into(),
                direction: "download".into(),
                file: "startup_50%_backup.cfg".into(),
                bytes: 10,
                ok: true,
                error: None,
            },
            "2026-01-02T10:01:00.000Z",
        )
        .expect("a");
        append_at(c, &ended("s1", "ssh"), "2026-01-02T10:02:00.000Z").expect("a");
        append_at(
            c,
            &started("s2", "telnet", Some("fw1")),
            "2026-01-03T09:00:00.000Z",
        )
        .expect("a");
        append_at(c, &ended("s2", "telnet"), "2026-01-03T09:05:00.000Z").expect("a");
        append_at(
            c,
            &AuditEvent::InventoryChanged {
                entity: "device".into(),
                entity_id: 1,
                name: "SW1".into(),
                action: ChangeAction::Updated,
                changes: vec![],
            },
            "2026-01-04T08:00:00.000Z",
        )
        .expect("a");
    }

    fn seqs(page: &AuditPage) -> Vec<i64> {
        page.entries.iter().map(|e| e.seq).collect()
    }

    #[test]
    fn filters_by_device_through_its_sessions() {
        let c = conn();
        sample(&c);
        let f = AuditFilter {
            device: Some("sw1".into()),
            ..Default::default()
        };
        // Session start, the transfer and the end (same session), the inventory change.
        let page = query(&c, &f, None, 100).expect("query");
        assert_eq!(seqs(&page), vec![7, 4, 3, 2]);
        assert_eq!(page.total, 4);
    }

    #[test]
    fn filters_by_protocol_kind_time_and_text() {
        let c = conn();
        sample(&c);
        let by_protocol = AuditFilter {
            protocol: Some("telnet".into()),
            ..Default::default()
        };
        assert_eq!(
            seqs(&query(&c, &by_protocol, None, 100).expect("q")),
            vec![6, 5]
        );
        let ssh = AuditFilter {
            protocol: Some("ssh".into()),
            ..Default::default()
        };
        // The SFTP transfer belongs to the SSH session.
        assert_eq!(seqs(&query(&c, &ssh, None, 100).expect("q")), vec![4, 3, 2]);
        let kinds = AuditFilter {
            kinds: vec!["session_started".into(), "vault_created".into()],
            ..Default::default()
        };
        assert_eq!(
            seqs(&query(&c, &kinds, None, 100).expect("q")),
            vec![5, 2, 1]
        );
        let window = AuditFilter {
            from: Some("2026-01-02T00:00:00Z".into()),
            to: Some("2026-01-03T00:00:00+00:00".into()),
            ..Default::default()
        };
        assert_eq!(
            seqs(&query(&c, &window, None, 100).expect("q")),
            vec![4, 3, 2]
        );
        // LIKE wildcards in the search text are literal.
        let text = AuditFilter {
            text: Some("50%_b".into()),
            ..Default::default()
        };
        assert_eq!(seqs(&query(&c, &text, None, 100).expect("q")), vec![3]);
        let nothing = AuditFilter {
            text: Some("5_%".into()),
            ..Default::default()
        };
        assert!(query(&c, &nothing, None, 100)
            .expect("q")
            .entries
            .is_empty());
        let bad = AuditFilter {
            from: Some("yesterday".into()),
            ..Default::default()
        };
        assert!(matches!(
            query(&c, &bad, None, 1),
            Err(CoreError::Validation(_))
        ));
    }

    #[test]
    fn pages_with_a_cursor() {
        let c = conn();
        sample(&c);
        let all = AuditFilter::default();
        let first = query(&c, &all, None, 3).expect("q");
        assert_eq!(seqs(&first), vec![7, 6, 5]);
        assert_eq!(first.total, 7);
        let next = query(&c, &all, Some(5), 3).expect("q");
        assert_eq!(seqs(&next), vec![4, 3, 2]);
    }

    #[test]
    fn facets_list_what_is_in_the_log() {
        let c = conn();
        sample(&c);
        let f = facets(&c).expect("facets");
        assert_eq!(f.protocols, vec!["ssh", "telnet"]);
        assert_eq!(f.devices, vec!["fw1", "SW1"]);
        assert!(f.kinds.contains(&"file_transferred".to_owned()));
    }

    #[test]
    fn exports_csv_and_json() {
        let c = conn();
        sample(&c);
        let f = AuditFilter {
            device: Some("sw1".into()),
            ..Default::default()
        };
        let mut csv = Vec::new();
        assert_eq!(export(&c, &f, ExportFormat::Csv, &mut csv).expect("csv"), 4);
        let csv = String::from_utf8(csv).expect("utf8");
        let lines: Vec<&str> = csv.split("\r\n").collect();
        assert!(lines[0].starts_with("seq,time,event,device,protocol"));
        assert!(lines[1]
            .starts_with("2,2026-01-02T10:00:00.000Z,session_started,sw1,ssh,10.0.0.1:22,admin,"));
        assert!(lines[4].starts_with("7,2026-01-04T08:00:00.000Z,inventory_changed,SW1,"));
        let mut json = Vec::new();
        assert_eq!(
            export(&c, &f, ExportFormat::Json, &mut json).expect("json"),
            4
        );
        let v: serde_json::Value = serde_json::from_slice(&json).expect("valid json");
        assert_eq!(v.as_array().map(Vec::len), Some(4));
        assert_eq!(v[0]["seq"], 2);
        assert!(v[0]["hash"].is_string());
        let mut empty = Vec::new();
        let none = AuditFilter {
            device: Some("nope".into()),
            ..Default::default()
        };
        export(&c, &none, ExportFormat::Json, &mut empty).expect("json");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&empty).expect("json"),
            serde_json::json!([])
        );
    }

    #[test]
    fn retention_prunes_old_entries_and_the_chain_still_verifies() {
        let c = conn();
        sample(&c);
        assert_eq!(
            apply_retention(&c, 0, "2026-03-01T00:00:00Z").expect("off"),
            0
        );
        // 30 days before Feb 2 is Jan 3: entries 1-4 (Jan 1-2) go, 5-7 stay.
        let removed = apply_retention(&c, 30, "2026-02-02T00:00:00Z").expect("prune");
        assert_eq!(removed, 4);
        let report = verify(&c).expect("verify");
        assert!(report.ok, "{report:?}");
        assert_eq!(report.pruned_before, Some(5));
        // 3 kept + the prune entry.
        assert_eq!(report.entries, 4);
        let last = recent(&c, 1).expect("recent");
        assert_eq!(last[0].kind, "audit_pruned");
        assert_eq!(last[0].payload["keepFrom"], 5);
        assert_eq!(last[0].payload["removed"], 4);
        // Nothing more to do on the same day.
        assert_eq!(
            apply_retention(&c, 30, "2026-02-02T00:00:00Z").expect("again"),
            0
        );
        // Kept entries stay protected.
        assert!(c
            .execute("DELETE FROM audit_log WHERE seq = 5", [])
            .is_err());
    }

    #[test]
    fn retention_can_prune_everything_but_its_own_entry() {
        let c = conn();
        sample(&c);
        assert_eq!(
            apply_retention(&c, 1, "2027-01-01T00:00:00Z").expect("prune"),
            7
        );
        let report = verify(&c).expect("verify");
        assert!(report.ok, "{report:?}");
        assert_eq!(report.entries, 1);
        assert_eq!(report.pruned_before, Some(8));
    }

    #[test]
    fn a_moved_anchor_is_detected() {
        let c = conn();
        sample(&c);
        apply_retention(&c, 30, "2026-02-02T00:00:00Z").expect("prune");
        // Someone with database access advances the anchor to hide entry 5 and deletes it.
        let prev: String = c
            .query_row("SELECT hash FROM audit_log WHERE seq = 5", [], |r| r.get(0))
            .expect("hash");
        c.execute(
            "UPDATE audit_anchor SET keep_from = 6, prev_hash = ?1",
            [&prev],
        )
        .expect("move anchor");
        c.execute("DELETE FROM audit_log WHERE seq = 5", [])
            .expect("delete");
        let report = verify(&c).expect("verify");
        assert!(!report.ok);
        // The anchor cannot be moved back or removed either.
        assert!(c
            .execute("UPDATE audit_anchor SET keep_from = 1", [])
            .is_err());
        assert!(c.execute("DELETE FROM audit_anchor", []).is_err());
    }

    #[test]
    fn head_deletion_without_retention_is_still_refused() {
        let c = conn();
        sample(&c);
        assert!(c
            .execute("DELETE FROM audit_log WHERE seq = 1", [])
            .is_err());
    }
}
