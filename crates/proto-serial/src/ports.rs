//! Serial port discovery with friendly USB names and hotplug diffing.

use serde::Serialize;
use serialport::{SerialPortType, UsbPortInfo};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    /// Device path to open (`/dev/ttyUSB0`, `/dev/cu.usbserial-1410`, `COM3`).
    pub path: String,
    /// Human label, e.g. "FTDI FT232R (A50285BI)".
    pub label: String,
    /// USB adapter chip family when known.
    pub chip: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub serial_number: Option<String>,
    pub usb: bool,
}

/// Chip family by USB vendor id (and product id where a vendor makes several chips).
pub fn chip_name(vid: u16, pid: u16) -> Option<&'static str> {
    Some(match (vid, pid) {
        (0x0403, 0x6001) => "FTDI FT232R",
        (0x0403, 0x6010) => "FTDI FT2232",
        (0x0403, 0x6011) => "FTDI FT4232",
        (0x0403, 0x6014) => "FTDI FT232H",
        (0x0403, 0x6015) => "FTDI FT-X",
        (0x0403, _) => "FTDI",
        (0x067b, 0x23a3) => "Prolific PL2303GC",
        (0x067b, _) => "Prolific PL2303",
        (0x10c4, 0xea60) => "Silicon Labs CP210x",
        (0x10c4, 0xea70) => "Silicon Labs CP2105",
        (0x10c4, _) => "Silicon Labs",
        (0x1a86, 0x7523) => "WCH CH340",
        (0x1a86, 0x55d4) => "WCH CH9102",
        (0x1a86, _) => "WCH",
        (0x05c6, _) | (0x2c7c, _) => "Qualcomm/Quectel modem",
        (0x0525, 0xa4a7) => "Linux USB gadget",
        // Cisco USB console (mini-USB / USB-C ports on Catalyst switches)
        (0x05a6, 0x0009) => "Cisco USB console",
        (0x2341, _) => "Arduino",
        _ => return None,
    })
}

fn describe(path: &str, usb: Option<&UsbPortInfo>) -> PortInfo {
    let name = path.rsplit('/').next().unwrap_or(path).to_owned();
    match usb {
        Some(u) => {
            let chip = chip_name(u.vid, u.pid).map(str::to_owned);
            let product = u.product.clone().filter(|p| !p.trim().is_empty());
            let base = chip
                .clone()
                .or(product)
                .unwrap_or_else(|| format!("USB {:04x}:{:04x}", u.vid, u.pid));
            let label = match &u.serial_number {
                Some(sn) if !sn.is_empty() => format!("{base} ({sn})"),
                _ => format!("{base} — {name}"),
            };
            PortInfo {
                path: path.to_owned(),
                label,
                chip,
                vid: Some(u.vid),
                pid: Some(u.pid),
                serial_number: u.serial_number.clone(),
                usb: true,
            }
        }
        None => PortInfo {
            path: path.to_owned(),
            label: name,
            chip: None,
            vid: None,
            pid: None,
            serial_number: None,
            usb: false,
        },
    }
}

/// Filter and order raw ports. On macOS only `/dev/cu.*` is kept (call-out devices do
/// not block waiting for carrier detect, unlike `/dev/tty.*`); Bluetooth and debug
/// pseudo-ports are dropped. USB adapters come first.
pub fn normalize(raw: Vec<(String, Option<UsbPortInfo>)>, macos: bool) -> Vec<PortInfo> {
    let mut out: Vec<PortInfo> = raw
        .into_iter()
        .filter(|(p, _)| {
            if macos {
                p.starts_with("/dev/cu.")
                    && !p.contains("Bluetooth")
                    && !p.contains("debug-console")
            } else {
                true
            }
        })
        .map(|(p, usb)| describe(&p, usb.as_ref()))
        .collect();
    out.sort_by(|a, b| b.usb.cmp(&a.usb).then_with(|| a.path.cmp(&b.path)));
    out.dedup_by(|a, b| a.path == b.path);
    out
}

/// List serial ports on this machine.
pub fn list() -> Vec<PortInfo> {
    let raw = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let usb = match p.port_type {
                SerialPortType::UsbPort(u) => Some(u),
                _ => None,
            };
            (p.port_name, usb)
        })
        .collect();
    normalize(raw, cfg!(target_os = "macos"))
}

/// Ports that appeared and disappeared between two scans (by path).
pub fn diff(before: &[PortInfo], after: &[PortInfo]) -> (Vec<PortInfo>, Vec<PortInfo>) {
    let added = after
        .iter()
        .filter(|a| !before.iter().any(|b| b.path == a.path))
        .cloned()
        .collect();
    let removed = before
        .iter()
        .filter(|b| !after.iter().any(|a| a.path == b.path))
        .cloned()
        .collect();
    (added, removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usb(vid: u16, pid: u16, sn: Option<&str>, product: Option<&str>) -> Option<UsbPortInfo> {
        Some(UsbPortInfo {
            vid,
            pid,
            serial_number: sn.map(str::to_owned),
            manufacturer: None,
            product: product.map(str::to_owned),
        })
    }

    #[test]
    fn friendly_names_for_common_adapters() {
        assert_eq!(chip_name(0x0403, 0x6001), Some("FTDI FT232R"));
        assert_eq!(chip_name(0x067b, 0x2303), Some("Prolific PL2303"));
        assert_eq!(chip_name(0x10c4, 0xea60), Some("Silicon Labs CP210x"));
        assert_eq!(chip_name(0x1a86, 0x7523), Some("WCH CH340"));
        assert_eq!(chip_name(0x1234, 0x5678), None);
    }

    #[test]
    fn labels_and_order() {
        let ports = normalize(
            vec![
                ("/dev/ttyS0".into(), None),
                ("/dev/ttyUSB1".into(), usb(0x1a86, 0x7523, None, None)),
                (
                    "/dev/ttyUSB0".into(),
                    usb(0x0403, 0x6001, Some("A50285BI"), Some("FT232R USB UART")),
                ),
                (
                    "/dev/ttyACM0".into(),
                    usb(0xabcd, 0x0001, None, Some("Console Cable")),
                ),
            ],
            false,
        );
        let labels: Vec<&str> = ports.iter().map(|p| p.label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "Console Cable — ttyACM0",
                "FTDI FT232R (A50285BI)",
                "WCH CH340 — ttyUSB1",
                "ttyS0"
            ]
        );
    }

    #[test]
    fn macos_prefers_call_out_devices() {
        let ports = normalize(
            vec![
                (
                    "/dev/tty.usbserial-1410".into(),
                    usb(0x0403, 0x6001, None, None),
                ),
                (
                    "/dev/cu.usbserial-1410".into(),
                    usb(0x0403, 0x6001, None, None),
                ),
                ("/dev/cu.Bluetooth-Incoming-Port".into(), None),
            ],
            true,
        );
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].path, "/dev/cu.usbserial-1410");
    }

    #[test]
    fn hotplug_diff() {
        let a = normalize(vec![("/dev/ttyUSB0".into(), None)], false);
        let b = normalize(vec![("/dev/ttyUSB1".into(), None)], false);
        let (added, removed) = diff(&a, &b);
        assert_eq!(added[0].path, "/dev/ttyUSB1");
        assert_eq!(removed[0].path, "/dev/ttyUSB0");
    }
}
