//! Serial console support for Cairn: port discovery (USB friendly names, hotplug),
//! sessions with full line settings, DTR/RTS, BREAK and newline mapping, and
//! Xmodem / Xmodem-1K / Ymodem transfers for firmware recovery.

pub mod error;
pub mod ports;
pub mod session;
pub mod settings;
pub mod xmodem;

pub use error::SerialError;
pub use ports::PortInfo;
pub use session::{SerialOptions, SerialSession};
pub use settings::{
    DataBits, FlowControl, LineSettings, Newline, NewlineMapping, Parity, SettingsError, StopBits,
};
