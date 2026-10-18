//! Algorithm policy: modern defaults plus per-device legacy opt-ins.

use serde::{Deserialize, Serialize};

/// A legacy (weak) algorithm a device can opt into. Enabling any of them shows a warning
/// badge on the device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LegacyAlgorithm {
    /// `diffie-hellman-group1-sha1` key exchange (1024-bit Oakley group 2).
    DhGroup1Sha1,
    /// `diffie-hellman-group14-sha1` key exchange.
    DhGroup14Sha1,
    /// `ssh-rsa` host key / signature algorithm using SHA-1.
    SshRsaSha1,
    /// AES in CBC mode (`aes128-cbc`, `aes192-cbc`, `aes256-cbc`).
    AesCbc,
}

impl LegacyAlgorithm {
    pub const ALL: [LegacyAlgorithm; 4] = [
        LegacyAlgorithm::DhGroup1Sha1,
        LegacyAlgorithm::DhGroup14Sha1,
        LegacyAlgorithm::SshRsaSha1,
        LegacyAlgorithm::AesCbc,
    ];

    /// The SSH wire names this opt-in enables.
    pub fn wire_names(self) -> &'static [&'static str] {
        match self {
            LegacyAlgorithm::DhGroup1Sha1 => &["diffie-hellman-group1-sha1"],
            LegacyAlgorithm::DhGroup14Sha1 => &["diffie-hellman-group14-sha1"],
            LegacyAlgorithm::SshRsaSha1 => &["ssh-rsa"],
            LegacyAlgorithm::AesCbc => &["aes128-cbc", "aes192-cbc", "aes256-cbc"],
        }
    }
}

/// Which algorithms a connection may negotiate.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlgorithmPolicy {
    /// Legacy algorithms enabled for this device, appended after the modern defaults so
    /// they are only used when the server offers nothing better.
    pub legacy: Vec<LegacyAlgorithm>,
}

impl AlgorithmPolicy {
    /// True when any legacy algorithm is enabled (the UI shows a warning badge).
    pub fn has_legacy(&self) -> bool {
        !self.legacy.is_empty()
    }

    /// Whether a given legacy algorithm is enabled.
    pub fn allows(&self, alg: LegacyAlgorithm) -> bool {
        self.legacy.contains(&alg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_is_modern_only() {
        let p = AlgorithmPolicy::default();
        assert!(!p.has_legacy());
        assert!(LegacyAlgorithm::ALL.iter().all(|a| !p.allows(*a)));
    }

    #[test]
    fn legacy_opt_in_covers_the_spec_list() {
        let names: Vec<&str> = LegacyAlgorithm::ALL
            .iter()
            .flat_map(|a| a.wire_names().iter().copied())
            .collect();
        for required in [
            "diffie-hellman-group1-sha1",
            "diffie-hellman-group14-sha1",
            "ssh-rsa",
            "aes128-cbc",
            "aes256-cbc",
        ] {
            assert!(names.contains(&required), "missing {required}");
        }
    }

    #[test]
    fn serializes_kebab_case() {
        let p = AlgorithmPolicy {
            legacy: vec![LegacyAlgorithm::DhGroup1Sha1],
        };
        let json = serde_json::to_string(&p).expect("serializable");
        assert_eq!(json, r#"{"legacy":["dh-group1-sha1"]}"#);
        assert!(p.has_legacy());
    }
}
