//! Built-in TFTP server for Cairn (RFC 1350, with the blksize, timeout and tsize
//! options of RFC 2347–2349): a root folder jail, separate read/write permissions,
//! a configurable address and port, and a live transfer log via [`ServerEvent`]s.

pub mod error;
pub mod jail;
pub mod netascii;
pub mod packet;
pub mod server;

pub use error::TftpError;
pub use packet::{ErrorCode, Mode, Packet, PacketError};
pub use server::{Direction, ServerConfig, ServerEvent, TftpServer};
