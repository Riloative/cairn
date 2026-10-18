//! Serial console support for Cairn.
//!
//! Port I/O (serialport / tokio-serial), hotplug and X/Ymodem land in M3. This crate
//! currently defines validated line settings.

pub mod settings;

pub use settings::{DataBits, FlowControl, LineSettings, Parity, SettingsError, StopBits};
