//! Encrypted full backups (`.cairn-backup`) and restore.
//!
//! A backup is the whole database (inventory, credentials, settings, snippets, floor
//! plans, config snapshots, audit log and optionally recordings) as a SQLCipher database
//! keyed with Argon2id of a password chosen at export:
//!
//! ```text
//! "CAIRNBK" 0x01 | u32 BE header length | header JSON | SQLCipher database bytes
//! ```
//!
//! The copy is made with `sqlcipher_export` into a database that is encrypted from the
//! first page, so no unencrypted copy ever touches the disk. The header holds only what
//! is needed to derive the key and describe the backup; it is not secret. A wrong
//! password or a modified file fails SQLCipher's per-page HMAC.

use crate::db::{self, SCHEMA_VERSION};
use crate::error::CoreError;
use crate::kdf::{self, KdfParams};
use crate::secret::SecretString;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const MAGIC: &[u8; 8] = b"CAIRNBK\x01";
const FORMAT: u32 = 1;
/// Header JSON larger than this is not a Cairn backup.
const MAX_HEADER: u32 = 64 * 1024;
/// Backup passwords follow the master password rule.
pub const MIN_PASSWORD_LEN: usize = crate::vault::MIN_PASSWORD_LEN;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupHeader {
    pub format: u32,
    pub created_at: String,
    pub app_version: String,
    pub schema_version: i64,
    pub recordings: bool,
    pub kdf: KdfParams,
}

/// What a backup holds, shown before and after export/restore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub created_at: String,
    pub app_version: String,
    pub schema_version: i64,
    pub recordings: bool,
    pub bytes: u64,
}

/// Deletes a temporary file when dropped (also on error paths).
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn temp_path(dir: &Path, what: &str) -> Result<PathBuf, CoreError> {
    let tag = hex::encode(kdf::random_bytes::<8>()?);
    Ok(dir.join(format!(".{what}-{tag}.tmp")))
}

fn io(path: &Path) -> impl Fn(std::io::Error) -> CoreError + '_ {
    move |e| CoreError::io(path, e)
}

fn check_password(password: &SecretString) -> Result<(), CoreError> {
    if password.len() < MIN_PASSWORD_LEN {
        return Err(CoreError::Validation(format!(
            "The backup password must be at least {MIN_PASSWORD_LEN} characters."
        )));
    }
    Ok(())
}

/// Write a backup of the open database `conn` to `out`.
///
/// `work_dir` holds the temporary encrypted copy (the data directory, so the copy never
/// leaves the vault's file system).
pub fn export(
    conn: &Connection,
    work_dir: &Path,
    out: &Path,
    password: &SecretString,
    params: KdfParams,
    include_recordings: bool,
    app_version: &str,
) -> Result<BackupSummary, CoreError> {
    check_password(password)?;
    let key = kdf::derive_key(password, &params)?;
    let tmp = TempFile(temp_path(work_dir, "backup")?);
    let path = tmp.0.to_str().ok_or_else(|| {
        CoreError::Validation("The data directory path is not valid UTF-8.".into())
    })?;
    let schema = db::schema_version(conn)?;
    conn.execute(
        "ATTACH DATABASE ?1 AS backup KEY ?2",
        rusqlite::params![path, db::key_literal(&key).as_str()],
    )?;
    let copied = (|| {
        conn.query_row("SELECT sqlcipher_export('backup')", [], |_| Ok(()))?;
        conn.execute_batch(&format!("PRAGMA backup.user_version = {schema}"))?;
        if !include_recordings {
            conn.execute_batch(
                "DELETE FROM backup.recording_chunks; DELETE FROM backup.recordings;",
            )?;
        }
        Ok::<_, CoreError>(())
    })();
    conn.execute_batch("DETACH DATABASE backup")?;
    copied?;
    // Compact (and drop the pages of removed recordings for good).
    db::open_keyed(&tmp.0, &key)?.execute_batch("VACUUM")?;

    let header = BackupHeader {
        format: FORMAT,
        created_at: crate::audit::now(),
        app_version: app_version.to_owned(),
        schema_version: schema,
        recordings: include_recordings,
        kdf: params,
    };
    let header_json = serde_json::to_vec(&header)?;
    let partial = out.with_extension("cairn-backup.partial");
    {
        let mut f = fs::File::create(&partial).map_err(io(&partial))?;
        f.write_all(MAGIC).map_err(io(&partial))?;
        f.write_all(&(header_json.len() as u32).to_be_bytes())
            .map_err(io(&partial))?;
        f.write_all(&header_json).map_err(io(&partial))?;
        let mut db_file = fs::File::open(&tmp.0).map_err(io(&tmp.0))?;
        std::io::copy(&mut db_file, &mut f).map_err(io(&partial))?;
        f.sync_all().map_err(io(&partial))?;
    }
    fs::rename(&partial, out).map_err(io(out))?;
    let bytes = fs::metadata(out).map_err(io(out))?.len();
    Ok(BackupSummary {
        created_at: header.created_at,
        app_version: header.app_version,
        schema_version: schema,
        recordings: include_recordings,
        bytes,
    })
}

/// Read the header of a backup file (no password needed).
pub fn read_header(path: &Path) -> Result<(BackupHeader, u64), CoreError> {
    let not_backup = || CoreError::Validation("This file is not a Cairn backup.".into());
    let data = fs::read(path).map_err(io(path))?;
    if data.len() < 12 || &data[..8] != MAGIC {
        return Err(not_backup());
    }
    let len = u32::from_be_bytes([data[8], data[9], data[10], data[11]]);
    if len > MAX_HEADER || data.len() < 12 + len as usize {
        return Err(not_backup());
    }
    let header: BackupHeader =
        serde_json::from_slice(&data[12..12 + len as usize]).map_err(|_| not_backup())?;
    if header.format != FORMAT {
        return Err(CoreError::Validation(
            "This backup was made by a newer version of Cairn. Update Cairn to restore it.".into(),
        ));
    }
    Ok((header, 12 + u64::from(len)))
}

pub fn summary(path: &Path) -> Result<BackupSummary, CoreError> {
    let (h, _) = read_header(path)?;
    Ok(BackupSummary {
        created_at: h.created_at,
        app_version: h.app_version,
        schema_version: h.schema_version,
        recordings: h.recordings,
        bytes: fs::metadata(path).map_err(io(path))?.len(),
    })
}

/// Decrypt a backup into `dest` (a new file) re-keyed with `new_key`, migrated to this
/// build's schema. A wrong password is [`CoreError::WrongPassword`].
pub fn restore_to(
    backup: &Path,
    password: &SecretString,
    dest: &Path,
    new_key: &crate::secret::Key256,
) -> Result<BackupHeader, CoreError> {
    let (header, offset) = read_header(backup)?;
    if header.schema_version > SCHEMA_VERSION {
        return Err(CoreError::SchemaTooNew {
            found: header.schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    let key = kdf::derive_key(password, &header.kdf)?;
    let data = fs::read(backup).map_err(io(backup))?;
    let body = data.get(offset as usize..).unwrap_or_default();
    fs::write(dest, body).map_err(io(dest))?;
    let restored = (|| {
        let conn = db::open_keyed(dest, &key)?;
        let ok: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if ok != "ok" {
            return Err(CoreError::Validation(
                "The backup is damaged and cannot be restored.".into(),
            ));
        }
        db::rekey(&conn, new_key)?;
        drop(conn);
        // Upgrade older backups to this build's schema.
        drop(db::open(dest, new_key)?);
        Ok(())
    })();
    if let Err(e) = restored {
        let _ = fs::remove_file(dest);
        // A page that fails its HMAC past the first one means a damaged file (the first
        // page failing is reported as a wrong password).
        return Err(match e {
            CoreError::Database(_) => {
                CoreError::Validation("The backup file is damaged and cannot be restored.".into())
            }
            other => other,
        });
    }
    Ok(header)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inventory::devices;
    use crate::kdf::fast_params;
    use crate::recording::{self, NewRecording};
    use crate::vault::{Vault, VaultStatus};

    const MASTER: &str = "correct horse battery";
    const BACKUP_PW: &str = "backup password 42";

    fn pw(s: &str) -> SecretString {
        SecretString::from(s)
    }

    /// A vault with one device and one recording.
    fn source(dir: &Path) -> Vault {
        let mut v = Vault::new(dir);
        v.setup_with_params(&pw(MASTER), fast_params())
            .expect("setup");
        v.with_conn(|c| {
            devices::save(c, &devices::tests::device("unique-core-sw1"))?;
            let id = recording::start(
                c,
                &NewRecording {
                    session_id: "s1".into(),
                    protocol: "ssh".into(),
                    target: "10.0.0.1:22".into(),
                    device_id: None,
                    device: String::new(),
                    cols: 80,
                    rows: 24,
                    started_at: crate::audit::now(),
                },
            )?;
            recording::append(c, id, b"[0.1, \"o\", \"secret-ish output\"]\n")?;
            Ok(())
        })
        .expect("seed");
        v
    }

    fn backup(v: &Vault, out: &Path, recordings: bool) -> BackupSummary {
        v.with_conn(|c| {
            export(
                c,
                v.dir(),
                out,
                &pw(BACKUP_PW),
                fast_params(),
                recordings,
                "0.1.0",
            )
        })
        .expect("export")
    }

    fn hostnames(v: &Vault) -> Vec<String> {
        v.with_conn(devices::list)
            .expect("list")
            .into_iter()
            .map(|d| d.hostname)
            .collect()
    }

    #[test]
    fn round_trip_into_a_new_install_without_plaintext_on_disk() {
        let tmp = tempfile::tempdir().expect("tmp");
        let src = source(&tmp.path().join("src"));
        let file = tmp.path().join("all.cairn-backup");
        let summary = backup(&src, &file, true);
        assert!(summary.recordings);
        assert!(summary.bytes > 0);
        // Encrypted: neither the hostname nor recorded output is readable.
        let raw = fs::read(&file).expect("read");
        let text = String::from_utf8_lossy(&raw);
        assert!(!text.contains("unique-core-sw1"));
        assert!(!text.contains("secret-ish"));
        // No temporary copies are left behind.
        let leftovers: Vec<_> = fs::read_dir(src.dir())
            .expect("dir")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());

        let header = summary_of(&file);
        assert_eq!(header.schema_version, SCHEMA_VERSION);

        let mut fresh = Vault::new(tmp.path().join("new"));
        let wrong = fresh.restore_with_params(&file, &pw("not the password"), &pw(MASTER), || {
            Ok(fast_params())
        });
        assert!(matches!(wrong, Err(CoreError::WrongPassword)));
        assert_eq!(fresh.status(), VaultStatus::Uninitialized);

        fresh
            .restore_with_params(&file, &pw(BACKUP_PW), &pw("a new master password"), || {
                Ok(fast_params())
            })
            .expect("restore");
        assert_eq!(hostnames(&fresh), vec!["unique-core-sw1"]);
        assert_eq!(fresh.with_conn(recording::list).expect("list").len(), 1);
        // The new master password unlocks the restored data.
        fresh.lock(crate::audit::LockReason::Manual).expect("lock");
        fresh.unlock(&pw("a new master password")).expect("unlock");
        let report = fresh.with_conn(crate::audit::verify).expect("verify");
        assert!(report.ok);
        let last = fresh
            .with_conn(|c| crate::audit::recent(c, 5))
            .expect("recent");
        assert!(last.iter().any(|e| e.kind == "backup_restored"));
    }

    fn summary_of(path: &Path) -> BackupSummary {
        summary(path).expect("summary")
    }

    #[test]
    fn without_recordings_and_into_an_unlocked_vault() {
        let tmp = tempfile::tempdir().expect("tmp");
        let src = source(&tmp.path().join("src"));
        let file = tmp.path().join("small.cairn-backup");
        assert!(!backup(&src, &file, false).recordings);

        let mut target = Vault::new(tmp.path().join("target"));
        target
            .setup_with_params(&pw(MASTER), fast_params())
            .expect("setup");
        target
            .with_conn(|c| {
                devices::save(c, &devices::tests::device("will-be-replaced")).map(|_| ())
            })
            .expect("seed");
        // The current master password is required.
        let refused =
            target.restore_with_params(&file, &pw(BACKUP_PW), &pw("wrong master pw"), || {
                Ok(fast_params())
            });
        assert!(matches!(refused, Err(CoreError::WrongPassword)));
        assert_eq!(hostnames(&target), vec!["will-be-replaced"]);

        target
            .restore_with_params(&file, &pw(BACKUP_PW), &pw(MASTER), || Ok(fast_params()))
            .expect("restore");
        assert_eq!(hostnames(&target), vec!["unique-core-sw1"]);
        assert!(target.with_conn(recording::list).expect("list").is_empty());
        assert!(!target.dir().join("cairn.db.before-restore").exists());
    }

    #[test]
    fn rejects_other_and_damaged_files_and_keeps_current_data() {
        let tmp = tempfile::tempdir().expect("tmp");
        let src = source(&tmp.path().join("src"));
        let not_backup = tmp.path().join("notes.txt");
        fs::write(&not_backup, "hello").expect("write");
        assert!(matches!(
            summary(&not_backup),
            Err(CoreError::Validation(_))
        ));

        let file = tmp.path().join("b.cairn-backup");
        backup(&src, &file, true);
        let mut data = fs::read(&file).expect("read");
        let n = data.len();
        data[n - 100] ^= 0xFF;
        let damaged = tmp.path().join("damaged.cairn-backup");
        fs::write(&damaged, &data).expect("write");

        let mut target = Vault::new(tmp.path().join("target"));
        target
            .setup_with_params(&pw(MASTER), fast_params())
            .expect("setup");
        let r =
            target.restore_with_params(&damaged, &pw(BACKUP_PW), &pw(MASTER), || Ok(fast_params()));
        assert!(
            matches!(&r, Err(CoreError::Validation(m)) if m.contains("damaged")),
            "{r:?}"
        );
        assert_eq!(target.status(), VaultStatus::Unlocked);
        assert!(hostnames(&target).is_empty());
        // Short backup passwords are refused up front.
        let short = src.with_conn(|c| {
            export(
                c,
                src.dir(),
                &tmp.path().join("x"),
                &pw("short"),
                fast_params(),
                true,
                "0.1.0",
            )
        });
        assert!(matches!(short, Err(CoreError::Validation(_))));
    }
}
