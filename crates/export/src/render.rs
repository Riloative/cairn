//! Render map SVGs to PNG (resvg) and vector PDF (svg2pdf).
//!
//! The SVG is produced by Cairn's own map exporter. External resources are never
//! loaded: images must be inline `data:` URLs, so a crafted file name or path in the
//! document cannot make the renderer read local files.

use resvg::tiny_skia;
use resvg::usvg::{self, fontdb};
use std::sync::{Arc, OnceLock};

/// Largest PNG side in pixels (memory guard; 16384² RGBA is 1 GiB).
pub const MAX_PIXELS_PER_SIDE: u32 = 16_384;
/// Largest accepted SVG document.
pub const MAX_SVG_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("The diagram is too large to export ({0}).")]
    TooLarge(String),
    #[error("The diagram could not be read: {0}")]
    Parse(String),
    #[error("The PNG could not be created: {0}")]
    Png(String),
    #[error("The PDF could not be created: {0}")]
    Pdf(String),
}

impl cairn_core::UserFacingError for RenderError {
    fn code(&self) -> &'static str {
        match self {
            RenderError::TooLarge(_) => "export.too_large",
            RenderError::Parse(_) => "export.parse",
            RenderError::Png(_) => "export.png",
            RenderError::Pdf(_) => "export.pdf",
        }
    }

    fn hint(&self) -> Option<String> {
        match self {
            RenderError::TooLarge(_) => {
                Some("Export a selection, use a smaller PNG scale, or choose SVG or PDF.".into())
            }
            _ => None,
        }
    }
}

fn fonts() -> Arc<fontdb::Database> {
    static DB: OnceLock<Arc<fontdb::Database>> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = fontdb::Database::new();
        // Inter if installed, else the system's default sans-serif (see D-031).
        db.load_system_fonts();
        Arc::new(db)
    })
    .clone()
}

fn options() -> usvg::Options<'static> {
    let mut opt = usvg::Options {
        fontdb: fonts(),
        ..usvg::Options::default()
    };
    opt.resources_dir = None;
    opt.image_href_resolver = usvg::ImageHrefResolver {
        resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
        // Never resolve file paths or URLs.
        resolve_string: Box::new(|_, _| None),
    };
    opt
}

fn parse(svg: &str) -> Result<usvg::Tree, RenderError> {
    if svg.len() > MAX_SVG_BYTES {
        return Err(RenderError::TooLarge(format!(
            "{} MB SVG",
            svg.len() / 1024 / 1024
        )));
    }
    usvg::Tree::from_str(svg, &options()).map_err(|e| RenderError::Parse(e.to_string()))
}

/// Pixel size of a `scale`× raster of the SVG.
pub fn raster_size(svg: &str, scale: u32) -> Result<(u32, u32), RenderError> {
    let tree = parse(svg)?;
    size_of(&tree, scale)
}

fn size_of(tree: &usvg::Tree, scale: u32) -> Result<(u32, u32), RenderError> {
    let size = tree.size();
    let w = (size.width() * scale as f32).ceil() as u32;
    let h = (size.height() * scale as f32).ceil() as u32;
    if w == 0 || h == 0 || w > MAX_PIXELS_PER_SIDE || h > MAX_PIXELS_PER_SIDE {
        return Err(RenderError::TooLarge(format!(
            "{w}×{h} px; try a smaller scale or a selection"
        )));
    }
    Ok((w, h))
}

/// Render to PNG at `scale` (1, 2 or 4).
pub fn svg_to_png(svg: &str, scale: u32) -> Result<Vec<u8>, RenderError> {
    let tree = parse(svg)?;
    let (w, h) = size_of(&tree, scale)?;
    let mut pixmap = tiny_skia::Pixmap::new(w, h)
        .ok_or_else(|| RenderError::Png("could not allocate the image".into()))?;
    let s = scale as f32;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(s, s),
        &mut pixmap.as_mut(),
    );
    pixmap
        .encode_png()
        .map_err(|e| RenderError::Png(e.to_string()))
}

/// Convert to a single-page vector PDF (text kept as text, fonts subset-embedded).
pub fn svg_to_pdf(svg: &str) -> Result<Vec<u8>, RenderError> {
    let tree = parse(svg)?;
    svg2pdf::to_pdf(
        &tree,
        svg2pdf::ConversionOptions::default(),
        svg2pdf::PageOptions::default(),
    )
    .map_err(|e| RenderError::Pdf(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80">
      <rect width="120" height="80" fill="#ffffff"/>
      <path d="M10 40 H110" stroke="#3b82f6" stroke-width="4"/>
      <text x="10" y="20" font-family="Inter, sans-serif" font-size="12">core-sw1</text>
    </svg>"##;

    #[test]
    fn renders_png_at_scale() {
        let png = svg_to_png(SVG, 2).expect("png");
        assert!(png.starts_with(b"\x89PNG"));
        assert_eq!(raster_size(SVG, 4).expect("size"), (480, 320));
        // Decode and check a pixel on the blue line.
        let img = tiny_skia::Pixmap::decode_png(&png).expect("decode");
        assert_eq!((img.width(), img.height()), (240, 160));
        let px = img.pixel(120, 80).expect("pixel");
        assert!(px.blue() > 200 && px.red() < 120, "{px:?}");
    }

    #[test]
    fn renders_pdf() {
        let pdf = svg_to_pdf(SVG).expect("pdf");
        assert!(pdf.starts_with(b"%PDF-"));
        assert!(pdf.len() > 500);
    }

    #[test]
    fn refuses_huge_or_broken_input_and_external_files() {
        let huge = r#"<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="10"/>"#;
        assert!(matches!(svg_to_png(huge, 1), Err(RenderError::TooLarge(_))));
        assert!(matches!(svg_to_png("<nope", 1), Err(RenderError::Parse(_))));
        // A file reference is ignored, not read.
        let dir = tempfile::tempdir().expect("dir");
        let secret = dir.path().join("secret.png");
        std::fs::write(&secret, b"not really").expect("write");
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image href="{}" width="10" height="10"/></svg>"#,
            secret.display()
        );
        assert!(svg_to_png(&svg, 1).is_ok());
    }
}
