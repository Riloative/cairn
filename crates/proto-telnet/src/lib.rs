//! Telnet protocol implementation for Cairn (RFC 854 and option RFCs).
//!
//! The negotiation state machine, NAWS and reverse-Telnet console server support land in
//! M3. This crate currently defines the IAC command and option codes.

pub mod codes;

pub use codes::{Command, TelnetOption};
