//! RDP errors, each with a message that says what to do next.

use ironrdp::connector::{ConnectorError, ConnectorErrorKind};
use ironrdp::pdu::nego::FailureCode;
use ironrdp::session::SessionError;

#[derive(Debug, thiserror::Error)]
pub enum RdpError {
    #[error("Could not reach {target}: {source}. Check the address, the port (usually 3389) and any firewall in between.")]
    Connect {
        target: String,
        #[source]
        source: std::io::Error,
    },
    #[error("Could not open the SSH tunnel: {0}")]
    Tunnel(String),
    #[error("Timed out connecting to {0}. The host may be down or RDP blocked by a firewall.")]
    Timeout(String),
    #[error("The TLS handshake with the server failed: {0}")]
    Tls(String),
    #[error("The server's certificate was not trusted, so no credentials were sent.")]
    CertificateRejected,
    #[error("The server rejected the username or password{0}.")]
    AuthFailed(String),
    #[error("The server requires Network Level Authentication. Set Security to NLA in the RDP settings.")]
    NlaRequired,
    #[error(
        "The server does not allow TLS-only connections. Set Security to NLA in the RDP settings."
    )]
    TlsNotAllowed,
    #[error("The server only offers legacy RDP security, which Cairn does not support. Enable TLS or NLA on the server.")]
    LegacySecurityOnly,
    #[error("RDP protocol error: {0}")]
    Protocol(String),
}

impl From<ConnectorError> for RdpError {
    fn from(e: ConnectorError) -> Self {
        match e.kind() {
            ConnectorErrorKind::AccessDenied => RdpError::AuthFailed(String::new()),
            ConnectorErrorKind::Credssp(err) => RdpError::AuthFailed(detail(&err.description)),
            ConnectorErrorKind::Negotiation(failure) => match failure.code() {
                FailureCode::HYBRID_REQUIRED_BY_SERVER
                | FailureCode::SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER => RdpError::NlaRequired,
                FailureCode::SSL_NOT_ALLOWED_BY_SERVER => RdpError::LegacySecurityOnly,
                FailureCode::SSL_REQUIRED_BY_SERVER => RdpError::TlsNotAllowed,
                _ => RdpError::Protocol(failure.to_string()),
            },
            _ => RdpError::Protocol(e.report().to_string()),
        }
    }
}

impl From<SessionError> for RdpError {
    fn from(e: SessionError) -> Self {
        RdpError::Protocol(e.report().to_string())
    }
}

/// `" (reason)"` for a non-empty server explanation.
fn detail(s: &str) -> String {
    let s = s.trim();
    if s.is_empty() {
        String::new()
    } else {
        format!(" ({s})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_say_what_to_do() {
        assert!(RdpError::NlaRequired
            .to_string()
            .contains("Set Security to NLA"));
        assert_eq!(
            RdpError::AuthFailed(detail("  logon denied ")).to_string(),
            "The server rejected the username or password (logon denied)."
        );
        assert_eq!(
            RdpError::AuthFailed(detail("")).to_string(),
            "The server rejected the username or password."
        );
    }
}
