//! Built-in TFTP server for Cairn (RFC 1350, with RFC 2347/2348 options later).
//!
//! The server loop, root jail, bind address and transfer log land in M6. This crate
//! currently implements packet encoding and decoding.

pub mod packet;

pub use packet::{ErrorCode, Mode, Packet, PacketError};
