//! Terminal session recordings in asciicast v2 format, stored in the encrypted database.
//!
//! Only output (`o`) and resize (`r`) events are recorded, never input: what the user
//! types reaches the recording only as the device's echo, and password prompts do not
//! echo. The asciicast header is built from the recording's metadata when it is read.

use crate::error::CoreError;
use crate::tools::grab::clean_screen;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::fmt::Write as _;

/// Largest recording kept; later output is dropped and the recording marked truncated.
pub const MAX_RECORDING_BYTES: u64 = 256 * 1024 * 1024;

/// Turns a session's output into asciicast v2 event lines.
///
/// Output arrives in arbitrary chunks, so a UTF-8 sequence split across two chunks is
/// held back until it completes; invalid bytes become U+FFFD.
#[derive(Debug, Default)]
pub struct Encoder {
    pending: Vec<u8>,
    buf: String,
}

impl Encoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Output at `secs` since the start.
    pub fn output(&mut self, secs: f64, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        let text = take_utf8(&mut self.pending);
        if !text.is_empty() {
            self.event(secs, "o", &text);
        }
    }

    /// The terminal was resized.
    pub fn resize(&mut self, secs: f64, cols: u16, rows: u16) {
        self.event(secs, "r", &format!("{cols}x{rows}"));
    }

    /// Flush a dangling partial UTF-8 sequence (session end).
    pub fn finish(&mut self, secs: f64) {
        if !self.pending.is_empty() {
            let text = String::from_utf8_lossy(&self.pending).into_owned();
            self.pending.clear();
            self.event(secs, "o", &text);
        }
    }

    fn event(&mut self, secs: f64, code: &str, data: &str) {
        // serde_json escapes control characters and quotes as asciicast requires.
        let data = serde_json::Value::String(data.to_owned());
        let _ = writeln!(self.buf, "[{secs:.6}, \"{code}\", {data}]");
    }

    /// Bytes of event lines waiting to be stored.
    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    /// Take the buffered event lines.
    pub fn take(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf).into_bytes()
    }

    /// Put back event lines from [`Encoder::take`] that could not be stored, ahead of
    /// anything buffered since.
    pub fn restore(&mut self, lines: Vec<u8>) {
        let mut text = String::from_utf8(lines)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
        text.push_str(&self.buf);
        self.buf = text;
    }
}

/// Decode the complete UTF-8 prefix of `pending`, leaving an incomplete trailing
/// sequence (at most 3 bytes) for the next chunk.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    let mut rest: &[u8] = pending;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                rest = &[];
                break;
            }
            Err(e) => {
                let (good, bad) = rest.split_at(e.valid_up_to());
                // Valid by construction (`valid_up_to`).
                out.push_str(std::str::from_utf8(good).unwrap_or_default());
                match e.error_len() {
                    Some(n) => {
                        out.push('\u{FFFD}');
                        rest = &bad[n..];
                    }
                    None => {
                        rest = bad;
                        break;
                    }
                }
            }
        }
    }
    let keep = rest.to_vec();
    *pending = keep;
    out
}

/// What a new recording is of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewRecording {
    pub session_id: String,
    pub protocol: String,
    pub target: String,
    pub device_id: Option<i64>,
    pub device: String,
    pub cols: u16,
    pub rows: u16,
    pub started_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub id: i64,
    pub session_id: String,
    pub protocol: String,
    pub target: String,
    pub device_id: Option<i64>,
    pub device: String,
    pub cols: u16,
    pub rows: u16,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: i64,
    pub bytes: i64,
    pub truncated: bool,
}

impl RecordingInfo {
    /// Shown in lists and used as the asciicast title.
    pub fn title(&self) -> String {
        let what = if self.device.is_empty() {
            &self.target
        } else {
            &self.device
        };
        format!("{} {what}", self.protocol)
    }
}

pub fn start(conn: &Connection, r: &NewRecording) -> Result<i64, CoreError> {
    conn.execute(
        "INSERT INTO recordings (session_id, protocol, target, device_id, device, cols, rows, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            r.session_id,
            r.protocol,
            r.target,
            r.device_id,
            r.device,
            r.cols,
            r.rows,
            r.started_at
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Append event lines. Returns false (and stores nothing) once the size limit is
/// reached; the recording is then marked truncated.
pub fn append(conn: &Connection, id: i64, data: &[u8]) -> Result<bool, CoreError> {
    if data.is_empty() {
        return Ok(true);
    }
    let size: i64 = conn.query_row("SELECT bytes FROM recordings WHERE id = ?1", [id], |r| {
        r.get(0)
    })?;
    let len = data.len() as i64;
    if size.saturating_add(len) as u64 > MAX_RECORDING_BYTES {
        conn.execute("UPDATE recordings SET truncated = 1 WHERE id = ?1", [id])?;
        return Ok(false);
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO recording_chunks (recording_id, seq, data)
         VALUES (?1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM recording_chunks WHERE recording_id = ?1), ?2)",
        params![id, data],
    )?;
    tx.execute(
        "UPDATE recordings SET bytes = bytes + ?2 WHERE id = ?1",
        params![id, len],
    )?;
    tx.commit()?;
    Ok(true)
}

pub fn finish(
    conn: &Connection,
    id: i64,
    ended_at: &str,
    duration_ms: i64,
    truncated: bool,
) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE recordings SET ended_at = ?2, duration_ms = ?3,
         truncated = MAX(truncated, ?4) WHERE id = ?1",
        params![id, ended_at, duration_ms, truncated],
    )?;
    Ok(())
}

const COLS: &str = "SELECT id, session_id, protocol, target, device_id, device, cols, rows,
    started_at, ended_at, duration_ms, bytes, truncated FROM recordings";

fn row(r: &Row<'_>) -> rusqlite::Result<RecordingInfo> {
    Ok(RecordingInfo {
        id: r.get(0)?,
        session_id: r.get(1)?,
        protocol: r.get(2)?,
        target: r.get(3)?,
        device_id: r.get(4)?,
        device: r.get(5)?,
        cols: r.get(6)?,
        rows: r.get(7)?,
        started_at: r.get(8)?,
        ended_at: r.get(9)?,
        duration_ms: r.get(10)?,
        bytes: r.get(11)?,
        truncated: r.get(12)?,
    })
}

/// All recordings, newest first.
pub fn list(conn: &Connection) -> Result<Vec<RecordingInfo>, CoreError> {
    let mut stmt = conn.prepare(&format!("{COLS} ORDER BY started_at DESC, id DESC"))?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<RecordingInfo>, CoreError> {
    Ok(conn
        .query_row(&format!("{COLS} WHERE id = ?1"), [id], row)
        .optional()?)
}

fn require(conn: &Connection, id: i64) -> Result<RecordingInfo, CoreError> {
    get(conn, id)?.ok_or_else(|| CoreError::Validation("That recording no longer exists.".into()))
}

/// The complete asciicast v2 file.
pub fn cast(conn: &Connection, id: i64) -> Result<String, CoreError> {
    let info = require(conn, id)?;
    let timestamp = chrono::DateTime::parse_from_rfc3339(&info.started_at)
        .map(|t| t.timestamp())
        .unwrap_or_default();
    let header = serde_json::json!({
        "version": 2,
        "width": info.cols,
        "height": info.rows,
        "timestamp": timestamp,
        "title": info.title(),
        "env": { "TERM": "xterm-256color" },
    });
    let mut out = header.to_string();
    out.push('\n');
    let mut stmt =
        conn.prepare("SELECT data FROM recording_chunks WHERE recording_id = ?1 ORDER BY seq")?;
    let mut rows = stmt.query([id])?;
    while let Some(r) = rows.next()? {
        let data: Vec<u8> = r.get(0)?;
        out.push_str(&String::from_utf8_lossy(&data));
    }
    Ok(out)
}

/// The output as plain text: escape sequences removed, carriage returns and
/// backspaces applied, as on screen.
pub fn transcript(conn: &Connection, id: i64) -> Result<String, CoreError> {
    let cast = cast(conn, id)?;
    let mut raw = String::new();
    for line in cast.lines().skip(1) {
        let Ok(serde_json::Value::Array(event)) = serde_json::from_str(line) else {
            continue;
        };
        if let (Some("o"), Some(data)) = (
            event.get(1).and_then(|v| v.as_str()),
            event.get(2).and_then(|v| v.as_str()),
        ) {
            raw.push_str(data);
        }
    }
    let mut text = clean_screen(&raw);
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    Ok(text)
}

pub fn delete(conn: &Connection, id: i64) -> Result<RecordingInfo, CoreError> {
    let info = require(conn, id)?;
    conn.execute("DELETE FROM recordings WHERE id = ?1", [id])?;
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use zeroize::Zeroizing;

    fn conn() -> Connection {
        db::open_in_memory(&Zeroizing::new([4u8; 32])).expect("db")
    }

    fn new(c: &Connection) -> i64 {
        start(
            c,
            &NewRecording {
                session_id: "s1".into(),
                protocol: "ssh".into(),
                target: "10.0.0.1:22".into(),
                device_id: None,
                device: "sw1".into(),
                cols: 80,
                rows: 24,
                started_at: "2026-01-02T10:00:00.000Z".into(),
            },
        )
        .expect("start")
    }

    #[test]
    fn encodes_events_and_joins_split_utf8() {
        let mut e = Encoder::new();
        e.output(0.5, b"sw1# show \x1b[1mver\x1b[0m\r\n");
        // "é" split across two chunks.
        e.output(1.0, &[b'c', 0xC3]);
        e.output(1.25, &[0xA9, b'"']);
        e.resize(2.0, 120, 40);
        e.output(3.0, &[0xFF, b'x']);
        e.output(3.5, &[0xE2, 0x82]);
        e.finish(4.0);
        let text = String::from_utf8(e.take()).expect("utf8");
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).expect("event"))
            .collect();
        assert_eq!(lines[0][1], "o");
        assert_eq!(lines[0][2], "sw1# show \u{1b}[1mver\u{1b}[0m\r\n");
        assert_eq!(lines[1][2], "c");
        assert_eq!(lines[2][2], "é\"");
        assert_eq!(lines[3], serde_json::json!([2.0, "r", "120x40"]));
        assert_eq!(lines[4][2], "\u{FFFD}x");
        // The dangling partial sequence is flushed lossily at the end.
        assert_eq!(lines[5][2], "\u{FFFD}");
        assert_eq!(e.buffered(), 0);
    }

    #[test]
    fn stores_and_reads_back_a_cast() {
        let c = conn();
        let id = new(&c);
        let mut e = Encoder::new();
        e.output(0.1, b"login: ");
        assert!(append(&c, id, &e.take()).expect("append"));
        e.output(1.5, b"admin\r\nsw1# ");
        assert!(append(&c, id, &e.take()).expect("append"));
        finish(&c, id, "2026-01-02T10:00:02.000Z", 2000, false).expect("finish");

        let info = get(&c, id).expect("get").expect("exists");
        assert_eq!(info.title(), "ssh sw1");
        assert_eq!(info.duration_ms, 2000);
        assert!(info.bytes > 0);
        let file = cast(&c, id).expect("cast");
        let mut lines = file.lines();
        let header: serde_json::Value =
            serde_json::from_str(lines.next().expect("header")).expect("json");
        assert_eq!(header["version"], 2);
        assert_eq!(header["width"], 80);
        assert_eq!(header["timestamp"], 1_767_348_000);
        assert_eq!(lines.count(), 2);
        assert_eq!(transcript(&c, id).expect("text"), "login: admin\nsw1#\n");
        assert_eq!(list(&c).expect("list").len(), 1);
        delete(&c, id).expect("delete");
        assert!(list(&c).expect("list").is_empty());
        let chunks: i64 = c
            .query_row("SELECT COUNT(*) FROM recording_chunks", [], |r| r.get(0))
            .expect("count");
        assert_eq!(chunks, 0);
        assert!(matches!(cast(&c, id), Err(CoreError::Validation(_))));
    }

    #[test]
    fn stops_at_the_size_limit() {
        let c = conn();
        let id = new(&c);
        c.execute(
            "UPDATE recordings SET bytes = ?1 WHERE id = ?2",
            params![MAX_RECORDING_BYTES as i64 - 3, id],
        )
        .expect("near limit");
        assert!(!append(&c, id, b"[1.0, \"o\", \"x\"]\n").expect("append"));
        finish(&c, id, "2026-01-02T10:00:02.000Z", 2000, false).expect("finish");
        assert!(get(&c, id).expect("get").expect("exists").truncated);
    }
}
