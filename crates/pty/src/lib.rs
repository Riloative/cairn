//! Local shell sessions for Cairn over a pseudo-terminal (`portable-pty`), plus
//! discovery of Podman / Toolbox / Distrobox containers for quick-launch on Linux.

pub mod containers;
pub mod shell;

pub use containers::{Container, ContainerKind};
pub use shell::{default_shell, LocalPty, PtyError, ShellSpec};
