//! Network map commands: links, layout, zones, floor plans, preferences and export.

use crate::error::{CommandError, CommandResult};
use crate::state::AppState;
use cairn_core::audit::AuditEvent;
use cairn_core::map::{
    self, floorplan, layout, links, Link, MapPrefs, MapSnapshot, Position, Zone,
};
use cairn_core::CoreError;
use cairn_export::render;
use cairn_export::DiagramFormat;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

fn with<T>(
    state: &AppState,
    f: impl FnOnce(&Connection) -> Result<T, CoreError>,
) -> CommandResult<T> {
    Ok(state.vault.lock().with_conn(f)?)
}

fn invalid(msg: impl Into<String>) -> CommandError {
    CoreError::Validation(msg.into()).into()
}

#[tauri::command]
pub fn map_snapshot(state: State<'_, AppState>) -> CommandResult<MapSnapshot> {
    with(&state, map::snapshot)
}

#[tauri::command]
pub fn link_save(state: State<'_, AppState>, link: Link) -> CommandResult<Link> {
    with(&state, |c| links::save(c, &link))
}

#[tauri::command]
pub fn link_delete(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    with(&state, |c| links::delete(c, id))
}

#[tauri::command]
pub fn map_positions_save(
    state: State<'_, AppState>,
    positions: Vec<Position>,
) -> CommandResult<()> {
    with(&state, |c| layout::save_positions(c, &positions))
}

#[tauri::command]
pub fn zone_save(state: State<'_, AppState>, zone: Zone) -> CommandResult<Zone> {
    with(&state, |c| layout::save_zone(c, &zone))
}

#[tauri::command]
pub fn zone_delete(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    with(&state, |c| layout::delete_zone(c, id))
}

#[tauri::command]
pub fn map_prefs_update(state: State<'_, AppState>, prefs: MapPrefs) -> CommandResult<MapPrefs> {
    with(&state, |c| map::save_prefs(c, &prefs))
}

/// The floor plan image as raw bytes (the MIME type is in the snapshot).
#[tauri::command]
pub fn floor_plan_image(state: State<'_, AppState>, floor_id: i64) -> CommandResult<Response> {
    let (_, data) = with(&state, |c| floorplan::image(c, floor_id))?
        .ok_or_else(|| invalid("This floor has no plan."))?;
    Ok(Response::new(data))
}

/// Headers of `floor_plan_upload` (the body is the raw image).
pub const FLOOR_HEADER: &str = "x-cairn-floor";
pub const NAME_HEADER: &str = "x-cairn-name";
pub const SIZE_HEADER: &str = "x-cairn-size";

fn header<'a>(request: &'a Request<'_>, name: &str) -> CommandResult<&'a str> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| CommandError::internal(format!("missing {name} header")))
}

/// Set a floor's background image. Body: image bytes; headers: floor id, URI-encoded file
/// name and `<width>x<height>` of the decoded image.
#[tauri::command]
pub fn floor_plan_upload(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> CommandResult<floorplan::FloorPlanInfo> {
    let floor_id: i64 = header(&request, FLOOR_HEADER)?
        .parse()
        .map_err(|_| invalid("Invalid floor."))?;
    let name = percent_decode(header(&request, NAME_HEADER)?);
    let (w, h) = header(&request, SIZE_HEADER)?
        .split_once('x')
        .and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?)))
        .ok_or_else(|| invalid("Invalid image size."))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::internal(
            "floor_plan_upload expects a binary body",
        ));
    };
    with(&state, |c| floorplan::save(c, floor_id, &name, bytes, w, h))
}

/// Minimal percent-decoding for the file-name header (`encodeURIComponent` on the JS
/// side). Invalid sequences are kept literally.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
pub fn floor_plan_place(
    state: State<'_, AppState>,
    floor_id: i64,
    placement: floorplan::Placement,
) -> CommandResult<floorplan::FloorPlanInfo> {
    with(&state, |c| {
        floorplan::set_placement(c, floor_id, &placement)
    })
}

#[tauri::command]
pub fn floor_plan_delete(state: State<'_, AppState>, floor_id: i64) -> CommandResult<()> {
    with(&state, |c| floorplan::delete(c, floor_id))
}

/// Check the destination chosen in the save dialog and give it the right extension.
fn export_path(path: &str, format: DiagramFormat) -> CommandResult<PathBuf> {
    let mut p = PathBuf::from(path);
    if !p.is_absolute() || p.file_name().is_none() {
        return Err(invalid("Choose where to save the export."));
    }
    let ext = format.extension();
    if p.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
        != Some(ext)
    {
        let mut name = p.file_name().map(|n| n.to_os_string()).unwrap_or_default();
        name.push(format!(".{ext}"));
        p.set_file_name(name);
    }
    if !p.parent().is_some_and(Path::is_dir) {
        return Err(invalid("The folder for the export does not exist."));
    }
    Ok(p)
}

/// Render the map SVG built by the frontend and write it to `path`. Audited.
#[tauri::command]
pub async fn map_export(
    state: State<'_, AppState>,
    svg: String,
    format: DiagramFormat,
    scale: u32,
    path: String,
) -> CommandResult<String> {
    if !matches!(scale, 1 | 2 | 4) {
        return Err(invalid("PNG scale must be 1, 2 or 4."));
    }
    let path = export_path(&path, format)?;
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || -> CommandResult<()> {
        let bytes = match format {
            DiagramFormat::Svg => {
                // Parse once so a broken document is reported instead of written.
                render::raster_size(&svg, 1)?;
                svg.into_bytes()
            }
            DiagramFormat::Png => render::svg_to_png(&svg, scale)?,
            DiagramFormat::Pdf => render::svg_to_pdf(&svg)?,
        };
        std::fs::write(&target, bytes)
            .map_err(|e| invalid(format!("Could not write {}: {e}", target.display())))
    })
    .await
    .map_err(|e| CommandError::internal(format!("export failed: {e}")))??;
    let shown = path.display().to_string();
    state.audit.record(
        &state.vault,
        AuditEvent::DataExported {
            what: "map".into(),
            format: format.extension().into(),
            path: shown.clone(),
        },
    );
    Ok(shown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_file_names() {
        assert_eq!(
            percent_decode("Floor%201%20%E2%80%93%20plan.pdf"),
            "Floor 1 – plan.pdf"
        );
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
    }

    #[test]
    fn export_paths_get_the_right_extension() {
        let dir = tempfile::tempdir().expect("dir");
        let base = dir.path().join("campus");
        let p = export_path(&base.to_string_lossy(), DiagramFormat::Pdf).expect("pdf");
        assert_eq!(p.extension().and_then(|e| e.to_str()), Some("pdf"));
        let png = dir.path().join("map.PNG");
        assert_eq!(
            export_path(&png.to_string_lossy(), DiagramFormat::Png).expect("png"),
            png
        );
        assert!(export_path("relative.svg", DiagramFormat::Svg).is_err());
        assert!(export_path("/nonexistent-dir-xyz/a.svg", DiagramFormat::Svg).is_err());
    }
}
