//! Telnet command (RFC 854) and option codes.

/// "Interpret As Command" escape byte.
pub const IAC: u8 = 255;

/// Telnet commands that follow an [`IAC`] byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// End of subnegotiation parameters.
    Se,
    Nop,
    DataMark,
    Break,
    InterruptProcess,
    AbortOutput,
    AreYouThere,
    EraseCharacter,
    EraseLine,
    GoAhead,
    /// Start of subnegotiation.
    Sb,
    Will,
    Wont,
    Do,
    Dont,
    /// An escaped literal 0xFF data byte.
    Iac,
}

impl Command {
    pub fn from_byte(b: u8) -> Option<Self> {
        Some(match b {
            240 => Self::Se,
            241 => Self::Nop,
            242 => Self::DataMark,
            243 => Self::Break,
            244 => Self::InterruptProcess,
            245 => Self::AbortOutput,
            246 => Self::AreYouThere,
            247 => Self::EraseCharacter,
            248 => Self::EraseLine,
            249 => Self::GoAhead,
            250 => Self::Sb,
            251 => Self::Will,
            252 => Self::Wont,
            253 => Self::Do,
            254 => Self::Dont,
            255 => Self::Iac,
            _ => return None,
        })
    }

    pub fn to_byte(self) -> u8 {
        match self {
            Self::Se => 240,
            Self::Nop => 241,
            Self::DataMark => 242,
            Self::Break => 243,
            Self::InterruptProcess => 244,
            Self::AbortOutput => 245,
            Self::AreYouThere => 246,
            Self::EraseCharacter => 247,
            Self::EraseLine => 248,
            Self::GoAhead => 249,
            Self::Sb => 250,
            Self::Will => 251,
            Self::Wont => 252,
            Self::Do => 253,
            Self::Dont => 254,
            Self::Iac => 255,
        }
    }

    /// Whether this command is followed by an option byte (WILL/WONT/DO/DONT).
    pub fn takes_option(self) -> bool {
        matches!(self, Self::Will | Self::Wont | Self::Do | Self::Dont)
    }
}

/// Telnet options Cairn understands. Unknown options are carried as [`TelnetOption::Other`]
/// and refused during negotiation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TelnetOption {
    /// RFC 856.
    BinaryTransmission,
    /// RFC 857.
    Echo,
    /// RFC 858.
    SuppressGoAhead,
    /// RFC 859.
    Status,
    /// RFC 1091.
    TerminalType,
    /// RFC 1073 — Negotiate About Window Size.
    Naws,
    /// RFC 1079.
    TerminalSpeed,
    /// RFC 1372.
    LineMode,
    /// RFC 1572.
    NewEnviron,
    Other(u8),
}

impl TelnetOption {
    pub fn from_byte(b: u8) -> Self {
        match b {
            0 => Self::BinaryTransmission,
            1 => Self::Echo,
            3 => Self::SuppressGoAhead,
            5 => Self::Status,
            24 => Self::TerminalType,
            31 => Self::Naws,
            32 => Self::TerminalSpeed,
            34 => Self::LineMode,
            39 => Self::NewEnviron,
            other => Self::Other(other),
        }
    }

    pub fn to_byte(self) -> u8 {
        match self {
            Self::BinaryTransmission => 0,
            Self::Echo => 1,
            Self::SuppressGoAhead => 3,
            Self::Status => 5,
            Self::TerminalType => 24,
            Self::Naws => 31,
            Self::TerminalSpeed => 32,
            Self::LineMode => 34,
            Self::NewEnviron => 39,
            Self::Other(b) => b,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_roundtrip() {
        for b in 240..=255u8 {
            let c = Command::from_byte(b).expect("all 240..=255 are commands");
            assert_eq!(c.to_byte(), b);
        }
        assert_eq!(Command::from_byte(239), None);
        assert_eq!(Command::from_byte(IAC), Some(Command::Iac));
    }

    #[test]
    fn option_roundtrip() {
        for b in 0..=255u8 {
            assert_eq!(TelnetOption::from_byte(b).to_byte(), b);
        }
        assert_eq!(TelnetOption::from_byte(31), TelnetOption::Naws);
    }

    #[test]
    fn negotiation_commands_take_an_option() {
        assert!(Command::Will.takes_option());
        assert!(Command::Dont.takes_option());
        assert!(!Command::Sb.takes_option());
        assert!(!Command::Break.takes_option());
    }
}
