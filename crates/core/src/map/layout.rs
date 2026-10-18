//! Node positions and zones per map view. Layout is presentation, not inventory, so it
//! is not audited.

use super::View;
use crate::audit;
use crate::error::CoreError;
use crate::inventory::{gone, validate};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

/// Largest coordinate accepted (keeps exports and the canvas sane).
const MAX_COORD: f64 = 1.0e6;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub view: String,
    /// `d:<device id>` or `b:<building id>`.
    pub node: String,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Zone {
    #[serde(default)]
    pub id: i64,
    pub view: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub locked: bool,
}

fn check_node(node: &str) -> Result<(), CoreError> {
    let ok = node
        .split_once(':')
        .is_some_and(|(k, id)| matches!(k, "d" | "b") && id.parse::<i64>().is_ok_and(|n| n > 0));
    if ok {
        Ok(())
    } else {
        Err(CoreError::Validation(format!("Unknown map node {node}.")))
    }
}

fn check_coord(v: f64) -> Result<f64, CoreError> {
    if v.is_finite() && v.abs() <= MAX_COORD {
        Ok(v)
    } else {
        Err(CoreError::Validation("A position is out of range.".into()))
    }
}

pub fn positions(conn: &Connection) -> Result<Vec<Position>, CoreError> {
    let mut stmt =
        conn.prepare("SELECT view, node, x, y, locked FROM map_positions ORDER BY view, node")?;
    let rows = stmt.query_map([], |r| {
        Ok(Position {
            view: r.get(0)?,
            node: r.get(1)?,
            x: r.get(2)?,
            y: r.get(3)?,
            locked: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Upsert positions (one transaction). Nodes not listed keep their positions.
pub fn save_positions(conn: &Connection, items: &[Position]) -> Result<(), CoreError> {
    if items.len() > 10_000 {
        return Err(CoreError::Validation("Too many positions at once.".into()));
    }
    let tx = conn.unchecked_transaction()?;
    for p in items {
        View::parse(&p.view)?;
        check_node(&p.node)?;
        tx.execute(
            "INSERT INTO map_positions (view, node, x, y, locked) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(view, node) DO UPDATE SET x = excluded.x, y = excluded.y,
             locked = excluded.locked",
            params![
                p.view,
                p.node,
                check_coord(p.x)?,
                check_coord(p.y)?,
                p.locked
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Forget a node everywhere (device or building deleted).
pub(crate) fn forget_node(conn: &Connection, node: &str) -> Result<(), CoreError> {
    conn.execute("DELETE FROM map_positions WHERE node = ?1", [node])?;
    Ok(())
}

const ZONE_COLS: &str = "SELECT id, view, name, color, x, y, width, height, locked FROM map_zones";

fn zone_row(r: &Row<'_>) -> rusqlite::Result<Zone> {
    Ok(Zone {
        id: r.get(0)?,
        view: r.get(1)?,
        name: r.get(2)?,
        color: r.get(3)?,
        x: r.get(4)?,
        y: r.get(5)?,
        width: r.get(6)?,
        height: r.get(7)?,
        locked: r.get(8)?,
    })
}

pub fn zones(conn: &Connection) -> Result<Vec<Zone>, CoreError> {
    let mut stmt = conn.prepare(&format!("{ZONE_COLS} ORDER BY view, id"))?;
    let rows = stmt.query_map([], zone_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn save_zone(conn: &Connection, z: &Zone) -> Result<Zone, CoreError> {
    View::parse(&z.view)?;
    let name = validate::name(&z.name, "zone name", 64)?;
    let color = validate::color_or_empty(&z.color)?;
    let (x, y) = (check_coord(z.x)?, check_coord(z.y)?);
    let (w, h) = (check_coord(z.width)?, check_coord(z.height)?);
    if w < 40.0 || h < 40.0 {
        return Err(CoreError::Validation(
            "A zone must be at least 40×40.".into(),
        ));
    }
    let now = audit::now();
    let id = if z.id == 0 {
        conn.execute(
            "INSERT INTO map_zones (view, name, color, x, y, width, height, locked, created_at,
             updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![z.view, name, color, x, y, w, h, z.locked, now],
        )?;
        conn.last_insert_rowid()
    } else {
        let n = conn.execute(
            "UPDATE map_zones SET name = ?2, color = ?3, x = ?4, y = ?5, width = ?6, height = ?7,
             locked = ?8, updated_at = ?9 WHERE id = ?1",
            params![z.id, name, color, x, y, w, h, z.locked, now],
        )?;
        if n == 0 {
            return Err(gone("zone"));
        }
        z.id
    };
    conn.query_row(&format!("{ZONE_COLS} WHERE id = ?1"), [id], zone_row)
        .optional()?
        .ok_or_else(|| gone("zone"))
}

pub fn delete_zone(conn: &Connection, id: i64) -> Result<(), CoreError> {
    conn.execute("DELETE FROM map_zones WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inventory::testutil;

    fn pos(view: &str, node: &str, x: f64) -> Position {
        Position {
            view: view.into(),
            node: node.into(),
            x,
            y: 10.0,
            locked: false,
        }
    }

    #[test]
    fn positions_upsert_and_validate() {
        let c = testutil::conn();
        save_positions(
            &c,
            &[pos("floor:1", "d:1", 1.0), pos("floor:1", "d:2", 2.0)],
        )
        .expect("save");
        save_positions(&c, &[pos("floor:1", "d:1", 5.0)]).expect("update");
        let all = positions(&c).expect("list");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].x, 5.0);
        assert!(save_positions(&c, &[pos("floor:1", "x:1", 0.0)]).is_err());
        assert!(save_positions(&c, &[pos("rack:1", "d:1", 0.0)]).is_err());
        assert!(save_positions(&c, &[pos("floor:1", "d:1", f64::NAN)]).is_err());
        forget_node(&c, "d:1").expect("forget");
        assert_eq!(positions(&c).expect("list").len(), 1);
    }

    #[test]
    fn zones_round_trip() {
        let c = testutil::conn();
        let z = save_zone(
            &c,
            &Zone {
                id: 0,
                view: "floor:1".into(),
                name: "DMZ".into(),
                color: "#EF4444".into(),
                x: 0.0,
                y: 0.0,
                width: 300.0,
                height: 200.0,
                locked: false,
            },
        )
        .expect("zone");
        assert_eq!(z.color, "#ef4444");
        let moved = save_zone(
            &c,
            &Zone {
                x: 50.0,
                ..z.clone()
            },
        )
        .expect("move");
        assert_eq!(moved.x, 50.0);
        assert!(save_zone(
            &c,
            &Zone {
                width: 10.0,
                ..z.clone()
            }
        )
        .is_err());
        delete_zone(&c, z.id).expect("delete");
        assert!(zones(&c).expect("zones").is_empty());
    }
}
