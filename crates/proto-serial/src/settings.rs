//! Serial line settings.

use serde::{Deserialize, Serialize};

/// Common baud rates offered as presets. 9600 is the default for Cisco consoles.
pub const BAUD_PRESETS: [u32; 10] = [
    1200, 2400, 4800, 9600, 19_200, 38_400, 57_600, 115_200, 230_400, 460_800,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
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
#[serde(rename_all = "lowercase")]
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
#[serde(rename_all = "camelCase")]
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

impl From<DataBits> for serialport::DataBits {
    fn from(d: DataBits) -> Self {
        match d {
            DataBits::Five => serialport::DataBits::Five,
            DataBits::Six => serialport::DataBits::Six,
            DataBits::Seven => serialport::DataBits::Seven,
            DataBits::Eight => serialport::DataBits::Eight,
        }
    }
}

impl From<Parity> for serialport::Parity {
    fn from(p: Parity) -> Self {
        match p {
            Parity::None => serialport::Parity::None,
            Parity::Odd => serialport::Parity::Odd,
            Parity::Even => serialport::Parity::Even,
        }
    }
}

impl From<StopBits> for serialport::StopBits {
    fn from(s: StopBits) -> Self {
        match s {
            StopBits::One => serialport::StopBits::One,
            StopBits::Two => serialport::StopBits::Two,
        }
    }
}

impl From<FlowControl> for serialport::FlowControl {
    fn from(f: FlowControl) -> Self {
        match f {
            FlowControl::None => serialport::FlowControl::None,
            FlowControl::RtsCts => serialport::FlowControl::Hardware,
            FlowControl::XonXoff => serialport::FlowControl::Software,
        }
    }
}

/// What the Enter key sends, and how received line endings are shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Newline {
    /// Carriage return (the console default).
    #[default]
    Cr,
    Lf,
    CrLf,
}

/// Newline handling in both directions. Default: Enter sends CR, received data unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewlineMapping {
    /// Sent when the user presses Enter (the terminal produces CR).
    pub transmit: Newline,
    /// How a received line ending is turned into CR LF for display: `Lf` treats a lone
    /// LF as a newline, `Cr` a lone CR, `CrLf` passes data unchanged.
    pub receive: Newline,
}

impl Default for NewlineMapping {
    fn default() -> Self {
        Self {
            transmit: Newline::Cr,
            receive: Newline::CrLf,
        }
    }
}

impl NewlineMapping {
    /// Map outgoing bytes: every CR from the keyboard becomes the configured sequence.
    pub fn map_tx(&self, data: &[u8]) -> Vec<u8> {
        let nl: &[u8] = match self.transmit {
            Newline::Cr => return data.to_vec(),
            Newline::Lf => b"\n",
            Newline::CrLf => b"\r\n",
        };
        let mut out = Vec::with_capacity(data.len() + 4);
        for &b in data {
            if b == b'\r' {
                out.extend_from_slice(nl);
            } else {
                out.push(b);
            }
        }
        out
    }

    /// Map incoming bytes for display. `prev` carries the last byte of the previous chunk.
    pub fn map_rx(&self, data: &[u8], prev: &mut u8) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len() + 8);
        for &b in data {
            match self.receive {
                Newline::Lf if b == b'\n' && *prev != b'\r' => out.extend_from_slice(b"\r\n"),
                Newline::Cr if b == b'\r' => out.extend_from_slice(b"\r\n"),
                Newline::Cr if b == b'\n' && *prev == b'\r' => {}
                _ => out.push(b),
            }
            *prev = b;
        }
        out
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
    fn newline_tx_mapping() {
        let m = |t| NewlineMapping {
            transmit: t,
            receive: Newline::CrLf,
        };
        assert_eq!(m(Newline::Cr).map_tx(b"show\r"), b"show\r");
        assert_eq!(m(Newline::Lf).map_tx(b"show\r"), b"show\n");
        assert_eq!(m(Newline::CrLf).map_tx(b"a\rb\r"), b"a\r\nb\r\n");
    }

    #[test]
    fn newline_rx_mapping_across_chunks() {
        let lf = NewlineMapping {
            transmit: Newline::Cr,
            receive: Newline::Lf,
        };
        let mut prev = 0;
        assert_eq!(lf.map_rx(b"a\nb\r", &mut prev), b"a\r\nb\r");
        assert_eq!(
            lf.map_rx(b"\nc", &mut prev),
            b"\nc",
            "CR LF split across chunks"
        );
        let cr = NewlineMapping {
            transmit: Newline::Cr,
            receive: Newline::Cr,
        };
        let mut prev = 0;
        assert_eq!(cr.map_rx(b"x\ry\r\nz", &mut prev), b"x\r\ny\r\nz");
        let raw = NewlineMapping::default();
        assert_eq!(raw.map_rx(b"a\nb", &mut 0), b"a\nb");
    }

    #[test]
    fn serializes_for_ipc() {
        let json = serde_json::to_value(LineSettings::default()).expect("json");
        assert_eq!(json["baud"], 9600);
        assert_eq!(json["dataBits"], "eight");
        assert_eq!(json["flowControl"], "none");
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
