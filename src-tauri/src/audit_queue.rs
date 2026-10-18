//! Audit events raised while the vault is locked (e.g. a session ending during auto-lock)
//! are queued in memory and written on the next unlock. Events never contain secrets.

use cairn_core::audit::{self, AuditEvent};
use cairn_core::{Vault, VaultStatus};
use parking_lot::Mutex;

#[derive(Debug, Default)]
pub struct AuditQueue {
    pending: Mutex<Vec<(String, AuditEvent)>>,
}

impl AuditQueue {
    /// Write now if unlocked, otherwise queue with the current time.
    pub fn record(&self, vault: &Mutex<Vault>, event: AuditEvent) {
        let ts = audit::now();
        let v = vault.lock();
        if v.status() == VaultStatus::Unlocked
            && v.with_conn(|c| audit::append_at(c, &event, &ts)).is_ok()
        {
            return;
        }
        drop(v);
        self.pending.lock().push((ts, event));
    }

    /// Flush queued events (call right after unlocking).
    pub fn flush(&self, vault: &Vault) {
        let events: Vec<_> = std::mem::take(&mut *self.pending.lock());
        for (ts, event) in events {
            if vault
                .with_conn(|c| audit::append_at(c, &event, &ts))
                .is_err()
            {
                self.pending.lock().push((ts, event));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cairn_core::audit::LockReason;

    #[test]
    fn queues_while_locked_and_flushes_on_unlock() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault = Mutex::new(Vault::new(dir.path()));
        let pw = cairn_core::SecretString::from("correct horse battery");
        vault
            .lock()
            .setup_with_params(
                &pw,
                cairn_core::kdf::KdfParams::new(1024, 1, 1).expect("rng"),
            )
            .expect("setup");
        vault.lock().lock(LockReason::Manual).expect("lock");

        let q = AuditQueue::default();
        q.record(&vault, AuditEvent::MasterPasswordChanged);
        assert_eq!(q.pending.lock().len(), 1);

        vault.lock().unlock(&pw).expect("unlock");
        q.flush(&vault.lock());
        assert!(q.pending.lock().is_empty());
        let kinds: Vec<String> = vault
            .lock()
            .with_conn(|c| audit::recent(c, 2))
            .expect("audit")
            .into_iter()
            .map(|e| e.kind)
            .collect();
        assert!(kinds.contains(&"master_password_changed".to_owned()));
    }
}
