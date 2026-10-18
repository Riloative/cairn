//! Session protocols supported by Cairn.

use serde::{Deserialize, Serialize};

/// A connection protocol. Serialized in lowercase for IPC and storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Ssh,
    Telnet,
    Serial,
    Rdp,
    /// A local shell on this machine.
    Local,
}

impl Protocol {
    pub const ALL: [Protocol; 5] = [
        Protocol::Ssh,
        Protocol::Telnet,
        Protocol::Serial,
        Protocol::Rdp,
        Protocol::Local,
    ];

    /// Display label shown in the UI.
    pub fn label(self) -> &'static str {
        match self {
            Protocol::Ssh => "SSH",
            Protocol::Telnet => "Telnet",
            Protocol::Serial => "Serial",
            Protocol::Rdp => "RDP",
            Protocol::Local => "Local shell",
        }
    }

    /// Whether the session is a byte-stream terminal (as opposed to a graphical session).
    pub fn is_terminal(self) -> bool {
        !matches!(self, Protocol::Rdp)
    }

    /// Whether the session reaches another machine over the network.
    pub fn is_remote(self) -> bool {
        matches!(self, Protocol::Ssh | Protocol::Telnet | Protocol::Rdp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&Protocol::Ssh).expect("serializable"),
            "\"ssh\""
        );
        let p: Protocol = serde_json::from_str("\"serial\"").expect("deserializable");
        assert_eq!(p, Protocol::Serial);
    }

    #[test]
    fn classification() {
        assert!(Protocol::Ssh.is_remote() && Protocol::Ssh.is_terminal());
        assert!(!Protocol::Serial.is_remote() && Protocol::Serial.is_terminal());
        assert!(Protocol::Rdp.is_remote() && !Protocol::Rdp.is_terminal());
        assert!(!Protocol::Local.is_remote());
        assert_eq!(Protocol::ALL.len(), 5);
    }
}
