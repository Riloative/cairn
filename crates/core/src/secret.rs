//! In-memory secret wrappers that zero their contents on drop and never print them.

use std::fmt;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// A secret string (password, passphrase, enable secret). Zeroed on drop; `Debug`
/// prints a placeholder so secrets cannot leak through logs.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    /// Borrow the secret. Keep the borrow short and never log it.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.chars().count()
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for SecretString {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString(***)")
    }
}

impl<'de> serde::Deserialize<'de> for SecretString {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d).map(Self)
    }
}

/// A 256-bit symmetric key, zeroed on drop.
pub type Key256 = Zeroizing<[u8; 32]>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_shows_the_secret() {
        let s = SecretString::from("hunter2");
        assert_eq!(format!("{s:?}"), "SecretString(***)");
        assert_eq!(s.expose(), "hunter2");
        assert_eq!(s.len(), 7);
    }

    #[test]
    fn deserializes_from_a_plain_string() {
        let s: SecretString = serde_json::from_str("\"pw\"").expect("valid json");
        assert_eq!(s.expose(), "pw");
    }
}
