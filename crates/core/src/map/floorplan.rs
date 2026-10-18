//! Floor-plan background images (PNG, JPEG or SVG; PDFs are rendered to PNG by the
//! importer). Stored inside the encrypted database.

use crate::audit;
use crate::error::CoreError;
use crate::inventory::{gone, record, validate};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Largest accepted image.
pub const MAX_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloorPlanInfo {
    pub floor_id: i64,
    pub name: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    /// Canvas units per image pixel.
    pub scale: f64,
    pub opacity: f64,
    pub x: f64,
    pub y: f64,
    pub bytes: u64,
}

/// Placement of a floor plan on the canvas.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub scale: f64,
    pub opacity: f64,
    pub x: f64,
    pub y: f64,
}

const COLS: &str = "SELECT floor_id, name, mime, width, height, scale, opacity, x, y,
    length(data) FROM floor_plans";

fn row(r: &Row<'_>) -> rusqlite::Result<FloorPlanInfo> {
    Ok(FloorPlanInfo {
        floor_id: r.get(0)?,
        name: r.get(1)?,
        mime: r.get(2)?,
        width: r.get(3)?,
        height: r.get(4)?,
        scale: r.get(5)?,
        opacity: r.get(6)?,
        x: r.get(7)?,
        y: r.get(8)?,
        bytes: r.get::<_, i64>(9)?.try_into().unwrap_or_default(),
    })
}

pub fn list(conn: &Connection) -> Result<Vec<FloorPlanInfo>, CoreError> {
    let mut stmt = conn.prepare(&format!("{COLS} ORDER BY floor_id"))?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, floor_id: i64) -> Result<Option<FloorPlanInfo>, CoreError> {
    Ok(conn
        .query_row(&format!("{COLS} WHERE floor_id = ?1"), [floor_id], row)
        .optional()?)
}

/// The image bytes and MIME type.
pub fn image(conn: &Connection, floor_id: i64) -> Result<Option<(String, Vec<u8>)>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT mime, data FROM floor_plans WHERE floor_id = ?1",
            [floor_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

/// The MIME type the bytes actually are (never trust the file name).
pub fn sniff(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    let head = String::from_utf8_lossy(&data[..data.len().min(2048)]).to_ascii_lowercase();
    let trimmed = head.trim_start_matches('\u{feff}').trim_start();
    if trimmed.starts_with('<') && head.contains("<svg") {
        return Some("image/svg+xml");
    }
    None
}

fn check_placement(p: &Placement) -> Result<(), CoreError> {
    let ok = p.scale.is_finite()
        && (0.01..=100.0).contains(&p.scale)
        && (0.0..=1.0).contains(&p.opacity)
        && p.x.is_finite()
        && p.y.is_finite()
        && p.x.abs() <= 1.0e6
        && p.y.abs() <= 1.0e6;
    if ok {
        Ok(())
    } else {
        Err(CoreError::Validation(
            "The floor plan placement is out of range.".into(),
        ))
    }
}

fn floor_name(conn: &Connection, floor_id: i64) -> Result<String, CoreError> {
    conn.query_row("SELECT name FROM floors WHERE id = ?1", [floor_id], |r| {
        r.get(0)
    })
    .optional()?
    .ok_or_else(|| gone("floor"))
}

/// Set (or replace) a floor's background image.
pub fn save(
    conn: &Connection,
    floor_id: i64,
    name: &str,
    data: &[u8],
    width: u32,
    height: u32,
) -> Result<FloorPlanInfo, CoreError> {
    if data.is_empty() || data.len() > MAX_BYTES {
        return Err(CoreError::Validation(format!(
            "Floor plans can be up to {} MB.",
            MAX_BYTES / 1024 / 1024
        )));
    }
    let mime = sniff(data)
        .ok_or_else(|| CoreError::Validation("Use a PNG, JPEG, SVG or PDF floor plan.".into()))?;
    if !(1..=20_000).contains(&width) || !(1..=20_000).contains(&height) {
        return Err(CoreError::Validation(
            "The floor plan's size is out of range.".into(),
        ));
    }
    let name = validate::name(name, "file name", 200)?;
    let tx = conn.unchecked_transaction()?;
    let floor = floor_name(&tx, floor_id)?;
    let old = get(&tx, floor_id)?;
    tx.execute(
        "INSERT INTO floor_plans (floor_id, name, mime, data, width, height, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(floor_id) DO UPDATE SET name = excluded.name, mime = excluded.mime,
         data = excluded.data, width = excluded.width, height = excluded.height,
         updated_at = excluded.updated_at",
        params![floor_id, name, mime, data, width, height, audit::now()],
    )?;
    let saved = get(&tx, floor_id)?.ok_or_else(|| gone("floor plan"))?;
    let view = |p: &FloorPlanInfo| json!({ "name": p.name, "mime": p.mime, "bytes": p.bytes });
    record(
        &tx,
        "floor_plan",
        floor_id,
        &floor,
        old.as_ref().map(view).as_ref(),
        Some(&view(&saved)),
    )?;
    tx.commit()?;
    Ok(saved)
}

pub fn set_placement(
    conn: &Connection,
    floor_id: i64,
    p: &Placement,
) -> Result<FloorPlanInfo, CoreError> {
    check_placement(p)?;
    let n = conn.execute(
        "UPDATE floor_plans SET scale = ?2, opacity = ?3, x = ?4, y = ?5 WHERE floor_id = ?1",
        params![floor_id, p.scale, p.opacity, p.x, p.y],
    )?;
    if n == 0 {
        return Err(gone("floor plan"));
    }
    get(conn, floor_id)?.ok_or_else(|| gone("floor plan"))
}

pub fn delete(conn: &Connection, floor_id: i64) -> Result<(), CoreError> {
    let tx = conn.unchecked_transaction()?;
    let Some(old) = get(&tx, floor_id)? else {
        return Ok(());
    };
    let floor = floor_name(&tx, floor_id)?;
    tx.execute("DELETE FROM floor_plans WHERE floor_id = ?1", [floor_id])?;
    record(
        &tx,
        "floor_plan",
        floor_id,
        &floor,
        Some(&json!({ "name": old.name, "mime": old.mime, "bytes": old.bytes })),
        None,
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inventory::testutil;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n0000";

    fn floor(c: &Connection) -> i64 {
        c.execute(
            "INSERT INTO buildings (site_id, name, created_at, updated_at) VALUES (1, 'HQ', 'x', 'x')",
            [],
        )
        .expect("b");
        let b = c.last_insert_rowid();
        c.execute(
            "INSERT INTO floors (building_id, name, created_at, updated_at) VALUES (?1, '1', 'x', 'x')",
            [b],
        )
        .expect("f");
        c.last_insert_rowid()
    }

    #[test]
    fn sniffs_real_types_only() {
        assert_eq!(sniff(PNG), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(
            sniff(b"\xef\xbb\xbf <?xml version='1.0'?><svg xmlns='x'/>"),
            Some("image/svg+xml")
        );
        assert_eq!(sniff(b"%PDF-1.7"), None);
        assert_eq!(sniff(b"GIF89a"), None);
    }

    #[test]
    fn save_place_replace_and_delete() {
        let c = testutil::conn();
        let f = floor(&c);
        let p = save(&c, f, "plan.png", PNG, 1200, 800).expect("save");
        assert_eq!(
            (p.mime.as_str(), p.bytes, p.opacity),
            ("image/png", 12, 0.6)
        );
        let placed = set_placement(
            &c,
            f,
            &Placement {
                scale: 0.5,
                opacity: 0.3,
                x: -10.0,
                y: 20.0,
            },
        )
        .expect("place");
        assert_eq!(placed.scale, 0.5);
        // Replacing the image keeps the placement.
        let again = save(&c, f, "v2.png", PNG, 600, 400).expect("replace");
        assert_eq!((again.scale, again.width), (0.5, 600));
        assert_eq!(image(&c, f).expect("img").map(|i| i.1.len()), Some(12));
        assert!(save(&c, f, "x.gif", b"GIF89a", 1, 1).is_err());
        assert!(save(&c, 999, "x.png", PNG, 1, 1).is_err());
        assert!(set_placement(
            &c,
            f,
            &Placement {
                scale: 0.0,
                opacity: 1.0,
                x: 0.0,
                y: 0.0
            }
        )
        .is_err());
        delete(&c, f).expect("delete");
        assert!(list(&c).expect("list").is_empty());
        let kinds: Vec<_> = testutil::changes(&c)
            .iter()
            .map(|e| e["action"].as_str().unwrap_or_default().to_owned())
            .collect();
        assert_eq!(kinds, ["created", "updated", "deleted"]);
    }
}
