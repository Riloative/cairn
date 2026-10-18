//! Algorithm policy: modern defaults plus per-device legacy opt-ins.
//!
//! Defaults are stricter than russh's: the SHA-1 `ssh-rsa` host key signature is removed
//! unless the device opts in. Legacy algorithms are appended after the modern ones, so
//! they are only negotiated when the server offers nothing better.

use russh::keys::Algorithm;
use russh::{cipher, kex, mac, Preferred};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

/// A legacy (weak) algorithm a device can opt into. Enabling any of them shows a warning
/// badge on the device. Old Cisco, HP and Aruba gear needs these.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LegacyAlgorithm {
    /// `diffie-hellman-group1-sha1` key exchange (1024-bit Oakley group 2).
    DhGroup1Sha1,
    /// `diffie-hellman-group14-sha1` key exchange.
    DhGroup14Sha1,
    /// `diffie-hellman-group-exchange-sha1` key exchange.
    DhGexSha1,
    /// `ssh-rsa` host keys and user-key signatures using SHA-1.
    SshRsaSha1,
    /// AES in CBC mode (`aes128-cbc`, `aes192-cbc`, `aes256-cbc`).
    AesCbc,
    /// `3des-cbc` (very old IOS images).
    TripleDesCbc,
    /// `hmac-sha1` and `hmac-sha1-etm@openssh.com` MACs.
    HmacSha1,
}

impl LegacyAlgorithm {
    pub const ALL: [LegacyAlgorithm; 7] = [
        LegacyAlgorithm::DhGroup1Sha1,
        LegacyAlgorithm::DhGroup14Sha1,
        LegacyAlgorithm::DhGexSha1,
        LegacyAlgorithm::SshRsaSha1,
        LegacyAlgorithm::AesCbc,
        LegacyAlgorithm::TripleDesCbc,
        LegacyAlgorithm::HmacSha1,
    ];

    /// The SSH wire names this opt-in enables.
    pub fn wire_names(self) -> &'static [&'static str] {
        match self {
            LegacyAlgorithm::DhGroup1Sha1 => &["diffie-hellman-group1-sha1"],
            LegacyAlgorithm::DhGroup14Sha1 => &["diffie-hellman-group14-sha1"],
            LegacyAlgorithm::DhGexSha1 => &["diffie-hellman-group-exchange-sha1"],
            LegacyAlgorithm::SshRsaSha1 => &["ssh-rsa"],
            LegacyAlgorithm::AesCbc => &["aes128-cbc", "aes192-cbc", "aes256-cbc"],
            LegacyAlgorithm::TripleDesCbc => &["3des-cbc"],
            LegacyAlgorithm::HmacSha1 => &["hmac-sha1", "hmac-sha1-etm@openssh.com"],
        }
    }
}

/// Which algorithms a connection may negotiate.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlgorithmPolicy {
    /// Legacy algorithms enabled for this device.
    #[serde(default)]
    pub legacy: Vec<LegacyAlgorithm>,
}

impl AlgorithmPolicy {
    /// Every legacy algorithm enabled (used by "Enable legacy algorithms" quick toggle).
    pub fn all_legacy() -> Self {
        Self {
            legacy: LegacyAlgorithm::ALL.to_vec(),
        }
    }

    /// True when any legacy algorithm is enabled (the UI shows a warning badge).
    pub fn has_legacy(&self) -> bool {
        !self.legacy.is_empty()
    }

    /// Whether a given legacy algorithm is enabled.
    pub fn allows(&self, alg: LegacyAlgorithm) -> bool {
        self.legacy.contains(&alg)
    }

    /// The russh negotiation preferences for this policy.
    pub fn preferred(&self) -> Preferred {
        let base = Preferred::DEFAULT;

        let mut kex: Vec<kex::Name> = base.kex.to_vec();
        // Extension pseudo-algorithms must stay last in the list.
        let ext_at = kex
            .iter()
            .position(|k| *k == kex::EXTENSION_SUPPORT_AS_CLIENT)
            .unwrap_or(kex.len());
        let mut legacy_kex = Vec::new();
        if self.allows(LegacyAlgorithm::DhGexSha1) {
            legacy_kex.push(kex::DH_GEX_SHA1);
        }
        if self.allows(LegacyAlgorithm::DhGroup14Sha1) {
            legacy_kex.push(kex::DH_G14_SHA1);
        }
        if self.allows(LegacyAlgorithm::DhGroup1Sha1) {
            legacy_kex.push(kex::DH_G1_SHA1);
        }
        kex.splice(ext_at..ext_at, legacy_kex);

        let mut key: Vec<Algorithm> = base
            .key
            .iter()
            .filter(|a| !matches!(a, Algorithm::Rsa { hash: None }))
            .cloned()
            .collect();
        if self.allows(LegacyAlgorithm::SshRsaSha1) {
            key.push(Algorithm::Rsa { hash: None });
        }

        let mut ciphers: Vec<cipher::Name> = base.cipher.to_vec();
        if self.allows(LegacyAlgorithm::AesCbc) {
            ciphers.extend([
                cipher::AES_256_CBC,
                cipher::AES_192_CBC,
                cipher::AES_128_CBC,
            ]);
        }
        if self.allows(LegacyAlgorithm::TripleDesCbc) {
            ciphers.push(cipher::TRIPLE_DES_CBC);
        }

        let mut macs: Vec<mac::Name> = base.mac.to_vec();
        if self.allows(LegacyAlgorithm::HmacSha1) {
            macs.extend([mac::HMAC_SHA1_ETM, mac::HMAC_SHA1]);
        }

        Preferred {
            kex: Cow::Owned(kex),
            key: Cow::Owned(key),
            cipher: Cow::Owned(ciphers),
            mac: Cow::Owned(macs),
            ..base
        }
    }
}

/// Host key algorithms Cairn accepts by default (for display in settings).
pub fn modern_host_key_algorithms() -> Vec<String> {
    AlgorithmPolicy::default()
        .preferred()
        .key
        .iter()
        .map(|a| a.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names<T: AsRef<str>>(v: &[T]) -> Vec<String> {
        v.iter().map(|x| x.as_ref().to_owned()).collect()
    }

    #[test]
    fn default_policy_is_modern_only() {
        let p = AlgorithmPolicy::default();
        assert!(!p.has_legacy());
        let pref = p.preferred();
        let all: Vec<String> = names(&pref.kex)
            .into_iter()
            .chain(names(&pref.cipher))
            .chain(names(&pref.mac))
            .chain(pref.key.iter().map(|a| a.to_string()))
            .collect();
        for legacy in LegacyAlgorithm::ALL {
            for wire in legacy.wire_names() {
                assert!(
                    !all.contains(&(*wire).to_owned()),
                    "{wire} enabled by default"
                );
            }
        }
        assert!(all.contains(&"curve25519-sha256".to_owned()));
        assert!(all.contains(&"rsa-sha2-512".to_owned()));
    }

    #[test]
    fn legacy_policy_enables_every_wire_name_after_modern_ones() {
        let pref = AlgorithmPolicy::all_legacy().preferred();
        let kex = names(&pref.kex);
        let ciphers = names(&pref.cipher);
        let macs = names(&pref.mac);
        let keys: Vec<String> = pref.key.iter().map(|a| a.to_string()).collect();
        for legacy in LegacyAlgorithm::ALL {
            for wire in legacy.wire_names() {
                let w = (*wire).to_owned();
                assert!(
                    kex.contains(&w)
                        || ciphers.contains(&w)
                        || macs.contains(&w)
                        || keys.contains(&w),
                    "{wire} missing"
                );
            }
        }
        // Modern algorithms still come first.
        assert_eq!(kex[0], Preferred::DEFAULT.kex[0].as_ref());
        assert_eq!(ciphers[0], Preferred::DEFAULT.cipher[0].as_ref());
        // Extension markers stay at the end of the kex list.
        let g1 = kex
            .iter()
            .position(|k| k == "diffie-hellman-group1-sha1")
            .expect("g1");
        let ext = kex.iter().position(|k| k == "ext-info-c").expect("ext");
        assert!(g1 < ext);
    }

    #[test]
    fn serializes_kebab_case() {
        let p = AlgorithmPolicy {
            legacy: vec![LegacyAlgorithm::DhGroup1Sha1, LegacyAlgorithm::HmacSha1],
        };
        let json = serde_json::to_string(&p).expect("serializable");
        assert_eq!(json, r#"{"legacy":["dh-group1-sha1","hmac-sha1"]}"#);
        let back: AlgorithmPolicy = serde_json::from_str("{}").expect("default");
        assert!(!back.has_legacy());
    }

    #[test]
    fn modern_host_key_list_excludes_sha1_rsa() {
        let algs = modern_host_key_algorithms();
        assert!(!algs.contains(&"ssh-rsa".to_owned()));
        assert!(algs.contains(&"ssh-ed25519".to_owned()));
    }
}
