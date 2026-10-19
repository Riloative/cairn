//! The server's TLS certificate, summarized for the trust decision.
//!
//! RDP servers almost always present self-signed certificates, so CA validation would
//! fail for nearly every host. Cairn pins the certificate instead (trust on first use,
//! like SSH host keys): the SHA-256 fingerprint of its DER encoding is stored per host
//! and port, and a different certificate later is flagged as changed.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use x509_cert::der::Encode;
use x509_cert::Certificate;

/// Key type under which certificates are stored in the known-hosts table.
pub const KEY_TYPE: &str = "x509";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    pub host: String,
    pub port: u16,
    /// `AB:CD:…`, SHA-256 of the DER certificate.
    pub fingerprint: String,
    /// Lowercase hex of the same digest, used as the stored key.
    pub digest: String,
    pub subject: String,
    pub issuer: String,
    /// Validity in Unix seconds.
    pub not_before: u64,
    pub not_after: u64,
    pub self_signed: bool,
    pub expired: bool,
}

impl CertInfo {
    pub fn from_certificate(host: &str, port: u16, cert: &Certificate) -> Option<Self> {
        let der = cert.to_der().ok()?;
        let digest = Sha256::digest(&der);
        let fingerprint = digest
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":");
        let hex = digest.iter().map(|b| format!("{b:02x}")).collect();
        let tbs = &cert.tbs_certificate;
        let not_before = tbs.validity.not_before.to_unix_duration().as_secs();
        let not_after = tbs.validity.not_after.to_unix_duration().as_secs();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Some(CertInfo {
            host: host.to_owned(),
            port,
            fingerprint,
            digest: hex,
            subject: tbs.subject.to_string(),
            issuer: tbs.issuer.to_string(),
            not_before,
            not_after,
            self_signed: tbs.subject == tbs.issuer,
            expired: now < not_before || now > not_after,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use x509_cert::der::Decode;

    // A self-signed test certificate (CN=cairn-test, P-256), valid 2026-10-19 to 2036-10-16.
    const TEST_CERT: &str = "MIIBgDCCASWgAwIBAgIUR4TjYU6ql270iajNEsqS9nTae+AwCgYIKoZIzj0EAwIwFTETMBEGA1UEAwwKY2Fpcm4tdGVzdDAeFw0yNjEwMTkwNjM0MDZaFw0zNjEwMTYwNjM0MDZaMBUxEzARBgNVBAMMCmNhaXJuLXRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAR9Ols8rDQpl/7JF1gdsuJByDTbzBfxk2dFAlUwr3tTg0CmupYuXWStJelhn+AJnBtjBd7WXGpPC4oYy6mGr0tqo1MwUTAdBgNVHQ4EFgQUjUEOzJkdXHayJnFLhvRcLqkTdlkwHwYDVR0jBBgwFoAUjUEOzJkdXHayJnFLhvRcLqkTdlkwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEAnyVOqH2fbhoc7dX8J78j2J94PbbK4ZM45lcEaR5GwVcCIQCP0zkWLJy3NI0L/JkVGUzcRZOjd6/y116TrrcLRih7Qg==";

    fn der(b64: &str) -> Vec<u8> {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let (mut acc, mut bits) = (0u32, 0);
        for c in b64.bytes().filter(|&c| c != b'=') {
            let v = ALPHABET.iter().position(|&a| a == c).expect("base64") as u32;
            acc = (acc << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
            }
        }
        out
    }

    #[test]
    fn summarizes_a_self_signed_certificate() {
        let bytes = der(TEST_CERT);
        let cert = Certificate::from_der(&bytes).expect("valid cert");
        let info = CertInfo::from_certificate("srv", 3389, &cert).expect("info");
        assert_eq!(info.subject, "CN=cairn-test");
        assert!(info.self_signed);
        assert_eq!(info.not_before, 1_792_391_646);
        assert_eq!(info.fingerprint.len(), 32 * 3 - 1);
        let expected: String = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(info.digest, expected);
        assert_eq!(info.fingerprint.replace(':', "").to_lowercase(), expected);
    }
}
