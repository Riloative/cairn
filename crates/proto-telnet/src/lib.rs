//! Telnet client for Cairn: option negotiation (RFC 854/855/1143), NAWS (RFC 1073),
//! terminal type (RFC 1091), BREAK, and reverse Telnet to console-server ports.

pub mod codes;
pub mod console;
pub mod negotiation;
pub mod session;

pub use codes::{Command, TelnetOption};
pub use negotiation::Negotiator;
pub use session::{TelnetError, TelnetOptions, TelnetSession};
