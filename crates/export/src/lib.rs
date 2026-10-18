//! Export for Cairn: diagram export (SVG → PDF), readable data export (JSON/CSV) and
//! encrypted backups.
//!
//! Renderers and the backup archive land in M5 and M8. This crate currently defines the
//! export options shared by the map export dialog.

pub mod options;

pub use options::{DiagramFormat, DiagramOptions, ExportTheme, RasterScale};
