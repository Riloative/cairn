//! SSH protocol support for Cairn, built on `russh`.
//!
//! - [`algorithms`]: modern defaults plus per-device legacy opt-ins.
//! - [`connect`]: TCP / proxy / jump-host chains and authentication.
//! - [`session`]: an interactive shell as a [`cairn_core::terminal::TerminalSession`].
//! - [`interact`]: how the engine asks the UI for host-key decisions and secrets.

pub mod algorithms;
pub mod connect;
pub mod error;
pub mod hostkey;
pub mod interact;
pub mod proxy;
pub mod session;

pub use algorithms::{AlgorithmPolicy, LegacyAlgorithm};
pub use connect::{AuthMethod, ConnectOptions, Hop};
pub use error::SshError;
pub use hostkey::{HostKeyInfo, OpenSshLookup};
pub use interact::{HostKeyVerdict, Interact, Progress, Prompt};
pub use proxy::{ProxyConfig, ProxyKind};
pub use session::SshSession;
