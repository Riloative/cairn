//! Pending questions to the user (host keys, passwords, OTPs), answered over IPC.

use cairn_core::SecretString;
use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::oneshot;

/// The user's answer to a prompt.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PromptAnswer {
    HostKey { accept: bool },
    Secrets { values: Vec<SecretString> },
    Cancel,
}

/// Keeps a prompt registered; dropping it (answered, or the asking session went away)
/// removes the pending entry.
#[derive(Debug)]
pub struct PromptGuard<'a> {
    pub id: u64,
    broker: &'a PromptBroker,
}

impl Drop for PromptGuard<'_> {
    fn drop(&mut self) {
        self.broker.forget(self.id);
    }
}

#[derive(Debug, Default)]
pub struct PromptBroker {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<PromptAnswer>>>,
}

impl PromptBroker {
    /// Register a prompt; returns a guard (with the id) and a receiver for the answer.
    pub fn register(&self) -> (PromptGuard<'_>, oneshot::Receiver<PromptAnswer>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        (PromptGuard { id, broker: self }, rx)
    }

    /// Deliver an answer. Returns false for unknown (already answered) prompts.
    pub fn answer(&self, id: u64, answer: PromptAnswer) -> bool {
        match self.pending.lock().remove(&id) {
            Some(tx) => tx.send(answer).is_ok(),
            None => false,
        }
    }

    fn forget(&self, id: u64) {
        self.pending.lock().remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn answers_reach_the_waiting_prompt() {
        let b = PromptBroker::default();
        let (guard, rx) = b.register();
        let id = guard.id;
        assert!(b.answer(id, PromptAnswer::HostKey { accept: true }));
        assert!(matches!(
            rx.await,
            Ok(PromptAnswer::HostKey { accept: true })
        ));
        assert!(!b.answer(id, PromptAnswer::Cancel), "answered twice");
    }

    #[test]
    fn ids_are_unique_and_dropped_guards_forget() {
        let b = PromptBroker::default();
        let (a, _ra) = b.register();
        let (c, _rc) = b.register();
        assert_ne!(a.id, c.id);
        let id = a.id;
        drop(a);
        assert!(!b.answer(id, PromptAnswer::Cancel));
        assert_eq!(b.pending.lock().len(), 1);
    }

    #[test]
    fn secrets_deserialize_without_leaking_in_debug() {
        let a: PromptAnswer =
            serde_json::from_str(r#"{"kind":"secrets","values":["hunter2"]}"#).expect("json");
        assert!(!format!("{a:?}").contains("hunter2"));
    }
}
