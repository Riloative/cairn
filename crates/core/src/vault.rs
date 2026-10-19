//! Master-password vault: setup, unlock, lock and password change.
//!
//! On disk, the data directory holds:
//! - `vault.json` — format version and Argon2id parameters (salt, costs). Not secret.
//! - `cairn.db` — the SQLCipher database, keyed with the Argon2id output.
//! - `unlock-failures.json` — timestamps of failed unlock attempts made while locked
//!   (the encrypted audit log is unreachable then). They are moved into the audit log on
//!   the next successful unlock. Contains no secrets.
//!
//! There is no separate password verifier: SQLCipher's per-page HMAC rejects a wrong key.

use crate::audit::{self, AuditEvent, LockReason};
use crate::db;
use crate::error::CoreError;
use crate::kdf::{self, KdfParams};
use crate::secret::SecretString;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Minimum master password length enforced by the backend (the UI also shows strength).
pub const MIN_PASSWORD_LEN: usize = 10;

const VAULT_FILE: &str = "vault.json";
const PENDING_VAULT_FILE: &str = "vault.json.next";
const DB_FILE: &str = "cairn.db";
const FAILURES_FILE: &str = "unlock-failures.json";
const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    created_at: String,
    kdf: KdfParams,
}

/// Lifecycle state, as shown to the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultStatus {
    /// First launch: no master password yet.
    Uninitialized,
    Locked,
    Unlocked,
}

/// The vault for one data directory.
#[derive(Debug)]
pub struct Vault {
    dir: PathBuf,
    conn: Option<Connection>,
}

impl Vault {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            conn: None,
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn db_path(&self) -> PathBuf {
        self.dir.join(DB_FILE)
    }

    pub fn status(&self) -> VaultStatus {
        if self.conn.is_some() {
            VaultStatus::Unlocked
        } else if self.dir.join(VAULT_FILE).exists() {
            VaultStatus::Locked
        } else {
            VaultStatus::Uninitialized
        }
    }

    /// First-launch setup with calibrated Argon2id parameters.
    pub fn setup(&mut self, password: &SecretString) -> Result<(), CoreError> {
        self.setup_with_params(password, KdfParams::calibrate()?)
    }

    /// Setup with explicit parameters (tests use cheap ones).
    pub fn setup_with_params(
        &mut self,
        password: &SecretString,
        params: KdfParams,
    ) -> Result<(), CoreError> {
        if self.status() != VaultStatus::Uninitialized {
            return Err(CoreError::AlreadyInitialized);
        }
        check_password_policy(password)?;
        fs::create_dir_all(&self.dir).map_err(|e| CoreError::io(&self.dir, e))?;
        if self.db_path().exists() {
            // A database without vault metadata: refuse rather than overwrite user data.
            return Err(CoreError::CorruptVaultFile(format!(
                "{} exists but {VAULT_FILE} is missing",
                self.db_path().display()
            )));
        }
        let key = kdf::derive_key(password, &params)?;
        let conn = db::open(&self.db_path(), &key)?;
        let file = VaultFile {
            version: FORMAT_VERSION,
            created_at: audit::now(),
            kdf: params,
        };
        write_json_atomic(&self.dir.join(VAULT_FILE), &file)?;
        audit::append(&conn, &AuditEvent::VaultCreated)?;
        audit::append(&conn, &AuditEvent::AppUnlocked)?;
        self.conn = Some(conn);
        Ok(())
    }

    /// Unlock with the master password. A wrong password is recorded in the failure
    /// sidecar and returns [`CoreError::WrongPassword`].
    pub fn unlock(&mut self, password: &SecretString) -> Result<(), CoreError> {
        match self.status() {
            VaultStatus::Uninitialized => return Err(CoreError::NotInitialized),
            VaultStatus::Unlocked => return Ok(()),
            VaultStatus::Locked => {}
        }
        let conn = match self.open_with(password, VAULT_FILE) {
            Err(CoreError::WrongPassword) if self.dir.join(PENDING_VAULT_FILE).exists() => {
                // An interrupted password change: the database may already use the new key.
                let conn = self.open_with(password, PENDING_VAULT_FILE);
                if conn.is_ok() {
                    self.finish_pending_change()?;
                }
                conn
            }
            other => other,
        };
        let conn = match conn {
            Ok(c) => c,
            Err(CoreError::WrongPassword) => {
                self.record_failure()?;
                return Err(CoreError::WrongPassword);
            }
            Err(e) => return Err(e),
        };
        self.flush_failures(&conn)?;
        audit::append(&conn, &AuditEvent::AppUnlocked)?;
        let retention = crate::settings::load(&conn)?.audit_retention_days;
        audit::apply_retention(&conn, retention, &audit::now())?;
        self.conn = Some(conn);
        Ok(())
    }

    /// Lock: audit, then close the database (SQLCipher wipes its key on close).
    pub fn lock(&mut self, reason: LockReason) -> Result<(), CoreError> {
        if let Some(conn) = self.conn.take() {
            audit::append(&conn, &AuditEvent::AppLocked { reason })?;
            conn.close().map_err(|(_, e)| CoreError::Database(e))?;
        }
        Ok(())
    }

    /// Change the master password. Crash-safe: the new parameters are written to a
    /// pending file before the database is re-keyed, and unlock tries both.
    pub fn change_password(
        &mut self,
        current: &SecretString,
        new: &SecretString,
    ) -> Result<(), CoreError> {
        self.change_password_with_params(current, new, KdfParams::calibrate()?)
    }

    pub fn change_password_with_params(
        &mut self,
        current: &SecretString,
        new: &SecretString,
        params: KdfParams,
    ) -> Result<(), CoreError> {
        check_password_policy(new)?;
        // Re-verify the current password even while unlocked.
        let file = self.read_vault_file(VAULT_FILE)?;
        let current_key = kdf::derive_key(current, &file.kdf)?;
        drop(db::open(&self.db_path(), &current_key)?);
        let conn = self.conn.as_ref().ok_or(CoreError::Locked)?;

        let new_key = kdf::derive_key(new, &params)?;
        let pending = VaultFile {
            version: FORMAT_VERSION,
            created_at: file.created_at,
            kdf: params,
        };
        write_json_atomic(&self.dir.join(PENDING_VAULT_FILE), &pending)?;
        db::rekey(conn, &new_key)?;
        self.finish_pending_change()?;
        audit::append(conn, &AuditEvent::MasterPasswordChanged)?;
        Ok(())
    }

    /// The Argon2id parameters of the master password (for backups made with fresh
    /// salts but the same costs).
    pub fn kdf_params(&self) -> Result<KdfParams, CoreError> {
        Ok(self.read_vault_file(VAULT_FILE)?.kdf)
    }

    /// Replace all data with a backup.
    ///
    /// On first launch `master` becomes the master password. When unlocked it must be
    /// the current master password (restoring replaces everything, so it is confirmed).
    /// The current database is kept until the restored one has opened.
    pub fn restore(
        &mut self,
        backup: &Path,
        backup_password: &SecretString,
        master: &SecretString,
    ) -> Result<crate::backup::BackupHeader, CoreError> {
        self.restore_with_params(backup, backup_password, master, KdfParams::calibrate)
    }

    pub fn restore_with_params(
        &mut self,
        backup: &Path,
        backup_password: &SecretString,
        master: &SecretString,
        new_params: impl FnOnce() -> Result<KdfParams, CoreError>,
    ) -> Result<crate::backup::BackupHeader, CoreError> {
        let first_launch = match self.status() {
            VaultStatus::Locked => return Err(CoreError::Locked),
            VaultStatus::Uninitialized => true,
            VaultStatus::Unlocked => false,
        };
        let params = if first_launch {
            check_password_policy(master)?;
            if self.db_path().exists() {
                // As in setup: never replace a database whose metadata is missing.
                return Err(CoreError::CorruptVaultFile(format!(
                    "{} exists but {VAULT_FILE} is missing",
                    self.db_path().display()
                )));
            }
            new_params()?
        } else {
            self.kdf_params()?
        };
        let key = kdf::derive_key(master, &params)?;
        if !first_launch {
            // Confirm the master password before replacing everything.
            drop(db::open(&self.db_path(), &key)?);
        }
        fs::create_dir_all(&self.dir).map_err(|e| CoreError::io(&self.dir, e))?;
        let tag = hex::encode(kdf::random_bytes::<8>()?);
        let tmp = self.dir.join(format!(".restore-{tag}.tmp"));
        let header = crate::backup::restore_to(backup, backup_password, &tmp, &key)?;

        let db = self.db_path();
        let previous = self.dir.join(format!("{DB_FILE}.before-restore"));
        if let Some(conn) = self.conn.take() {
            conn.close().map_err(|(_, e)| CoreError::Database(e))?;
        }
        if db.exists() {
            fs::rename(&db, &previous).map_err(|e| CoreError::io(&db, e))?;
        }
        let swapped = fs::rename(&tmp, &db)
            .map_err(|e| CoreError::io(&db, e))
            .and_then(|()| db::open(&db, &key));
        let conn = match swapped {
            Ok(conn) => conn,
            Err(e) => {
                // Put the previous database back and stay where we were.
                let _ = fs::remove_file(&tmp);
                if previous.exists() {
                    let _ = fs::rename(&previous, &db);
                    if !first_launch {
                        self.conn = db::open(&db, &key).ok();
                    }
                }
                return Err(e);
            }
        };
        if first_launch {
            let file = VaultFile {
                version: FORMAT_VERSION,
                created_at: audit::now(),
                kdf: params,
            };
            write_json_atomic(&self.dir.join(VAULT_FILE), &file)?;
        }
        audit::append(
            &conn,
            &AuditEvent::BackupRestored {
                backup_created_at: header.created_at.clone(),
                app_version: header.app_version.clone(),
                recordings: header.recordings,
            },
        )?;
        self.conn = Some(conn);
        let _ = fs::remove_file(&previous);
        Ok(header)
    }

    /// Run a closure with the open database.
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        f(self.conn.as_ref().ok_or(CoreError::Locked)?)
    }

    fn open_with(&self, password: &SecretString, file: &str) -> Result<Connection, CoreError> {
        let vf = self.read_vault_file(file)?;
        let key = kdf::derive_key(password, &vf.kdf)?;
        db::open(&self.db_path(), &key)
    }

    fn finish_pending_change(&self) -> Result<(), CoreError> {
        let from = self.dir.join(PENDING_VAULT_FILE);
        let to = self.dir.join(VAULT_FILE);
        fs::rename(&from, &to).map_err(|e| CoreError::io(&to, e))
    }

    fn read_vault_file(&self, name: &str) -> Result<VaultFile, CoreError> {
        let path = self.dir.join(name);
        let raw = fs::read_to_string(&path).map_err(|e| CoreError::io(&path, e))?;
        let vf: VaultFile = serde_json::from_str(&raw)
            .map_err(|e| CoreError::CorruptVaultFile(format!("{name}: {e}")))?;
        if vf.version != FORMAT_VERSION {
            return Err(CoreError::CorruptVaultFile(format!(
                "{name}: unsupported format version {}",
                vf.version
            )));
        }
        Ok(vf)
    }

    fn failures_path(&self) -> PathBuf {
        self.dir.join(FAILURES_FILE)
    }

    fn pending_failures(&self) -> Result<Vec<String>, CoreError> {
        let path = self.failures_path();
        match fs::read_to_string(&path) {
            // A damaged sidecar must not block unlocking; keep what can be parsed.
            Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(CoreError::io(&path, e)),
        }
    }

    /// Number of failed unlock attempts since the last successful unlock.
    pub fn failed_attempts(&self) -> Result<usize, CoreError> {
        Ok(self.pending_failures()?.len())
    }

    fn record_failure(&self) -> Result<(), CoreError> {
        let mut list = self.pending_failures()?;
        list.push(audit::now());
        write_json_atomic(&self.failures_path(), &list)
    }

    fn flush_failures(&self, conn: &Connection) -> Result<(), CoreError> {
        let list = self.pending_failures()?;
        for at in list {
            audit::append(conn, &AuditEvent::UnlockFailed { at })?;
        }
        let path = self.failures_path();
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(CoreError::io(&path, e)),
        }
    }
}

fn check_password_policy(password: &SecretString) -> Result<(), CoreError> {
    if password.len() < MIN_PASSWORD_LEN {
        return Err(CoreError::Validation(format!(
            "The master password must be at least {MIN_PASSWORD_LEN} characters."
        )));
    }
    Ok(())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), CoreError> {
    let tmp = path.with_extension("tmp");
    let data = serde_json::to_vec_pretty(value)?;
    fs::write(&tmp, data).map_err(|e| CoreError::io(&tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| CoreError::io(path, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kdf::fast_params;

    const PW: &str = "correct horse battery";

    fn setup() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut v = Vault::new(dir.path().join("data"));
        v.setup_with_params(&PW.into(), fast_params())
            .expect("setup");
        (dir, v)
    }

    fn kinds(v: &Vault) -> Vec<String> {
        let mut k: Vec<String> = v
            .with_conn(|c| audit::recent(c, 100))
            .expect("audit")
            .into_iter()
            .map(|e| e.kind)
            .collect();
        k.reverse();
        k
    }

    #[test]
    fn lifecycle() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut v = Vault::new(dir.path());
        assert_eq!(v.status(), VaultStatus::Uninitialized);
        assert!(matches!(
            v.unlock(&PW.into()),
            Err(CoreError::NotInitialized)
        ));
        v.setup_with_params(&PW.into(), fast_params())
            .expect("setup");
        assert_eq!(v.status(), VaultStatus::Unlocked);
        v.lock(LockReason::Manual).expect("lock");
        assert_eq!(v.status(), VaultStatus::Locked);
        assert!(matches!(v.with_conn(|_| Ok(())), Err(CoreError::Locked)));
        v.unlock(&PW.into()).expect("unlock");
        assert_eq!(
            kinds(&v),
            [
                "vault_created",
                "app_unlocked",
                "app_locked",
                "app_unlocked"
            ]
        );
    }

    #[test]
    fn setup_twice_is_refused() {
        let (_d, mut v) = setup();
        assert!(matches!(
            v.setup_with_params(&PW.into(), fast_params()),
            Err(CoreError::AlreadyInitialized)
        ));
    }

    #[test]
    fn short_passwords_are_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut v = Vault::new(dir.path());
        assert!(matches!(
            v.setup_with_params(&"short".into(), fast_params()),
            Err(CoreError::Validation(_))
        ));
        assert_eq!(v.status(), VaultStatus::Uninitialized);
    }

    #[test]
    fn failed_unlocks_are_audited_after_success() {
        let (_d, mut v) = setup();
        v.lock(LockReason::Idle).expect("lock");
        for _ in 0..2 {
            assert!(matches!(
                v.unlock(&"wrong password!".into()),
                Err(CoreError::WrongPassword)
            ));
        }
        assert_eq!(v.failed_attempts().expect("count"), 2);
        v.unlock(&PW.into()).expect("unlock");
        assert_eq!(v.failed_attempts().expect("count"), 0);
        let k = kinds(&v);
        assert_eq!(
            &k[k.len() - 3..],
            ["unlock_failed", "unlock_failed", "app_unlocked"]
        );
        assert!(v.with_conn(audit::verify).expect("verify").ok);
    }

    #[test]
    fn change_password() {
        let (_d, mut v) = setup();
        let new = "an even better passphrase";
        assert!(matches!(
            v.change_password_with_params(&"not the password".into(), &new.into(), fast_params()),
            Err(CoreError::WrongPassword)
        ));
        v.change_password_with_params(&PW.into(), &new.into(), fast_params())
            .expect("change");
        v.lock(LockReason::Manual).expect("lock");
        assert!(matches!(
            v.unlock(&PW.into()),
            Err(CoreError::WrongPassword)
        ));
        v.unlock(&new.into()).expect("unlock with new");
        assert!(kinds(&v).contains(&"master_password_changed".to_owned()));
        assert!(!v.dir().join(PENDING_VAULT_FILE).exists());
    }

    #[test]
    fn recovers_from_interrupted_password_change() {
        let (_d, mut v) = setup();
        let new = "an even better passphrase";
        // Simulate a crash after re-keying but before the pending file was renamed.
        let params = fast_params();
        let new_key = kdf::derive_key(&new.into(), &params).expect("derive");
        let created_at = v.read_vault_file(VAULT_FILE).expect("read").created_at;
        write_json_atomic(
            &v.dir().join(PENDING_VAULT_FILE),
            &VaultFile {
                version: FORMAT_VERSION,
                created_at,
                kdf: params,
            },
        )
        .expect("write pending");
        v.with_conn(|c| db::rekey(c, &new_key)).expect("rekey");
        v.lock(LockReason::Manual).expect("lock");

        v.unlock(&new.into()).expect("unlock via pending params");
        assert!(!v.dir().join(PENDING_VAULT_FILE).exists());
        v.lock(LockReason::Manual).expect("lock");
        v.unlock(&new.into()).expect("unlock via promoted params");
    }

    #[test]
    fn refuses_to_overwrite_an_orphan_database() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join(DB_FILE), b"data").expect("write");
        let mut v = Vault::new(dir.path());
        assert!(matches!(
            v.setup_with_params(&PW.into(), fast_params()),
            Err(CoreError::CorruptVaultFile(_))
        ));
    }

    #[test]
    fn vault_file_contains_no_secret_material() {
        let (_d, v) = setup();
        let raw = fs::read_to_string(v.dir().join(VAULT_FILE)).expect("read");
        assert!(!raw.contains(PW));
        assert!(raw.contains("m_cost_kib"));
    }
}
