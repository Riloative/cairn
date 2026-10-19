//! Port-forward presets per device: started with the device's SSH session when
//! `auto_start` is set, otherwise offered in the forwarding manager.

use crate::audit;
use crate::error::CoreError;
use crate::inventory::{record, validate};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForwardKind {
    /// Listen locally, connect from the server to `dest` (ssh -L).
    Local,
    /// Listen on the server, connect from here to `dest` (ssh -R).
    Remote,
    /// Local SOCKS5 proxy through the server (ssh -D).
    Dynamic,
}

impl ForwardKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
            Self::Dynamic => "dynamic",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "remote" => Self::Remote,
            "dynamic" => Self::Dynamic,
            _ => Self::Local,
        }
    }
}

/// A forward as configured (preset or ad hoc).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardSpec {
    pub kind: ForwardKind,
    /// Where to listen: locally for local/dynamic, on the server for remote.
    pub bind_host: String,
    /// 0 lets the OS (or the server) pick a free port.
    pub bind_port: u16,
    /// Where connections go; unused for dynamic forwards.
    #[serde(default)]
    pub dest_host: String,
    #[serde(default)]
    pub dest_port: u16,
}

impl ForwardSpec {
    /// Validate and normalize; the bind host defaults to the loopback address.
    pub fn clean(&self) -> Result<Self, CoreError> {
        let bind_host = match self.bind_host.trim() {
            "" => "127.0.0.1".to_owned(),
            h => host(h, "listen address")?,
        };
        let (dest_host, dest_port) = match self.kind {
            ForwardKind::Dynamic => (String::new(), 0),
            _ => {
                let h = self.dest_host.trim();
                if h.is_empty() {
                    return Err(CoreError::Validation("Enter the destination host.".into()));
                }
                (
                    host(h, "destination host")?,
                    validate::port(self.dest_port, "destination port")?,
                )
            }
        };
        Ok(Self {
            kind: self.kind,
            bind_host,
            bind_port: self.bind_port,
            dest_host,
            dest_port,
        })
    }

    /// `ssh`-style summary, e.g. `L 127.0.0.1:8443 → 10.0.0.5:443`.
    pub fn summary(&self) -> String {
        let bind = join(&self.bind_host, self.bind_port);
        match self.kind {
            ForwardKind::Local => format!("L {bind} → {}", join(&self.dest_host, self.dest_port)),
            ForwardKind::Remote => format!("R {bind} → {}", join(&self.dest_host, self.dest_port)),
            ForwardKind::Dynamic => format!("D {bind} (SOCKS5)"),
        }
    }
}

fn join(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// A hostname or IP address (IPv6 brackets removed).
fn host(value: &str, what: &str) -> Result<String, CoreError> {
    let v = value.trim().trim_start_matches('[').trim_end_matches(']');
    let ok = !v.is_empty()
        && v.len() <= 253
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '*'));
    if ok {
        Ok(v.to_owned())
    } else {
        Err(CoreError::Validation(format!(
            "\"{value}\" is not a valid {what}."
        )))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardPreset {
    #[serde(default)]
    pub id: i64,
    pub device_id: i64,
    #[serde(flatten)]
    pub spec: ForwardSpec,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub description: String,
}

const COLS: &str = "SELECT id, device_id, kind, bind_host, bind_port, dest_host, dest_port,
    auto_start, description FROM forward_presets";

fn row(r: &Row<'_>) -> rusqlite::Result<ForwardPreset> {
    let kind: String = r.get(2)?;
    Ok(ForwardPreset {
        id: r.get(0)?,
        device_id: r.get(1)?,
        spec: ForwardSpec {
            kind: ForwardKind::parse(&kind),
            bind_host: r.get(3)?,
            bind_port: r.get(4)?,
            dest_host: r.get(5)?,
            dest_port: r.get(6)?,
        },
        auto_start: r.get(7)?,
        description: r.get(8)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<ForwardPreset>, CoreError> {
    let mut stmt = conn.prepare(&format!("{COLS} ORDER BY device_id, id"))?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn for_device(conn: &Connection, device_id: i64) -> Result<Vec<ForwardPreset>, CoreError> {
    let mut stmt = conn.prepare(&format!("{COLS} WHERE device_id = ?1 ORDER BY id"))?;
    let rows = stmt.query_map([device_id], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn get(conn: &Connection, id: i64) -> Result<Option<ForwardPreset>, CoreError> {
    Ok(conn
        .query_row(&format!("{COLS} WHERE id = ?1"), [id], row)
        .optional()?)
}

fn device_name(conn: &Connection, id: i64) -> Result<String, CoreError> {
    conn.query_row("SELECT hostname FROM devices WHERE id = ?1", [id], |r| {
        r.get(0)
    })
    .optional()?
    .ok_or_else(|| CoreError::Validation("This device no longer exists.".into()))
}

pub fn save(conn: &Connection, input: &ForwardPreset) -> Result<ForwardPreset, CoreError> {
    let p = ForwardPreset {
        spec: input.spec.clean()?,
        description: validate::text(&input.description, "description", 200)?,
        ..input.clone()
    };
    let host = device_name(conn, p.device_id)?;
    let now = audit::now();
    let tx = conn.unchecked_transaction()?;
    let s = &p.spec;
    let (old, id) = if p.id == 0 {
        tx.execute(
            "INSERT INTO forward_presets (device_id, kind, bind_host, bind_port, dest_host,
             dest_port, auto_start, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                p.device_id,
                s.kind.as_str(),
                s.bind_host,
                s.bind_port,
                s.dest_host,
                s.dest_port,
                p.auto_start,
                p.description,
                now
            ],
        )?;
        (None, tx.last_insert_rowid())
    } else {
        let old = get(&tx, p.id)?
            .ok_or_else(|| CoreError::Validation("This preset no longer exists.".into()))?;
        tx.execute(
            "UPDATE forward_presets SET kind = ?2, bind_host = ?3, bind_port = ?4, dest_host = ?5,
             dest_port = ?6, auto_start = ?7, description = ?8, updated_at = ?9 WHERE id = ?1",
            params![
                p.id,
                s.kind.as_str(),
                s.bind_host,
                s.bind_port,
                s.dest_host,
                s.dest_port,
                p.auto_start,
                p.description,
                now
            ],
        )?;
        (Some(old), p.id)
    };
    let saved = ForwardPreset { id, ..p };
    let name = format!("{host}: {}", saved.spec.summary());
    record(&tx, "forward_preset", id, &name, old.as_ref(), Some(&saved))?;
    tx.commit()?;
    Ok(saved)
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), CoreError> {
    let tx = conn.unchecked_transaction()?;
    let Some(old) = get(&tx, id)? else {
        return Ok(());
    };
    let name = format!(
        "{}: {}",
        device_name(&tx, old.device_id)?,
        old.spec.summary()
    );
    tx.execute("DELETE FROM forward_presets WHERE id = ?1", [id])?;
    record(&tx, "forward_preset", id, &name, Some(&old), None)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inventory::testutil;

    fn spec(kind: ForwardKind) -> ForwardSpec {
        ForwardSpec {
            kind,
            bind_host: String::new(),
            bind_port: 8443,
            dest_host: "10.0.0.5".into(),
            dest_port: 443,
        }
    }

    #[test]
    fn clean_and_summary() {
        let s = spec(ForwardKind::Local).clean().expect("local");
        assert_eq!(s.bind_host, "127.0.0.1");
        assert_eq!(s.summary(), "L 127.0.0.1:8443 → 10.0.0.5:443");
        let d = spec(ForwardKind::Dynamic).clean().expect("dynamic");
        assert_eq!(d.dest_host, "");
        assert_eq!(d.summary(), "D 127.0.0.1:8443 (SOCKS5)");
        let mut bad = spec(ForwardKind::Remote);
        bad.dest_host = " ".into();
        assert!(bad.clean().is_err());
        bad.dest_host = "a b".into();
        assert!(bad.clean().is_err());
        let mut v6 = spec(ForwardKind::Local);
        v6.bind_host = "[::1]".into();
        assert_eq!(
            v6.clean().expect("v6").summary(),
            "L [::1]:8443 → 10.0.0.5:443"
        );
    }

    #[test]
    fn presets_are_audited_and_cascade_with_the_device() {
        let c = testutil::conn();
        let dev = testutil::device(&c, "sw1");
        let p = save(
            &c,
            &ForwardPreset {
                id: 0,
                device_id: dev,
                spec: spec(ForwardKind::Local),
                auto_start: true,
                description: "web UI".into(),
            },
        )
        .expect("save");
        assert_eq!(for_device(&c, dev).expect("list"), vec![p.clone()]);
        let changes = testutil::changes(&c);
        assert_eq!(changes[0]["name"], "sw1: L 127.0.0.1:8443 → 10.0.0.5:443");
        crate::inventory::devices::delete(&c, dev).expect("delete device");
        assert!(list(&c).expect("list").is_empty());
    }
}
