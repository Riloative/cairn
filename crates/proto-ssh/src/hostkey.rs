//! Host key identity and lookup in OpenSSH `known_hosts` files.

use russh::keys::{HashAlg, PublicKey};
use serde::Serialize;
use std::path::Path;

/// A server's host key as shown to the user and stored in Cairn's known-hosts table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    /// e.g. `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`.
    pub key_type: String,
    /// `SHA256:…` fingerprint, as printed by `ssh-keygen -lf`.
    pub fingerprint: String,
    /// OpenSSH public key line (`type base64`), without comment.
    pub public_key: String,
}

impl HostKeyInfo {
    pub fn from_key(host: &str, port: u16, key: &PublicKey) -> Self {
        let mut key = key.clone();
        key.set_comment("");
        let public_key = key
            .to_openssh()
            .map(|s| s.trim().to_owned())
            .unwrap_or_default();
        Self {
            host: host.to_owned(),
            port,
            key_type: key.algorithm().as_str().to_owned(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            public_key,
        }
    }
}

/// Result of looking a host key up in an OpenSSH `known_hosts` file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenSshLookup {
    Match,
    /// The file has a different key for this host (possible MITM or re-keyed device).
    Mismatch,
    /// Host not in the file, or the file does not exist.
    Unknown,
}

/// Look `key` up in an OpenSSH known_hosts file (hashed entries supported). Read-only:
/// Cairn never writes to the user's `~/.ssh/known_hosts`.
pub fn lookup_openssh_known_hosts(
    path: &Path,
    host: &str,
    port: u16,
    key: &PublicKey,
) -> OpenSshLookup {
    if !path.exists() {
        return OpenSshLookup::Unknown;
    }
    match russh::keys::check_known_hosts_path(host, port, key, path) {
        Ok(true) => OpenSshLookup::Match,
        Ok(false) => OpenSshLookup::Unknown,
        Err(russh::keys::Error::KeyChanged { .. }) => OpenSshLookup::Mismatch,
        // An unreadable or malformed file is treated as "no information".
        Err(_) => OpenSshLookup::Unknown,
    }
}

/// `~/.ssh/known_hosts`, if a home directory is known.
pub fn default_openssh_known_hosts() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(|h| Path::new(&h).join(".ssh").join("known_hosts"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED25519: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const OTHER: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X";

    fn key(s: &str) -> PublicKey {
        PublicKey::from_openssh(s).expect("valid key")
    }

    #[test]
    fn describes_a_key() {
        let info = HostKeyInfo::from_key("sw1", 22, &key(ED25519));
        assert_eq!(info.key_type, "ssh-ed25519");
        assert!(info.fingerprint.starts_with("SHA256:"));
        assert_eq!(info.public_key, ED25519);
    }

    #[test]
    fn looks_up_openssh_known_hosts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("known_hosts");
        std::fs::write(&path, format!("sw1 {ED25519}\n[sw2]:2222 {ED25519}\n")).expect("write");
        assert_eq!(
            lookup_openssh_known_hosts(&path, "sw1", 22, &key(ED25519)),
            OpenSshLookup::Match
        );
        assert_eq!(
            lookup_openssh_known_hosts(&path, "sw2", 2222, &key(ED25519)),
            OpenSshLookup::Match
        );
        assert_eq!(
            lookup_openssh_known_hosts(&path, "sw1", 22, &key(OTHER)),
            OpenSshLookup::Mismatch
        );
        assert_eq!(
            lookup_openssh_known_hosts(&path, "sw3", 22, &key(ED25519)),
            OpenSshLookup::Unknown
        );
        assert_eq!(
            lookup_openssh_known_hosts(&dir.path().join("missing"), "sw1", 22, &key(ED25519)),
            OpenSshLookup::Unknown
        );
    }
}
