//! Serial errors with the exact fix for each OS.

use cairn_core::UserFacingError;

#[derive(Debug, thiserror::Error)]
pub enum SerialError {
    #[error("Permission denied on {path}.")]
    PermissionDenied { path: String },
    #[error("{path} is in use by another program.")]
    Busy { path: String },
    #[error("{path} does not exist (unplugged?).")]
    NotFound { path: String },
    #[error("Could not open {path}: {message}")]
    Open { path: String, message: String },
    #[error("{0}")]
    Settings(#[from] crate::settings::SettingsError),
    #[error("Serial I/O failed: {0}")]
    Io(String),
    #[error("File transfer failed: {0}")]
    Transfer(String),
    #[error("The transfer was cancelled.")]
    Cancelled,
}

/// The fix for a permission problem on this OS.
pub fn permission_hint(path: &str) -> String {
    if cfg!(target_os = "macos") {
        format!(
            "Check that no other app (screen, CoolTerm, a vendor tool) has {path} open, and that the USB-serial driver is installed and allowed in System Settings → Privacy & Security."
        )
    } else {
        "Add your user to the dialout group: `sudo usermod -aG dialout $USER`, then log out and back in."
            .to_owned()
    }
}

impl SerialError {
    pub fn from_open(err: serialport::Error, path: &str) -> Self {
        use serialport::ErrorKind;
        let p = path.to_owned();
        let msg = err.description.to_lowercase();
        match err.kind {
            ErrorKind::NoDevice => SerialError::NotFound { path: p },
            ErrorKind::Io(std::io::ErrorKind::PermissionDenied) => {
                SerialError::PermissionDenied { path: p }
            }
            ErrorKind::Io(std::io::ErrorKind::NotFound) => SerialError::NotFound { path: p },
            _ if msg.contains("permission denied") => SerialError::PermissionDenied { path: p },
            _ if msg.contains("busy") || msg.contains("in use") || msg.contains("exclusive") => {
                SerialError::Busy { path: p }
            }
            _ if msg.contains("no such file") => SerialError::NotFound { path: p },
            _ => SerialError::Open {
                path: p,
                message: err.description,
            },
        }
    }
}

impl UserFacingError for SerialError {
    fn code(&self) -> &'static str {
        match self {
            SerialError::PermissionDenied { .. } => "serial.permission_denied",
            SerialError::Busy { .. } => "serial.busy",
            SerialError::NotFound { .. } => "serial.not_found",
            SerialError::Open { .. } => "serial.open",
            SerialError::Settings(_) => "serial.settings",
            SerialError::Io(_) => "serial.io",
            SerialError::Transfer(_) => "serial.transfer",
            SerialError::Cancelled => "serial.cancelled",
        }
    }

    fn hint(&self) -> Option<String> {
        match self {
            SerialError::PermissionDenied { path } => Some(permission_hint(path)),
            SerialError::Busy { path } => Some(format!(
                "Close other terminal programs using {path} (screen, minicom, picocom, another Cairn tab). On Linux, `fuser {path}` shows which process holds it."
            )),
            SerialError::NotFound { .. } => {
                Some("Reconnect the console cable and pick the port again from the list.".into())
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_errors_explain_the_fix() {
        let e = SerialError::from_open(
            serialport::Error::new(
                serialport::ErrorKind::Io(std::io::ErrorKind::PermissionDenied),
                "Permission denied",
            ),
            "/dev/ttyUSB0",
        );
        assert!(matches!(e, SerialError::PermissionDenied { .. }));
        assert_eq!(e.user_message(), "Permission denied on /dev/ttyUSB0.");
        if cfg!(target_os = "linux") {
            assert!(e.hint().unwrap_or_default().contains("usermod -aG dialout"));
        }
    }

    #[test]
    fn busy_and_missing_ports() {
        let busy = SerialError::from_open(
            serialport::Error::new(serialport::ErrorKind::Unknown, "Device or resource busy"),
            "/dev/ttyUSB0",
        );
        assert!(matches!(busy, SerialError::Busy { .. }));
        let gone = SerialError::from_open(
            serialport::Error::new(serialport::ErrorKind::NoDevice, "gone"),
            "/dev/ttyUSB9",
        );
        assert!(matches!(gone, SerialError::NotFound { .. }));
    }
}
