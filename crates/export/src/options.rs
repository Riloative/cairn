//! Diagram export options.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagramFormat {
    Png,
    Svg,
    Pdf,
}

impl DiagramFormat {
    pub fn extension(self) -> &'static str {
        match self {
            DiagramFormat::Png => "png",
            DiagramFormat::Svg => "svg",
            DiagramFormat::Pdf => "pdf",
        }
    }

    /// Vector formats ignore the raster scale.
    pub fn is_vector(self) -> bool {
        !matches!(self, DiagramFormat::Png)
    }
}

/// PNG pixel density multiplier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RasterScale {
    X1,
    X2,
    X4,
}

impl RasterScale {
    pub fn factor(self) -> u32 {
        match self {
            RasterScale::X1 => 1,
            RasterScale::X2 => 2,
            RasterScale::X4 => 4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportTheme {
    /// Use the current app theme.
    FollowApp,
    /// Force a light theme, e.g. for printing.
    ForceLight,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagramOptions {
    pub format: DiagramFormat,
    pub scale: RasterScale,
    pub theme: ExportTheme,
    pub title: Option<String>,
    pub include_legend: bool,
    pub include_date: bool,
}

impl Default for DiagramOptions {
    fn default() -> Self {
        Self {
            format: DiagramFormat::Svg,
            scale: RasterScale::X2,
            theme: ExportTheme::FollowApp,
            title: None,
            include_legend: true,
            include_date: true,
        }
    }
}

impl DiagramOptions {
    /// Output pixel size for a raster export of a `width`×`height` view, or `None` for
    /// vector formats.
    pub fn raster_size(&self, width: u32, height: u32) -> Option<(u32, u32)> {
        if self.format.is_vector() {
            return None;
        }
        let f = self.scale.factor();
        Some((width.saturating_mul(f), height.saturating_mul(f)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raster_size_scales_only_png() {
        let mut o = DiagramOptions {
            format: DiagramFormat::Png,
            scale: RasterScale::X4,
            ..Default::default()
        };
        assert_eq!(o.raster_size(800, 600), Some((3200, 2400)));
        o.format = DiagramFormat::Pdf;
        assert_eq!(o.raster_size(800, 600), None);
    }

    #[test]
    fn extensions() {
        assert_eq!(DiagramFormat::Png.extension(), "png");
        assert_eq!(DiagramFormat::Svg.extension(), "svg");
        assert_eq!(DiagramFormat::Pdf.extension(), "pdf");
    }

    #[test]
    fn serializes_for_ipc() {
        let json = serde_json::to_value(DiagramOptions::default()).expect("serializable");
        assert_eq!(json["format"], "svg");
        assert_eq!(json["theme"], "follow-app");
        assert_eq!(json["scale"], "X2");
    }
}
