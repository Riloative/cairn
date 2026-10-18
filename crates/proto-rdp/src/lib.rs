//! RDP session support for Cairn.
//!
//! The IronRDP session, frame streaming and input mapping land in M7. This crate
//! currently defines the per-device display profile.

pub mod profile;

pub use profile::{ColorDepth, DisplayProfile, ProfileError, Resolution};
