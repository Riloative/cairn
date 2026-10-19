//! Network map data: interface-to-interface links, node positions and zones per view,
//! floor-plan backgrounds and map display preferences.
//!
//! The map is static (no live status). Node data is keyed by device id, so a status
//! overlay can be added later without changing this model (see D-030).

pub mod floorplan;
pub mod layout;
pub mod links;

use crate::error::CoreError;
use crate::settings;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub use floorplan::FloorPlanInfo;
pub use layout::{Position, Zone};
pub use links::{Link, LinkMedia};

/// A map view: the campus of a site, a building, or a floor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Campus(i64),
    Building(i64),
    Floor(i64),
}

impl View {
    /// Parse `campus:1`, `building:3`, `floor:5`.
    pub fn parse(key: &str) -> Result<Self, CoreError> {
        let bad = || CoreError::Validation(format!("Unknown map view {key}."));
        let (kind, id) = key.split_once(':').ok_or_else(bad)?;
        let id: i64 = id.parse().map_err(|_| bad())?;
        if id <= 0 {
            return Err(bad());
        }
        match kind {
            "campus" => Ok(View::Campus(id)),
            "building" => Ok(View::Building(id)),
            "floor" => Ok(View::Floor(id)),
            _ => Err(bad()),
        }
    }

    pub fn key(self) -> String {
        match self {
            View::Campus(id) => format!("campus:{id}"),
            View::Building(id) => format!("building:{id}"),
            View::Floor(id) => format!("floor:{id}"),
        }
    }
}

/// What a link is colored by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ColorBy {
    #[default]
    Media,
    Speed,
    Vlan,
}

/// Which link labels are shown (per link these can be overridden).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LabelToggles {
    pub ports: bool,
    pub speed: bool,
    pub vlans: bool,
}

impl Default for LabelToggles {
    fn default() -> Self {
        Self {
            ports: true,
            speed: false,
            vlans: false,
        }
    }
}

/// Map display preferences (stored as a settings document, changes audited).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MapPrefs {
    pub labels: LabelToggles,
    pub color_by: ColorBy,
    pub snap_to_grid: bool,
    pub grid_size: u16,
    pub show_minimap: bool,
}

impl Default for MapPrefs {
    fn default() -> Self {
        Self {
            labels: LabelToggles::default(),
            color_by: ColorBy::Media,
            snap_to_grid: true,
            grid_size: 16,
            show_minimap: true,
        }
    }
}

const PREFS_KEY: &str = "map_prefs";

pub fn prefs(conn: &Connection) -> Result<MapPrefs, CoreError> {
    settings::load_doc(conn, PREFS_KEY)
}

pub fn save_prefs(conn: &Connection, prefs: &MapPrefs) -> Result<MapPrefs, CoreError> {
    if !(4..=128).contains(&prefs.grid_size) {
        return Err(CoreError::Validation(
            "The grid size must be 4–128 px.".into(),
        ));
    }
    settings::save_doc(conn, PREFS_KEY, Some("map"), prefs)
}

/// Everything the map needs besides the inventory snapshot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapSnapshot {
    pub links: Vec<Link>,
    pub positions: Vec<Position>,
    pub zones: Vec<Zone>,
    pub floor_plans: Vec<FloorPlanInfo>,
    pub prefs: MapPrefs,
}

pub fn snapshot(conn: &Connection) -> Result<MapSnapshot, CoreError> {
    Ok(MapSnapshot {
        links: links::list(conn)?,
        positions: layout::positions(conn)?,
        zones: layout::zones(conn)?,
        floor_plans: floorplan::list(conn)?,
        prefs: prefs(conn)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_keys_round_trip() {
        assert_eq!(View::parse("floor:5").expect("floor"), View::Floor(5));
        assert_eq!(View::Campus(1).key(), "campus:1");
        for bad in ["", "floor", "floor:x", "floor:0", "rack:1", "floor:-2"] {
            assert!(View::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn prefs_default_and_validate() {
        let c = crate::inventory::testutil::conn();
        assert_eq!(prefs(&c).expect("prefs"), MapPrefs::default());
        let mut p = MapPrefs::default();
        p.labels.vlans = true;
        p.color_by = ColorBy::Vlan;
        assert_eq!(save_prefs(&c, &p).expect("save"), p);
        assert_eq!(prefs(&c).expect("prefs"), p);
        p.grid_size = 1;
        assert!(save_prefs(&c, &p).is_err());
    }
}
