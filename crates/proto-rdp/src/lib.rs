//! RDP session support for Cairn, built on IronRDP.
//!
//! [`RdpSession`] connects over any byte stream (TCP or an SSH tunnel), pins the
//! server's TLS certificate through [`RdpInteract::certificate`] before credentials are
//! sent, then streams dirty rectangles and cursor bitmaps as binary messages
//! ([`frame`]) while taking input, resizes and clipboard text from the view.

pub mod cert;
mod clipboard;
pub mod error;
pub mod frame;
pub mod input;
pub mod keymap;
pub mod profile;
pub mod session;

pub use cert::CertInfo;
pub use error::RdpError;
pub use input::RdpInput;
pub use profile::{ColorDepth, DisplayProfile, ProfileError, Resolution, Security};
pub use session::{
    tcp_dialer, Dialer, Phase, RdpConfig, RdpEvent, RdpInteract, RdpSession, Transport,
};
