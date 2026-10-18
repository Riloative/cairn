//! Cairn's SSH known-hosts store (in the encrypted database).
//!
//! One trusted key per (host, port, key type). A server presenting a different key of a
//! type we already trust is a *changed* key; a key of a type we have never seen for a
//! host we know is treated as unknown (servers commonly have several host keys).

use crate::audit::{self, AuditEvent};
use crate::error::CoreError;
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key: String,
    pub first_seen: String,
    pub last_seen: String,
}

/// What we know about a presented key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum HostKeyStatus {
    Trusted,
    Unknown,
    Changed {
        #[serde(rename = "previousFingerprint")]
        previous_fingerprint: String,
    },
}

pub fn lookup(conn: &Connection, host: &str, port: u16) -> Result<Vec<KnownHost>, CoreError> {
    let mut stmt = conn.prepare(
        "SELECT host, port, key_type, fingerprint, public_key, first_seen, last_seen
         FROM known_hosts WHERE host = ?1 AND port = ?2 ORDER BY key_type",
    )?;
    let rows = stmt.query_map(params![host, port], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn all(conn: &Connection) -> Result<Vec<KnownHost>, CoreError> {
    let mut stmt = conn.prepare(
        "SELECT host, port, key_type, fingerprint, public_key, first_seen, last_seen
         FROM known_hosts ORDER BY host, port, key_type",
    )?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<KnownHost> {
    Ok(KnownHost {
        host: r.get(0)?,
        port: r.get(1)?,
        key_type: r.get(2)?,
        fingerprint: r.get(3)?,
        public_key: r.get(4)?,
        first_seen: r.get(5)?,
        last_seen: r.get(6)?,
    })
}

/// Classify a presented key against stored entries.
pub fn status(known: &[KnownHost], key_type: &str, public_key: &str) -> HostKeyStatus {
    match known.iter().find(|k| k.key_type == key_type) {
        Some(k) if k.public_key == public_key => HostKeyStatus::Trusted,
        Some(k) => HostKeyStatus::Changed {
            previous_fingerprint: k.fingerprint.clone(),
        },
        None => HostKeyStatus::Unknown,
    }
}

/// Trust a key (first use or replacing a changed key) and audit the decision.
pub fn trust(
    conn: &Connection,
    host: &str,
    port: u16,
    key_type: &str,
    fingerprint: &str,
    public_key: &str,
) -> Result<(), CoreError> {
    let previous = lookup(conn, host, port)?
        .into_iter()
        .find(|k| k.key_type == key_type);
    let now = audit::now();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO known_hosts (host, port, key_type, fingerprint, public_key, first_seen, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(host, port, key_type) DO UPDATE SET
           fingerprint = excluded.fingerprint, public_key = excluded.public_key,
           first_seen = excluded.first_seen, last_seen = excluded.last_seen",
        params![host, port, key_type, fingerprint, public_key, now],
    )?;
    audit::append(
        &tx,
        &AuditEvent::HostKeyTrusted {
            host: host.to_owned(),
            port,
            key_type: key_type.to_owned(),
            fingerprint: fingerprint.to_owned(),
            replaced_fingerprint: previous.map(|p| p.fingerprint),
        },
    )?;
    tx.commit()?;
    Ok(())
}

/// Record that a trusted key was seen again.
pub fn touch(conn: &Connection, host: &str, port: u16, key_type: &str) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE known_hosts SET last_seen = ?4 WHERE host = ?1 AND port = ?2 AND key_type = ?3",
        params![host, port, key_type, audit::now()],
    )?;
    Ok(())
}

/// Forget a host key (Settings → Known hosts).
pub fn remove(conn: &Connection, host: &str, port: u16, key_type: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM known_hosts WHERE host = ?1 AND port = ?2 AND key_type = ?3",
        params![host, port, key_type],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use zeroize::Zeroizing;

    fn conn() -> Connection {
        db::open_in_memory(&Zeroizing::new([5u8; 32])).expect("db")
    }

    #[test]
    fn unknown_then_trusted_then_changed() {
        let c = conn();
        let known = lookup(&c, "sw1", 22).expect("lookup");
        assert_eq!(
            status(&known, "ssh-ed25519", "ssh-ed25519 AAA"),
            HostKeyStatus::Unknown
        );

        trust(
            &c,
            "sw1",
            22,
            "ssh-ed25519",
            "SHA256:aaa",
            "ssh-ed25519 AAA",
        )
        .expect("trust");
        let known = lookup(&c, "sw1", 22).expect("lookup");
        assert_eq!(
            status(&known, "ssh-ed25519", "ssh-ed25519 AAA"),
            HostKeyStatus::Trusted
        );
        assert_eq!(
            status(&known, "ssh-ed25519", "ssh-ed25519 BBB"),
            HostKeyStatus::Changed {
                previous_fingerprint: "SHA256:aaa".into()
            }
        );
        // Another key type for a known host is unknown, not changed.
        assert_eq!(
            status(&known, "ssh-rsa", "ssh-rsa CCC"),
            HostKeyStatus::Unknown
        );
        // Ports are distinct hosts.
        assert!(lookup(&c, "sw1", 2222).expect("lookup").is_empty());
    }

    #[test]
    fn replacing_a_key_is_audited_with_the_old_fingerprint() {
        let c = conn();
        trust(&c, "sw1", 22, "ssh-rsa", "SHA256:old", "ssh-rsa OLD").expect("trust");
        trust(&c, "sw1", 22, "ssh-rsa", "SHA256:new", "ssh-rsa NEW").expect("replace");
        let known = lookup(&c, "sw1", 22).expect("lookup");
        assert_eq!(known.len(), 1);
        assert_eq!(known[0].fingerprint, "SHA256:new");
        let entries = audit::recent(&c, 1).expect("audit");
        assert_eq!(entries[0].kind, "host_key_trusted");
        assert_eq!(entries[0].payload["replacedFingerprint"], "SHA256:old");
    }

    #[test]
    fn touch_and_remove() {
        let c = conn();
        trust(&c, "h", 22, "ssh-ed25519", "f", "k").expect("trust");
        touch(&c, "h", 22, "ssh-ed25519").expect("touch");
        assert_eq!(all(&c).expect("all").len(), 1);
        remove(&c, "h", 22, "ssh-ed25519").expect("remove");
        assert!(all(&c).expect("all").is_empty());
    }
}
