//! Encrypted SQLite (SQLCipher) database and schema migrations.

use crate::error::CoreError;
use crate::secret::Key256;
use rusqlite::Connection;
use std::path::Path;
use zeroize::Zeroizing;

/// Ordered schema migrations. The index + 1 is the schema version stored in
/// `PRAGMA user_version`. Never edit a released migration; append a new one.
const MIGRATIONS: &[&str] = &[
    include_str!("migrations/0001_init.sql"),
    include_str!("migrations/0002_known_hosts.sql"),
    include_str!("migrations/0003_inventory.sql"),
    include_str!("migrations/0004_map.sql"),
    include_str!("migrations/0005_tools.sql"),
    include_str!("migrations/0006_audit_retention.sql"),
    include_str!("migrations/0007_recordings.sql"),
];

/// Latest schema version this build knows.
pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

/// Open (or create) the SQLCipher database at `path` with a raw 256-bit key, verify the
/// key, and apply pending migrations.
///
/// A wrong key surfaces as [`CoreError::WrongPassword`].
pub fn open(path: &Path, key: &Key256) -> Result<Connection, CoreError> {
    let conn = Connection::open(path)?;
    apply_key(&conn, key)?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Open with a key but without configuring or migrating (backup copies, which must
/// stay single-file: no WAL).
pub(crate) fn open_keyed(path: &Path, key: &Key256) -> Result<Connection, CoreError> {
    let conn = Connection::open(path)?;
    apply_key(&conn, key)?;
    Ok(conn)
}

/// The raw-key form SQLCipher accepts in `PRAGMA key` and `ATTACH … KEY`.
pub(crate) fn key_literal(key: &Key256) -> Zeroizing<String> {
    Zeroizing::new(format!("x'{}'", hex::encode(key.as_ref())))
}

/// Open an in-memory encrypted database (tests and dry runs).
pub fn open_in_memory(key: &Key256) -> Result<Connection, CoreError> {
    let conn = Connection::open_in_memory()?;
    apply_key(&conn, key)?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

fn apply_key(conn: &Connection, key: &Key256) -> Result<(), CoreError> {
    // Raw-key form: SQLCipher skips its own PBKDF2 because we already ran Argon2id.
    let pragma = Zeroizing::new(format!(
        "PRAGMA key = \"x'{}'\";",
        hex::encode(key.as_ref())
    ));
    conn.execute_batch(&pragma)?;
    // The key is only checked on first read. SQLITE_NOTADB here means a wrong key.
    match conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
        r.get::<_, i64>(0)
    }) {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::NotADatabase =>
        {
            Err(CoreError::WrongPassword)
        }
        Err(e) => Err(e.into()),
    }
}

/// Re-encrypt the database under a new key (master password change).
pub fn rekey(conn: &Connection, new_key: &Key256) -> Result<(), CoreError> {
    let pragma = Zeroizing::new(format!(
        "PRAGMA rekey = \"x'{}'\";",
        hex::encode(new_key.as_ref())
    ));
    conn.execute_batch(&pragma)?;
    Ok(())
}

fn configure(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA secure_delete = ON;",
    )?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<(), CoreError> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current > SCHEMA_VERSION {
        return Err(CoreError::SchemaTooNew {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    for (idx, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let version = idx as i64 + 1;
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}

/// Current schema version of an open database.
pub fn schema_version(conn: &Connection) -> Result<i64, CoreError> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(b: u8) -> Key256 {
        Zeroizing::new([b; 32])
    }

    #[test]
    fn creates_and_migrates_a_new_database() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("cairn.db");
        let conn = open(&path, &key(1)).expect("open");
        assert_eq!(schema_version(&conn).expect("version"), SCHEMA_VERSION);
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name IN ('settings', 'audit_log')",
                [],
                |r| r.get(0),
            )
            .expect("query");
        assert_eq!(n, 2);
    }

    #[test]
    fn reopening_with_the_same_key_works_and_is_idempotent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("cairn.db");
        open(&path, &key(1))
            .expect("open")
            .execute("INSERT INTO settings VALUES ('a', '1')", [])
            .expect("insert");
        let conn = open(&path, &key(1)).expect("reopen");
        let v: String = conn
            .query_row("SELECT value FROM settings WHERE key='a'", [], |r| r.get(0))
            .expect("row");
        assert_eq!(v, "1");
    }

    #[test]
    fn wrong_key_is_reported_as_wrong_password() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("cairn.db");
        drop(open(&path, &key(1)).expect("open"));
        assert!(matches!(
            open(&path, &key(2)),
            Err(CoreError::WrongPassword)
        ));
    }

    #[test]
    fn file_on_disk_is_encrypted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("cairn.db");
        let conn = open(&path, &key(7)).expect("open");
        conn.execute(
            "INSERT INTO settings VALUES ('marker', 'PLAINTEXT_MARKER')",
            [],
        )
        .expect("insert");
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .expect("checkpoint");
        drop(conn);
        let bytes = std::fs::read(&path).expect("read");
        assert!(!bytes.starts_with(b"SQLite format 3"));
        let needle = b"PLAINTEXT_MARKER";
        assert!(!bytes.windows(needle.len()).any(|w| w == needle));
    }

    #[test]
    fn rekey_changes_the_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("cairn.db");
        let conn = open(&path, &key(1)).expect("open");
        rekey(&conn, &key(2)).expect("rekey");
        drop(conn);
        assert!(matches!(
            open(&path, &key(1)),
            Err(CoreError::WrongPassword)
        ));
        assert!(open(&path, &key(2)).is_ok());
    }

    #[test]
    fn refuses_a_newer_schema() {
        let conn = open_in_memory(&key(1)).expect("open");
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .expect("pragma");
        assert!(matches!(
            migrate(&conn),
            Err(CoreError::SchemaTooNew { .. })
        ));
    }
}
