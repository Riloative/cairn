//! SSH errors mapped to messages a network engineer can act on.

use cairn_core::UserFacingError;

#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("Could not resolve {host}.")]
    Resolve { host: String },
    #[error("Connection to {target} was refused.")]
    Refused { target: String },
    #[error("Timed out connecting to {target}.")]
    Timeout { target: String },
    #[error("Could not connect to {target}: {message}")]
    Connect { target: String, message: String },
    #[error("Proxy error: {0}")]
    Proxy(String),
    #[error("No common {kind} with {target}. The server offers: {theirs}.")]
    NoCommonAlgorithm {
        target: String,
        kind: String,
        theirs: String,
    },
    #[error("The host key for {target} was not accepted.")]
    HostKeyRejected { target: String },
    #[error("Authentication failed for {user}@{target}.")]
    AuthFailed {
        user: String,
        target: String,
        /// Methods the server would still accept.
        remaining: Vec<String>,
        /// Methods that could not even be attempted (agent missing, key file
        /// unreadable), with the reason each was skipped.
        skipped: Vec<String>,
    },
    #[error("Authentication was cancelled.")]
    AuthCancelled,
    #[error("Could not load the private key {path}: {message}")]
    Key { path: String, message: String },
    #[error("The SSH agent is not available: {0}")]
    Agent(String),
    #[error("The server refused to open a terminal: {0}")]
    Channel(String),
    #[error("The connection was lost: {0}")]
    Disconnected(String),
    #[error("SSH protocol error: {0}")]
    Protocol(String),
    #[error("The session is not connected.")]
    NotConnected,
    #[error("Could not listen on {addr}: {message}")]
    ForwardBind { addr: String, message: String },
    #[error("The server refused the port forward: {0}")]
    ForwardRefused(String),
    #[error("SFTP is not available on this device: {0}")]
    SftpUnavailable(String),
    #[error("{0}")]
    Sftp(String),
    #[error("SCP failed: {0}")]
    Scp(String),
    #[error("Could not grab the configuration: {0}")]
    Grab(String),
    #[error("The transfer was cancelled.")]
    Cancelled,
}

impl SshError {
    /// Map a russh error that happened while talking to `target`.
    pub fn from_russh(err: russh::Error, target: &str) -> Self {
        match err {
            russh::Error::NoCommonAlgo { kind, theirs, .. } => SshError::NoCommonAlgorithm {
                target: target.to_owned(),
                kind: format!("{kind:?}").to_lowercase(),
                theirs: theirs.join(", "),
            },
            russh::Error::UnknownKey | russh::Error::KeyChanged { .. } => {
                SshError::HostKeyRejected {
                    target: target.to_owned(),
                }
            }
            russh::Error::ConnectionTimeout | russh::Error::Elapsed(_) => SshError::Timeout {
                target: target.to_owned(),
            },
            russh::Error::KeepaliveTimeout => {
                SshError::Disconnected("the server stopped answering keepalives".into())
            }
            russh::Error::HUP | russh::Error::Disconnect => {
                SshError::Disconnected("closed by the remote side".into())
            }
            russh::Error::IO(e) => SshError::Disconnected(e.to_string()),
            other => SshError::Protocol(other.to_string()),
        }
    }
}

impl UserFacingError for SshError {
    fn code(&self) -> &'static str {
        match self {
            SshError::Resolve { .. } => "ssh.resolve",
            SshError::Refused { .. } => "ssh.refused",
            SshError::Timeout { .. } => "ssh.timeout",
            SshError::Connect { .. } => "ssh.connect",
            SshError::Proxy(_) => "ssh.proxy",
            SshError::NoCommonAlgorithm { .. } => "ssh.no_common_algorithm",
            SshError::HostKeyRejected { .. } => "ssh.host_key_rejected",
            SshError::AuthFailed { .. } => "ssh.auth_failed",
            SshError::AuthCancelled => "ssh.auth_cancelled",
            SshError::Key { .. } => "ssh.key",
            SshError::Agent(_) => "ssh.agent",
            SshError::Channel(_) => "ssh.channel",
            SshError::Disconnected(_) => "ssh.disconnected",
            SshError::Protocol(_) => "ssh.protocol",
            SshError::NotConnected => "ssh.not_connected",
            SshError::ForwardBind { .. } => "ssh.forward_bind",
            SshError::ForwardRefused(_) => "ssh.forward_refused",
            SshError::SftpUnavailable(_) => "ssh.sftp_unavailable",
            SshError::Sftp(_) => "ssh.sftp",
            SshError::Scp(_) => "ssh.scp",
            SshError::Grab(_) => "ssh.grab",
            SshError::Cancelled => "ssh.cancelled",
        }
    }

    fn hint(&self) -> Option<String> {
        Some(match self {
            SshError::Resolve { .. } => "Check the hostname or use the management IP address.".into(),
            SshError::Refused { .. } => {
                "Check that SSH is enabled on the device and that the port is right (`ip ssh version 2`, `crypto key generate rsa` on Cisco).".into()
            }
            SshError::Timeout { .. } => {
                "Check the IP address, routing and any firewall or ACL between you and the device; a jump host may be required.".into()
            }
            SshError::NoCommonAlgorithm { .. } => {
                "This is common with older Cisco, HP and Aruba gear. Enable legacy algorithms for this device (Connection → Legacy algorithms).".into()
            }
            SshError::HostKeyRejected { .. } => {
                "Verify the device's host key fingerprint out of band before trusting it.".into()
            }
            SshError::AuthFailed {
                remaining, skipped, ..
            } => {
                let mut parts = Vec::new();
                if !skipped.is_empty() {
                    parts.push(format!(
                        "Some methods could not be tried: {}.",
                        skipped.join("; ")
                    ));
                }
                if remaining.is_empty() {
                    parts.push("Check the username and credentials.".into());
                } else {
                    parts.push(format!(
                        "Check the username and credentials. The server accepts: {}.",
                        remaining.join(", ")
                    ));
                }
                parts.join(" ")
            }
            SshError::Key { .. } => {
                "Check the key path and passphrase. Supported: OpenSSH and PEM keys (ed25519, ECDSA, RSA).".into()
            }
            SshError::Agent(_) => {
                "Start an SSH agent and add your key (`ssh-add`), then make sure SSH_AUTH_SOCK is set for Cairn.".into()
            }
            SshError::Disconnected(_) => "Use Reconnect to open the session again.".into(),
            SshError::NotConnected => "Wait until the session is connected, or reconnect it.".into(),
            SshError::ForwardBind { .. } => {
                "Choose another local port; ports below 1024 need administrator rights.".into()
            }
            SshError::ForwardRefused(_) => {
                "The server may forbid forwarding (`AllowTcpForwarding`, `GatewayPorts` in sshd_config).".into()
            }
            SshError::SftpUnavailable(_) => {
                "Many network devices have no SFTP server; use SCP instead (enable `ip scp server enable` on Cisco).".into()
            }
            SshError::Scp(_) => {
                "Check the path and that SCP is enabled on the device (`ip scp server enable` on Cisco IOS).".into()
            }
            _ => return None,
        })
    }
}

/// Map a TCP connect error to a user-facing error.
pub fn connect_error(err: std::io::Error, target: &str) -> SshError {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::ConnectionRefused => SshError::Refused {
            target: target.to_owned(),
        },
        ErrorKind::TimedOut => SshError::Timeout {
            target: target.to_owned(),
        },
        _ => SshError::Connect {
            target: target.to_owned(),
            message: err.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_common_algorithm_suggests_legacy() {
        let e = SshError::NoCommonAlgorithm {
            target: "10.0.0.1:22".into(),
            kind: "kex".into(),
            theirs: "diffie-hellman-group1-sha1".into(),
        };
        assert!(e.hint().unwrap_or_default().contains("legacy algorithms"));
        assert_eq!(e.code(), "ssh.no_common_algorithm");
    }

    #[test]
    fn maps_io_errors() {
        let e = connect_error(
            std::io::Error::from(std::io::ErrorKind::ConnectionRefused),
            "h:22",
        );
        assert!(matches!(e, SshError::Refused { .. }));
    }

    #[test]
    fn auth_failure_lists_remaining_methods() {
        let e = SshError::AuthFailed {
            user: "admin".into(),
            target: "sw1:22".into(),
            remaining: vec!["publickey".into(), "keyboard-interactive".into()],
            skipped: Vec::new(),
        };
        assert!(e.hint().unwrap_or_default().contains("publickey"));
    }

    #[test]
    fn auth_failure_reports_skipped_methods() {
        let e = SshError::AuthFailed {
            user: "admin".into(),
            target: "sw1:22".into(),
            remaining: vec!["password".into()],
            skipped: vec!["SSH agent not available (SSH_AUTH_SOCK is not set)".into()],
        };
        let hint = e.hint().unwrap_or_default();
        assert!(hint.contains("SSH_AUTH_SOCK is not set"), "{hint}");
        assert!(hint.contains("password"), "{hint}");
    }
}
