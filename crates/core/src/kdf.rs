//! Argon2id key derivation for the master password.

use crate::error::CoreError;
use crate::secret::{Key256, SecretString};
use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

/// Argon2id parameters persisted next to the database (not secret).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    /// Memory cost in KiB.
    pub m_cost_kib: u32,
    /// Iterations.
    pub t_cost: u32,
    /// Parallelism (lanes).
    pub p_cost: u32,
    /// 16-byte random salt, hex encoded.
    pub salt: String,
}

/// Memory cost used for the master key: 64 MiB.
pub const DEFAULT_M_COST_KIB: u32 = 64 * 1024;
/// Parallel lanes.
pub const DEFAULT_P_COST: u32 = 1;
/// Lower bound on iterations regardless of calibration (OWASP minimum for 64 MiB is 1;
/// we keep a margin).
pub const MIN_T_COST: u32 = 3;
/// Upper bound so calibration on a very fast machine cannot produce absurd values.
pub const MAX_T_COST: u32 = 64;
/// Calibration target: the spec asks for roughly 0.5–1 s.
pub const TARGET: Duration = Duration::from_millis(700);

impl KdfParams {
    /// Fresh parameters with a random salt and the given costs.
    pub fn new(m_cost_kib: u32, t_cost: u32, p_cost: u32) -> Result<Self, CoreError> {
        Ok(Self {
            m_cost_kib,
            t_cost,
            p_cost,
            salt: hex::encode(random_bytes::<16>()?),
        })
    }

    /// Measure this machine and pick `t_cost` so one derivation takes about [`TARGET`].
    pub fn calibrate() -> Result<Self, CoreError> {
        let probe = Self::new(DEFAULT_M_COST_KIB, 1, DEFAULT_P_COST)?;
        let start = Instant::now();
        derive_key(&SecretString::from("calibration"), &probe)?;
        let one_pass = start.elapsed().max(Duration::from_millis(1));
        let t = (TARGET.as_secs_f64() / one_pass.as_secs_f64()).round() as u32;
        Self::new(
            DEFAULT_M_COST_KIB,
            t.clamp(MIN_T_COST, MAX_T_COST),
            DEFAULT_P_COST,
        )
    }

    fn salt_bytes(&self) -> Result<Vec<u8>, CoreError> {
        hex::decode(&self.salt).map_err(|_| CoreError::CorruptVaultFile("salt is not hex".into()))
    }
}

/// Derive a 256-bit key from a password with Argon2id.
pub fn derive_key(password: &SecretString, params: &KdfParams) -> Result<Key256, CoreError> {
    let argon_params = Params::new(params.m_cost_kib, params.t_cost, params.p_cost, Some(32))
        .map_err(|e| CoreError::CorruptVaultFile(format!("invalid Argon2 parameters: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut out = Zeroizing::new([0u8; 32]);
    let salt = params.salt_bytes()?;
    argon
        .hash_password_into(password.expose().as_bytes(), &salt, out.as_mut())
        .map_err(|e| CoreError::Crypto(format!("key derivation failed: {e}")))?;
    Ok(out)
}

/// Cryptographically secure random bytes from the OS.
pub fn random_bytes<const N: usize>() -> Result<[u8; N], CoreError> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| CoreError::Crypto(format!("OS RNG failed: {e}")))?;
    Ok(buf)
}

#[cfg(test)]
pub(crate) fn fast_params() -> KdfParams {
    // Cheap parameters so tests stay fast; production always calibrates.
    KdfParams::new(1024, 1, 1).expect("rng available")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_password_and_salt_give_same_key() {
        let p = fast_params();
        let a = derive_key(&"correct horse".into(), &p).expect("derive");
        let b = derive_key(&"correct horse".into(), &p).expect("derive");
        assert_eq!(*a, *b);
    }

    #[test]
    fn different_password_or_salt_give_different_keys() {
        let p1 = fast_params();
        let p2 = fast_params();
        let a = derive_key(&"pw".into(), &p1).expect("derive");
        let b = derive_key(&"pw2".into(), &p1).expect("derive");
        let c = derive_key(&"pw".into(), &p2).expect("derive");
        assert_ne!(*a, *b);
        assert_ne!(*a, *c);
    }

    #[test]
    fn salts_are_random() {
        assert_ne!(fast_params().salt, fast_params().salt);
        assert_eq!(fast_params().salt.len(), 32);
    }

    #[test]
    fn rejects_corrupt_salt() {
        let mut p = fast_params();
        p.salt = "zz".into();
        assert!(matches!(
            derive_key(&"pw".into(), &p),
            Err(CoreError::CorruptVaultFile(_))
        ));
    }

    #[test]
    fn calibration_respects_bounds() {
        let p = KdfParams::calibrate().expect("calibrate");
        assert!((MIN_T_COST..=MAX_T_COST).contains(&p.t_cost));
        assert_eq!(p.m_cost_kib, DEFAULT_M_COST_KIB);
    }
}
