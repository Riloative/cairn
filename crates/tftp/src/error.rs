//! Errors of the TFTP server, with user-facing messages and fixes.

use cairn_core::UserFacingError;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum TftpError {
    #[error("Cairn may not listen on {addr}: {source}")]
    BindPermission {
        addr: SocketAddr,
        source: std::io::Error,
    },
    #[error("Another program already uses {addr} (another TFTP server?)")]
    BindInUse { addr: SocketAddr },
    #[error("Could not listen on {addr}: {source}")]
    Bind {
        addr: SocketAddr,
        source: std::io::Error,
    },
    #[error("The folder {} does not exist or is not readable", path.display())]
    Root { path: PathBuf },
    #[error("Choose what clients may do: read, write or both")]
    NothingAllowed,
}

impl UserFacingError for TftpError {
    fn code(&self) -> &'static str {
        match self {
            Self::BindPermission { .. } => "tftp.permission",
            Self::BindInUse { .. } => "tftp.in_use",
            Self::Bind { .. } => "tftp.bind",
            Self::Root { .. } => "tftp.root",
            Self::NothingAllowed => "tftp.config",
        }
    }

    fn hint(&self) -> Option<String> {
        match self {
            Self::BindPermission { addr, .. } if addr.port() < 1024 => Some(format!(
                "Port {} is privileged. Use a port above 1023 (for example 6969) and point the device at it (`copy tftp://<this-ip>:6969/file …`), or allow Cairn to bind low ports on Linux: `sudo setcap 'cap_net_bind_service=+ep' \"$(command -v cairn)\"` (or run it through authbind). macOS allows port 69 for normal users since 10.14.",
                addr.port()
            )),
            Self::BindPermission { .. } => {
                Some("Check that the address belongs to this computer.".into())
            }
            Self::BindInUse { addr } => Some(format!(
                "Stop the other server (on Linux: `sudo ss -ulpn 'sport = :{}'` shows it) or choose another port.",
                addr.port()
            )),
            Self::Root { .. } => Some("Choose an existing folder.".into()),
            _ => None,
        }
    }
}

pub(crate) fn bind_error(addr: SocketAddr, e: std::io::Error) -> TftpError {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => TftpError::BindPermission { addr, source: e },
        std::io::ErrorKind::AddrInUse => TftpError::BindInUse { addr },
        _ => TftpError::Bind { addr, source: e },
    }
}
