//! SSH protocol support for Cairn.
//!
//! The session engine (russh, russh-sftp) lands in M2. This crate currently defines the
//! algorithm policy: which algorithms are offered by default and which legacy algorithms
//! a device may opt into (old Cisco, HP and Aruba gear needs them).

pub mod algorithms;

pub use algorithms::{AlgorithmPolicy, LegacyAlgorithm};
