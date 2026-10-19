//! RDP display and security profile.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum Resolution {
    /// Follow the session view size, resizing dynamically.
    FitWindow,
    Fixed {
        width: u16,
        height: u16,
    },
}

/// Bits per pixel requested from the server. IronRDP decodes 16 and 32 bpp only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ColorDepth {
    Bpp16,
    Bpp32,
}

impl ColorDepth {
    pub fn bits(self) -> u32 {
        match self {
            ColorDepth::Bpp16 => 16,
            ColorDepth::Bpp32 => 32,
        }
    }
}

/// How the connection is secured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Security {
    /// Network Level Authentication (CredSSP over TLS): credentials are checked before a
    /// desktop is created. The default and what Windows requires out of the box.
    #[default]
    Nla,
    /// TLS only; the server shows its own logon screen. For servers without NLA.
    Tls,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayProfile {
    pub resolution: Resolution,
    pub color_depth: ColorDepth,
}

impl Default for DisplayProfile {
    fn default() -> Self {
        Self {
            resolution: Resolution::FitWindow,
            color_depth: ColorDepth::Bpp32,
        }
    }
}

/// MS-RDPBCGR limits the desktop to 200..=8192 pixels per side.
pub const MIN_SIDE: u16 = 200;
pub const MAX_SIDE: u16 = 8192;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProfileError {
    #[error("Resolution {0}×{1} is outside the RDP range of 200–8192 pixels per side")]
    ResolutionOutOfRange(u16, u16),
}

impl DisplayProfile {
    pub fn validate(&self) -> Result<(), ProfileError> {
        if let Resolution::Fixed { width, height } = self.resolution {
            let ok = |v: u16| (MIN_SIDE..=MAX_SIDE).contains(&v);
            if !ok(width) || !ok(height) {
                return Err(ProfileError::ResolutionOutOfRange(width, height));
            }
        }
        Ok(())
    }
}

/// Clamp a requested desktop size into the protocol range. Display Control also wants an
/// even width.
pub fn clamp_size(width: u32, height: u32) -> (u16, u16) {
    let clamp = |v: u32| v.clamp(u32::from(MIN_SIDE), u32::from(MAX_SIDE)) as u16;
    (clamp(width) & !1, clamp(height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_fits_window_at_32bpp() {
        let p = DisplayProfile::default();
        assert_eq!(p.resolution, Resolution::FitWindow);
        assert_eq!(p.color_depth.bits(), 32);
        assert!(p.validate().is_ok());
        assert_eq!(Security::default(), Security::Nla);
    }

    #[test]
    fn rejects_out_of_range_resolution() {
        let p = DisplayProfile {
            resolution: Resolution::Fixed {
                width: 100,
                height: 768,
            },
            ..Default::default()
        };
        assert_eq!(
            p.validate(),
            Err(ProfileError::ResolutionOutOfRange(100, 768))
        );
    }

    #[test]
    fn resolution_serializes_tagged() {
        let json = serde_json::to_string(&Resolution::Fixed {
            width: 1920,
            height: 1080,
        })
        .expect("serializable");
        assert_eq!(json, r#"{"mode":"fixed","width":1920,"height":1080}"#);
    }

    #[test]
    fn clamps_sizes_into_range_with_even_width() {
        assert_eq!(clamp_size(1281, 721), (1280, 721));
        assert_eq!(clamp_size(50, 50), (200, 200));
        assert_eq!(clamp_size(10_000, 9_000), (8192, 8192));
    }
}
