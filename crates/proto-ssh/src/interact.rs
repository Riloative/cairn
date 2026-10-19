//! How the SSH engine asks the user for decisions and secrets.
//!
//! The engine never talks to the UI directly; the Tauri layer implements [`Interact`] and
//! routes requests to dialogs. Answers containing secrets are [`SecretString`]s.

use crate::hostkey::HostKeyInfo;
use cairn_core::SecretString;
use futures::future::BoxFuture;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyVerdict {
    Accept,
    Reject,
}

/// One keyboard-interactive question (e.g. a RADIUS/TACACS+ OTP prompt).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InteractivePrompt {
    pub text: String,
    /// Whether the answer may be shown while typing.
    pub echo: bool,
}

/// A question that needs the user's input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Prompt {
    Password {
        user: String,
        target: String,
    },
    Passphrase {
        key: String,
    },
    KeyboardInteractive {
        user: String,
        target: String,
        name: String,
        instructions: String,
        prompts: Vec<InteractivePrompt>,
    },
}

/// Connection progress, for the tab state indicator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum Progress {
    /// TCP/proxy connect to hop `index` (0-based; the last hop is the target).
    Connecting { index: usize, target: String },
    Authenticating {
        index: usize,
        user: String,
        target: String,
    },
    /// Shell is open.
    Connected { host_key: Option<HostKeyInfo> },
}

pub trait Interact: Send + Sync + 'static {
    /// Decide whether to trust a server key (check stores, ask the user if needed).
    fn host_key(&self, info: HostKeyInfo) -> BoxFuture<'static, HostKeyVerdict>;
    /// Ask the user; `None` means cancelled. One answer per question.
    fn prompt(&self, prompt: Prompt) -> BoxFuture<'static, Option<Vec<SecretString>>>;
    /// Server pre-auth banner (shown in the terminal).
    fn banner(&self, text: String);
    fn progress(&self, progress: Progress);
}
