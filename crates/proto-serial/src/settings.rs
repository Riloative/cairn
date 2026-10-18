//! Serial line settings.

use serde::{Deserialize, Serialize};

/// Common baud rates offered as presets. 9600 is the default for Cisco consoles.
pub const BAUD_PRESETS: [u32; 10] = [
    1200, 2400, 4800, 9600, 19_200, 38_400, 57_600, 115_200, 230_400, 460_800,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DataBits {
    Five,
    Six,
    Seven,
    Eight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Parity {
    None,
    Odd,
    Even,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopBits {
    One,
    Two,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FlowControl {
    None,
    /// Hardware flow control (RTS/CTS).
    RtsCts,
    /// Software flow control (XON/XOFF).
    XonXoff,
}

/// Line parameters for a serial session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineSettings {
    pub baud: u32,
    pub data_bits: DataBits,
    pub parity: Parity,
    pub stop_bits: StopBits,
    pub flow_control: FlowControl,
}

impl Default for LineSettings {
    /// 9600 8N1, no flow control — the Cisco console default.
    fn default() -> Self {
        Self {
            baud: 9600,
            data_bits: DataBits::Eight,
            parity: Parity::None,
            stop_bits: StopBits::One,
            flow_control: FlowControl::None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SettingsError {
    #[error("Baud rate {0} is out of range (50 – 4,000,000)")]
    BaudOutOfRange(u32),
}

impl LineSettings {
    /// Validate the settings before opening a port.
    pub fn validate(&self) -> Result<(), SettingsError> {
        if !(50..=4_000_000).contains(&self.baud) {
            return Err(SettingsError::BaudOutOfRange(self.baud));
        }
        Ok(())
    }

    /// Short notation such as `9600 8N1`.
    pub fn summary(&self) -> String {
        let bits = match self.data_bits {
            DataBits::Five => 5,
            DataBits::Six => 6,
            DataBits::Seven => 7,
            DataBits::Eight => 8,
        };
        let parity = match self.parity {
            Parity::None => 'N',
            Parity::Odd => 'O',
            Parity::Even => 'E',
        };
        let stop = match self.stop_bits {
            StopBits::One => 1,
            StopBits::Two => 2,
        };
        format!("{} {bits}{parity}{stop}", self.baud)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_cisco_console() {
        let s = LineSettings::default();
        assert_eq!(s.summary(), "9600 8N1");
        assert_eq!(s.flow_control, FlowControl::None);
        assert!(s.validate().is_ok());
        assert!(BAUD_PRESETS.contains(&s.baud));
    }

    #[test]
    fn rejects_bad_baud() {
        let s = LineSettings {
            baud: 0,
            ..Default::default()
        };
        assert_eq!(s.validate(), Err(SettingsError::BaudOutOfRange(0)));
    }

    #[test]
    fn summary_reflects_settings() {
        let s = LineSettings {
            baud: 115_200,
            data_bits: DataBits::Seven,
            parity: Parity::Even,
            stop_bits: StopBits::Two,
            flow_control: FlowControl::RtsCts,
        };
        assert_eq!(s.summary(), "115200 7E2");
    }
}
