//! Location hierarchy: Site → Building → Floor → (Room) → Rack.

use super::{gone, record, unique, validate};
use crate::audit;
use crate::error::CoreError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Site {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Building {
    #[serde(default)]
    pub id: i64,
    pub site_id: i64,
    pub name: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Floor {
    #[serde(default)]
    pub id: i64,
    pub building_id: i64,
    pub name: String,
    /// Sort order (0 = ground floor, negative = basement).
    #[serde(default)]
    pub level: i64,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    #[serde(default)]
    pub id: i64,
    pub floor_id: i64,
    pub name: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rack {
    #[serde(default)]
    pub id: i64,
    pub floor_id: i64,
    #[serde(default)]
    pub room_id: Option<i64>,
    pub name: String,
    #[serde(default = "default_height")]
    pub height_u: u16,
    #[serde(default)]
    pub notes: String,
}

fn default_height() -> u16 {
    42
}

/// Which kind of location an id refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocationKind {
    Site,
    Building,
    Floor,
    Room,
    Rack,
}

impl LocationKind {
    fn table(self) -> &'static str {
        match self {
            LocationKind::Site => "sites",
            LocationKind::Building => "buildings",
            LocationKind::Floor => "floors",
            LocationKind::Room => "rooms",
            LocationKind::Rack => "racks",
        }
    }

    fn noun(self) -> &'static str {
        match self {
            LocationKind::Site => "site",
            LocationKind::Building => "building",
            LocationKind::Floor => "floor",
            LocationKind::Room => "room",
            LocationKind::Rack => "rack",
        }
    }
}

// ── Reading ──────────────────────────────────────────────────────────────────────

fn site_row(r: &Row<'_>) -> rusqlite::Result<Site> {
    Ok(Site {
        id: r.get(0)?,
        name: r.get(1)?,
        notes: r.get(2)?,
    })
}

fn building_row(r: &Row<'_>) -> rusqlite::Result<Building> {
    Ok(Building {
        id: r.get(0)?,
        site_id: r.get(1)?,
        name: r.get(2)?,
        code: r.get(3)?,
        address: r.get(4)?,
        notes: r.get(5)?,
    })
}

fn floor_row(r: &Row<'_>) -> rusqlite::Result<Floor> {
    Ok(Floor {
        id: r.get(0)?,
        building_id: r.get(1)?,
        name: r.get(2)?,
        level: r.get(3)?,
        notes: r.get(4)?,
    })
}

fn room_row(r: &Row<'_>) -> rusqlite::Result<Room> {
    Ok(Room {
        id: r.get(0)?,
        floor_id: r.get(1)?,
        name: r.get(2)?,
        notes: r.get(3)?,
    })
}

fn rack_row(r: &Row<'_>) -> rusqlite::Result<Rack> {
    Ok(Rack {
        id: r.get(0)?,
        floor_id: r.get(1)?,
        room_id: r.get(2)?,
        name: r.get(3)?,
        height_u: r.get(4)?,
        notes: r.get(5)?,
    })
}

const SITE_COLS: &str = "SELECT id, name, notes FROM sites";
const BUILDING_COLS: &str = "SELECT id, site_id, name, code, address, notes FROM buildings";
const FLOOR_COLS: &str = "SELECT id, building_id, name, level, notes FROM floors";
const ROOM_COLS: &str = "SELECT id, floor_id, name, notes FROM rooms";
const RACK_COLS: &str = "SELECT id, floor_id, room_id, name, height_u, notes FROM racks";

fn all<T>(
    conn: &Connection,
    sql: &str,
    f: fn(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, CoreError> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], f)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn one<T>(
    conn: &Connection,
    sql: &str,
    id: i64,
    f: fn(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Option<T>, CoreError> {
    Ok(conn
        .query_row(&format!("{sql} WHERE id = ?1"), [id], f)
        .optional()?)
}

pub fn sites(conn: &Connection) -> Result<Vec<Site>, CoreError> {
    all(
        conn,
        &format!("{SITE_COLS} ORDER BY name COLLATE NOCASE"),
        site_row,
    )
}

pub fn buildings(conn: &Connection) -> Result<Vec<Building>, CoreError> {
    all(
        conn,
        &format!("{BUILDING_COLS} ORDER BY name COLLATE NOCASE"),
        building_row,
    )
}

pub fn floors(conn: &Connection) -> Result<Vec<Floor>, CoreError> {
    all(
        conn,
        &format!("{FLOOR_COLS} ORDER BY building_id, level, name COLLATE NOCASE"),
        floor_row,
    )
}

pub fn rooms(conn: &Connection) -> Result<Vec<Room>, CoreError> {
    all(
        conn,
        &format!("{ROOM_COLS} ORDER BY name COLLATE NOCASE"),
        room_row,
    )
}

pub fn racks(conn: &Connection) -> Result<Vec<Rack>, CoreError> {
    all(
        conn,
        &format!("{RACK_COLS} ORDER BY name COLLATE NOCASE"),
        rack_row,
    )
}

pub fn rack(conn: &Connection, id: i64) -> Result<Option<Rack>, CoreError> {
    one(conn, RACK_COLS, id, rack_row)
}

pub fn room(conn: &Connection, id: i64) -> Result<Option<Room>, CoreError> {
    one(conn, ROOM_COLS, id, room_row)
}

pub fn floor(conn: &Connection, id: i64) -> Result<Option<Floor>, CoreError> {
    one(conn, FLOOR_COLS, id, floor_row)
}

pub fn building(conn: &Connection, id: i64) -> Result<Option<Building>, CoreError> {
    one(conn, BUILDING_COLS, id, building_row)
}

// ── Writing ──────────────────────────────────────────────────────────────────────

fn exists(conn: &Connection, kind: LocationKind, id: i64) -> Result<(), CoreError> {
    let found: Option<i64> = conn
        .query_row(
            &format!("SELECT id FROM {} WHERE id = ?1", kind.table()),
            [id],
            |r| r.get(0),
        )
        .optional()?;
    found.map(|_| ()).ok_or_else(|| gone(kind.noun()))
}

pub fn save_site(conn: &Connection, input: &Site) -> Result<Site, CoreError> {
    let v = Site {
        id: input.id,
        name: validate::name(&input.name, "site name", 100)?,
        notes: validate::text(&input.notes, "notes", 10_000)?,
    };
    let now = audit::now();
    let tx = conn.unchecked_transaction()?;
    let dup = || format!("A site named {} already exists.", v.name);
    let (old, id) = if v.id == 0 {
        tx.execute(
            "INSERT INTO sites (name, notes, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![v.name, v.notes, now],
        )
        .map_err(|e| unique(e, dup))?;
        (None, tx.last_insert_rowid())
    } else {
        let old = one(&tx, SITE_COLS, v.id, site_row)?.ok_or_else(|| gone("site"))?;
        tx.execute(
            "UPDATE sites SET name = ?2, notes = ?3, updated_at = ?4 WHERE id = ?1",
            params![v.id, v.name, v.notes, now],
        )
        .map_err(|e| unique(e, dup))?;
        (Some(old), v.id)
    };
    let saved = Site { id, ..v };
    record(&tx, "site", id, &saved.name, old.as_ref(), Some(&saved))?;
    tx.commit()?;
    Ok(saved)
}

pub fn save_building(conn: &Connection, input: &Building) -> Result<Building, CoreError> {
    let v = Building {
        id: input.id,
        site_id: input.site_id,
        name: validate::name(&input.name, "building name", 100)?,
        code: validate::text(&input.code, "building code", 20)?,
        address: validate::text(&input.address, "address", 300)?,
        notes: validate::text(&input.notes, "notes", 10_000)?,
    };
    let now = audit::now();
    let tx = conn.unchecked_transaction()?;
    exists(&tx, LocationKind::Site, v.site_id)?;
    let dup = || format!("A building named {} already exists.", v.name);
    let (old, id) = if v.id == 0 {
        tx.execute(
            "INSERT INTO buildings (site_id, name, code, address, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![v.site_id, v.name, v.code, v.address, v.notes, now],
        )
        .map_err(|e| unique(e, dup))?;
        (None, tx.last_insert_rowid())
    } else {
        let old = building(&tx, v.id)?.ok_or_else(|| gone("building"))?;
        tx.execute(
            "UPDATE buildings SET site_id = ?2, name = ?3, code = ?4, address = ?5, notes = ?6,
             updated_at = ?7 WHERE id = ?1",
            params![v.id, v.site_id, v.name, v.code, v.address, v.notes, now],
        )
        .map_err(|e| unique(e, dup))?;
        (Some(old), v.id)
    };
    let saved = Building { id, ..v };
    record(&tx, "building", id, &saved.name, old.as_ref(), Some(&saved))?;
    tx.commit()?;
    Ok(saved)
}

pub fn save_floor(conn: &Connection, input: &Floor) -> Result<Floor, CoreError> {
    let v = Floor {
        id: input.id,
        building_id: input.building_id,
        name: validate::name(&input.name, "floor name", 100)?,
        level: input.level.clamp(-20, 200),
        notes: validate::text(&input.notes, "notes", 10_000)?,
    };
    let now = audit::now();
    let tx = conn.unchecked_transaction()?;
    exists(&tx, LocationKind::Building, v.building_id)?;
    let dup = || format!("This building already has a floor named {}.", v.name);
    let (old, id) = if v.id == 0 {
        tx.execute(
            "INSERT INTO floors (building_id, name, level, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![v.building_id, v.name, v.level, v.notes, now],
        )
        .map_err(|e| unique(e, dup))?;
        (None, tx.last_insert_rowid())
    } else {
        let old = floor(&tx, v.id)?.ok_or_else(|| gone("floor"))?;
        tx.execute(
            "UPDATE floors SET building_id = ?2, name = ?3, level = ?4, notes = ?5,
             updated_at = ?6 WHERE id = ?1",
            params![v.id, v.building_id, v.name, v.level, v.notes, now],
        )
        .map_err(|e| unique(e, dup))?;
        if old.building_id != v.building_id {
            // Devices on this floor move with it.
            tx.execute(
                "UPDATE devices SET building_id = ?2 WHERE floor_id = ?1",
                params![v.id, v.building_id],
            )?;
        }
        (Some(old), v.id)
    };
    let saved = Floor { id, ..v };
    record(&tx, "floor", id, &saved.name, old.as_ref(), Some(&saved))?;
    tx.commit()?;
    Ok(saved)
}

pub fn save_room(conn: &Connection, input: &Room) -> Result<Room, CoreError> {
    let v = Room {
        id: input.id,
        floor_id: input.floor_id,
        name: validate::name(&input.name, "room name", 100)?,
        notes: validate::text(&input.notes, "notes", 10_000)?,
    };
    let now = audit::now();
    let tx = conn.unchecked_transaction()?;
    exists(&tx, LocationKind::Floor, v.floor_id)?;
    let dup = || format!("This floor already has a room named {}.", v.name);
    let (old, id) = if v.id == 0 {
        tx.execute(
            "INSERT INTO rooms (floor_id, name, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![v.floor_id, v.name, v.notes, now],
        )
        .map_err(|e| unique(e, dup))?;
        (None, tx.last_insert_rowid())
    } else {
        let old = room(&tx, v.id)?.ok_or_else(|| gone("room"))?;
        if old.floor_id != v.floor_id {
            return Err(CoreError::Validation(
                "A room cannot move to another floor; create it there instead.".into(),
            ));
        }
        tx.execute(
            "UPDATE rooms SET name = ?2, notes = ?3, updated_at = ?4 WHERE id = ?1",
            params![v.id, v.name, v.notes, now],
        )
        .map_err(|e| unique(e, dup))?;
        (Some(old), v.id)
    };
    let saved = Room { id, ..v };
    record(&tx, "room", id, &saved.name, old.as_ref(), Some(&saved))?;
    tx.commit()?;
    Ok(saved)
}

pub fn save_rack(conn: &Connection, input: &Rack) -> Result<Rack, CoreError> {
    if !(1..=60).contains(&input.height_u) {
        return Err(CoreError::Validation(
            "Rack height must be between 1 and 60 U.".into(),
        ));
    }
    let v = Rack {
        id: input.id,
        floor_id: input.floor_id,
        room_id: input.room_id,
        name: validate::name(&input.name, "rack name", 100)?,
        height_u: input.height_u,
        notes: validate::text(&input.notes, "notes", 10_000)?,
    };
    let now = audit::now();
    let tx = conn.unchecked_transaction()?;
    exists(&tx, LocationKind::Floor, v.floor_id)?;
    if let Some(room_id) = v.room_id {
        let r = room(&tx, room_id)?.ok_or_else(|| gone("room"))?;
        if r.floor_id != v.floor_id {
            return Err(CoreError::Validation(
                "That room is on a different floor.".into(),
            ));
        }
    }
    let dup = || format!("This floor already has a rack named {}.", v.name);
    let (old, id) = if v.id == 0 {
        tx.execute(
            "INSERT INTO racks (floor_id, room_id, name, height_u, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![v.floor_id, v.room_id, v.name, v.height_u, v.notes, now],
        )
        .map_err(|e| unique(e, dup))?;
        (None, tx.last_insert_rowid())
    } else {
        let old = rack(&tx, v.id)?.ok_or_else(|| gone("rack"))?;
        if old.floor_id != v.floor_id {
            return Err(CoreError::Validation(
                "A rack cannot move to another floor; move its devices instead.".into(),
            ));
        }
        let top: Option<i64> = tx.query_row(
            "SELECT max(rack_u + u_height - 1) FROM devices WHERE rack_id = ?1",
            [v.id],
            |r| r.get(0),
        )?;
        if top.is_some_and(|t| t > i64::from(v.height_u)) {
            return Err(CoreError::Validation(format!(
                "Devices in this rack reach U{}; the rack cannot be shorter.",
                top.unwrap_or_default()
            )));
        }
        tx.execute(
            "UPDATE racks SET room_id = ?2, name = ?3, height_u = ?4, notes = ?5, updated_at = ?6
             WHERE id = ?1",
            params![v.id, v.room_id, v.name, v.height_u, v.notes, now],
        )
        .map_err(|e| unique(e, dup))?;
        // Devices in the rack follow its room.
        tx.execute(
            "UPDATE devices SET room_id = ?2 WHERE rack_id = ?1",
            params![v.id, v.room_id],
        )?;
        (Some(old), v.id)
    };
    let saved = Rack { id, ..v };
    record(&tx, "rack", id, &saved.name, old.as_ref(), Some(&saved))?;
    tx.commit()?;
    Ok(saved)
}

/// Delete a location and everything below it. Devices there keep existing with the
/// location fields cleared.
pub fn delete(conn: &Connection, kind: LocationKind, id: i64) -> Result<(), CoreError> {
    if kind == LocationKind::Site {
        let count: i64 = conn.query_row("SELECT count(*) FROM sites", [], |r| r.get(0))?;
        if count <= 1 {
            return Err(CoreError::Validation(
                "The last site cannot be deleted.".into(),
            ));
        }
    }
    let tx = conn.unchecked_transaction()?;
    let (name, old): (String, serde_json::Value) = match kind {
        LocationKind::Site => {
            let s = one(&tx, SITE_COLS, id, site_row)?.ok_or_else(|| gone("site"))?;
            (s.name.clone(), serde_json::to_value(s)?)
        }
        LocationKind::Building => {
            let b = building(&tx, id)?.ok_or_else(|| gone("building"))?;
            (b.name.clone(), serde_json::to_value(b)?)
        }
        LocationKind::Floor => {
            let f = floor(&tx, id)?.ok_or_else(|| gone("floor"))?;
            (f.name.clone(), serde_json::to_value(f)?)
        }
        LocationKind::Room => {
            let r = room(&tx, id)?.ok_or_else(|| gone("room"))?;
            (r.name.clone(), serde_json::to_value(r)?)
        }
        LocationKind::Rack => {
            let r = rack(&tx, id)?.ok_or_else(|| gone("rack"))?;
            (r.name.clone(), serde_json::to_value(r)?)
        }
    };
    // Rack positions are meaningless without the rack.
    if kind == LocationKind::Rack {
        tx.execute("UPDATE devices SET rack_u = NULL WHERE rack_id = ?1", [id])?;
    }
    tx.execute(&format!("DELETE FROM {} WHERE id = ?1", kind.table()), [id])?;
    if kind == LocationKind::Building {
        crate::map::layout::forget_node(&tx, &format!("b:{id}"))?;
    }
    tx.execute(
        "UPDATE devices SET rack_u = NULL WHERE rack_id IS NULL AND rack_u IS NOT NULL",
        [],
    )?;
    record::<serde_json::Value>(&tx, kind.noun(), id, &name, Some(&old), None)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::testutil;
    use super::*;

    fn building(c: &Connection, name: &str) -> Building {
        save_building(
            c,
            &Building {
                id: 0,
                site_id: 1,
                name: name.into(),
                code: String::new(),
                address: String::new(),
                notes: String::new(),
            },
        )
        .expect("building")
    }

    fn floor(c: &Connection, b: i64, name: &str) -> Floor {
        save_floor(
            c,
            &Floor {
                id: 0,
                building_id: b,
                name: name.into(),
                level: 1,
                notes: String::new(),
            },
        )
        .expect("floor")
    }

    #[test]
    fn hierarchy_round_trip_and_audit() {
        let c = testutil::conn();
        let b = building(&c, "HQ");
        let f = floor(&c, b.id, "1st");
        let room = save_room(
            &c,
            &Room {
                id: 0,
                floor_id: f.id,
                name: "MDF".into(),
                notes: String::new(),
            },
        )
        .expect("room");
        let r = save_rack(
            &c,
            &Rack {
                id: 0,
                floor_id: f.id,
                room_id: Some(room.id),
                name: "R1".into(),
                height_u: 42,
                notes: String::new(),
            },
        )
        .expect("rack");
        assert_eq!(racks(&c).expect("racks"), std::slice::from_ref(&r));
        let renamed = save_building(
            &c,
            &Building {
                name: "Headquarters".into(),
                ..b.clone()
            },
        )
        .expect("rename");
        assert_eq!(renamed.id, b.id);
        let log = testutil::changes(&c);
        assert_eq!(log.len(), 5);
        assert_eq!(log[4]["action"], "updated");
        assert_eq!(log[4]["changes"][0]["field"], "name");
        assert_eq!(log[4]["changes"][0]["old"], "HQ");
    }

    #[test]
    fn duplicates_and_bad_parents_are_rejected() {
        let c = testutil::conn();
        let b = building(&c, "HQ");
        let err = save_building(&c, &Building { id: 0, ..b.clone() }).expect_err("dup");
        assert_eq!(err.to_string(), "A building named HQ already exists.");
        let f1 = floor(&c, b.id, "1");
        let f2 = floor(&c, b.id, "2");
        let room = save_room(
            &c,
            &Room {
                id: 0,
                floor_id: f1.id,
                name: "MDF".into(),
                notes: String::new(),
            },
        )
        .expect("room");
        assert!(save_rack(
            &c,
            &Rack {
                id: 0,
                floor_id: f2.id,
                room_id: Some(room.id),
                name: "R1".into(),
                height_u: 42,
                notes: String::new(),
            },
        )
        .is_err());
        assert!(save_floor(
            &c,
            &Floor {
                id: 0,
                building_id: 999,
                name: "x".into(),
                level: 0,
                notes: String::new(),
            }
        )
        .is_err());
    }

    #[test]
    fn deleting_cascades_and_the_last_site_stays() {
        let c = testutil::conn();
        let b = building(&c, "HQ");
        floor(&c, b.id, "1");
        delete(&c, LocationKind::Building, b.id).expect("delete");
        assert!(floors(&c).expect("floors").is_empty());
        assert!(delete(&c, LocationKind::Site, 1).is_err());
        let log = testutil::changes(&c);
        assert_eq!(log.last().expect("entry")["action"], "deleted");
    }
}
