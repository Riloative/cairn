//! Reverse Telnet to console servers: map a physical port number to a TCP port.

use serde::{Deserialize, Serialize};

/// How a console server maps serial ports to TCP ports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConsoleServerKind {
    /// Opengear: Telnet on 2000 + port (raw TCP on 4000 + port).
    Opengear,
    /// Cisco IOS terminal servers (async lines): Telnet on 2000 + line.
    CiscoLine,
    /// Avocent/Cyclades ACS: Telnet on 7000 + port.
    Avocent,
    /// Lantronix SLC: Telnet on 2000 + port.
    Lantronix,
    /// Digi Connect / PortServer: Telnet on 2000 + port.
    Digi,
    /// The TCP port is entered directly.
    Custom,
}

impl ConsoleServerKind {
    /// TCP port for physical `port` (1-based), or `port` itself for `Custom`.
    pub fn tcp_port(self, port: u16) -> Option<u16> {
        let base: u16 = match self {
            ConsoleServerKind::Opengear
            | ConsoleServerKind::CiscoLine
            | ConsoleServerKind::Lantronix
            | ConsoleServerKind::Digi => 2000,
            ConsoleServerKind::Avocent => 7000,
            ConsoleServerKind::Custom => return (port > 0).then_some(port),
        };
        base.checked_add(port).filter(|_| port > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_ports() {
        assert_eq!(ConsoleServerKind::Opengear.tcp_port(5), Some(2005));
        assert_eq!(ConsoleServerKind::CiscoLine.tcp_port(33), Some(2033));
        assert_eq!(ConsoleServerKind::Avocent.tcp_port(1), Some(7001));
        assert_eq!(ConsoleServerKind::Custom.tcp_port(3001), Some(3001));
        assert_eq!(ConsoleServerKind::Opengear.tcp_port(0), None);
        assert_eq!(ConsoleServerKind::Avocent.tcp_port(u16::MAX), None);
    }
}
