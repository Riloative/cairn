//! RDP display profile.

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ColorDepth {
    Bpp16,
    Bpp24,
    Bpp32,
}

impl ColorDepth {
    pub fn bits(self) -> u8 {
        match self {
            ColorDepth::Bpp16 => 16,
            ColorDepth::Bpp24 => 24,
            ColorDepth::Bpp32 => 32,
        }
    }
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

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProfileError {
    /// MS-RDPBCGR limits desktop size to 200..=8192 pixels per side.
    #[error("Resolution {0}×{1} is outside the RDP range of 200–8192 pixels per side")]
    ResolutionOutOfRange(u16, u16),
}

impl DisplayProfile {
    pub fn validate(&self) -> Result<(), ProfileError> {
        if let Resolution::Fixed { width, height } = self.resolution {
            let ok = |v: u16| (200..=8192).contains(&v);
            if !ok(width) || !ok(height) {
                return Err(ProfileError::ResolutionOutOfRange(width, height));
            }
        }
        Ok(())
    }
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
}
