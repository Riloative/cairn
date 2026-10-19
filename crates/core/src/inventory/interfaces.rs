//! Device interfaces, including bulk creation from name patterns.

use super::{gone, ifrange, record, unique, validate};
use crate::error::CoreError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InterfaceKind {
    Copper,
    Sfp,
    SfpPlus,
    Qsfp,
    Fiber,
    Wireless,
    Virtual,
    Lag,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InterfaceMode {
    Access,
    Trunk,
    Routed,
}

fn kind_str(k: InterfaceKind) -> &'static str {
    match k {
        InterfaceKind::Copper => "copper",
        InterfaceKind::Sfp => "sfp",
        InterfaceKind::SfpPlus => "sfp-plus",
        InterfaceKind::Qsfp => "qsfp",
        InterfaceKind::Fiber => "fiber",
        InterfaceKind::Wireless => "wireless",
        InterfaceKind::Virtual => "virtual",
        InterfaceKind::Lag => "lag",
    }
}

fn mode_str(m: InterfaceMode) -> &'static str {
    match m {
        InterfaceMode::Access => "access",
        InterfaceMode::Trunk => "trunk",
        InterfaceMode::Routed => "routed",
    }
}

fn parse<T: serde::de::DeserializeOwned>(s: String) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(s)).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interface {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub device_id: i64,
    pub name: String,
    pub kind: InterfaceKind,
    /// Free text such as `1G`, `10G`, `100M`.
    #[serde(default)]
    pub speed: String,
    pub mode: InterfaceMode,
    #[serde(default)]
    pub access_vlan: Option<u16>,
    #[serde(default)]
    pub native_vlan: Option<u16>,
    /// Trunk VLANs as a list like `10,20-30` (canonicalized on save).
    #[serde(default)]
    pub allowed_vlans: String,
    /// Name of the LAG interface this one is a member of (e.g. `Po1`).
    #[serde(default)]
    pub lag: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub position: i64,
}

fn yes() -> bool {
    true
}

const COLS: &str = "SELECT id, device_id, name, kind, speed, mode, access_vlan, native_vlan,
    allowed_vlans, lag, description, enabled, position FROM interfaces";

fn row(r: &Row<'_>) -> rusqlite::Result<Interface> {
    Ok(Interface {
        id: r.get(0)?,
        device_id: r.get(1)?,
        name: r.get(2)?,
        kind: parse(r.get(3)?)?,
        speed: r.get(4)?,
        mode: parse(r.get(5)?)?,
        access_vlan: r.get(6)?,
        native_vlan: r.get(7)?,
        allowed_vlans: r.get(8)?,
        lag: r.get(9)?,
        description: r.get(10)?,
        enabled: r.get(11)?,
        position: r.get(12)?,
    })
}

pub fn list(conn: &Connection, device_id: i64) -> Result<Vec<Interface>, CoreError> {
    let mut stmt = conn.prepare(&format!(
        "{COLS} WHERE device_id = ?1 ORDER BY position, id"
    ))?;
    let rows = stmt.query_map([device_id], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn get(conn: &Connection, id: i64) -> Result<Option<Interface>, CoreError> {
    Ok(conn
        .query_row(&format!("{COLS} WHERE id = ?1"), [id], row)
        .optional()?)
}

fn clean(i: &Interface) -> Result<Interface, CoreError> {
    let name = validate::name(&i.name, "interface name", 64)?;
    if name.chars().any(char::is_whitespace) {
        return Err(CoreError::Validation(
            "Interface names cannot contain spaces.".into(),
        ));
    }
    let opt_vlan = |v: Option<u16>| v.map(validate::vlan_id).transpose();
    let (access_vlan, native_vlan, allowed) = match i.mode {
        InterfaceMode::Access => (opt_vlan(i.access_vlan)?, None, String::new()),
        InterfaceMode::Trunk => (
            None,
            opt_vlan(i.native_vlan)?,
            validate::format_vlan_list(&validate::vlan_list(&i.allowed_vlans)?),
        ),
        InterfaceMode::Routed => (None, None, String::new()),
    };
    let lag = validate::text(&i.lag, "LAG name", 64)?;
    if !lag.is_empty() && lag == name {
        return Err(CoreError::Validation(
            "An interface cannot be a member of itself.".into(),
        ));
    }
    Ok(Interface {
        id: i.id,
        device_id: i.device_id,
        name,
        kind: i.kind,
        speed: validate::text(&i.speed, "speed", 20)?,
        mode: i.mode,
        access_vlan,
        native_vlan,
        allowed_vlans: allowed,
        lag,
        description: validate::text(&i.description, "description", 500)?,
        enabled: i.enabled,
        position: i.position,
    })
}

pub(crate) fn device_name(conn: &Connection, device_id: i64) -> Result<String, CoreError> {
    conn.query_row(
        "SELECT hostname FROM devices WHERE id = ?1",
        [device_id],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| gone("device"))
}

fn insert(conn: &Connection, v: &Interface) -> Result<i64, CoreError> {
    conn.execute(
        "INSERT INTO interfaces (device_id, name, kind, speed, mode, access_vlan, native_vlan,
         allowed_vlans, lag, description, enabled, position)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            v.device_id,
            v.name,
            kind_str(v.kind),
            v.speed,
            mode_str(v.mode),
            v.access_vlan,
            v.native_vlan,
            v.allowed_vlans,
            v.lag,
            v.description,
            v.enabled,
            v.position
        ],
    )
    .map_err(|e| unique(e, || format!("{} already exists on this device.", v.name)))?;
    Ok(conn.last_insert_rowid())
}

fn next_position(conn: &Connection, device_id: i64) -> Result<i64, CoreError> {
    Ok(conn.query_row(
        "SELECT coalesce(max(position), -1) + 1 FROM interfaces WHERE device_id = ?1",
        [device_id],
        |r| r.get(0),
    )?)
}

pub fn save(conn: &Connection, input: &Interface) -> Result<Interface, CoreError> {
    let mut v = clean(input)?;
    let tx = conn.unchecked_transaction()?;
    let device = device_name(&tx, v.device_id)?;
    let (old, id) = if v.id == 0 {
        v.position = next_position(&tx, v.device_id)?;
        (None, insert(&tx, &v)?)
    } else {
        let old = get(&tx, v.id)?.ok_or_else(|| gone("interface"))?;
        if old.device_id != v.device_id {
            return Err(CoreError::Validation(
                "An interface cannot move to another device.".into(),
            ));
        }
        tx.execute(
            "UPDATE interfaces SET name = ?2, kind = ?3, speed = ?4, mode = ?5, access_vlan = ?6,
             native_vlan = ?7, allowed_vlans = ?8, lag = ?9, description = ?10, enabled = ?11,
             position = ?12 WHERE id = ?1",
            params![
                v.id,
                v.name,
                kind_str(v.kind),
                v.speed,
                mode_str(v.mode),
                v.access_vlan,
                v.native_vlan,
                v.allowed_vlans,
                v.lag,
                v.description,
                v.enabled,
                v.position
            ],
        )
        .map_err(|e| unique(e, || format!("{} already exists on this device.", v.name)))?;
        (Some(old), v.id)
    };
    let saved = Interface { id, ..v };
    let label = format!("{device} {}", saved.name);
    record(&tx, "interface", id, &label, old.as_ref(), Some(&saved))?;
    tx.commit()?;
    Ok(saved)
}

/// Result of a bulk create.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkResult {
    pub created: Vec<Interface>,
    /// Names that already existed and were left alone.
    pub skipped: Vec<String>,
}

/// Create interfaces named by `pattern` (see [`ifrange::expand`]) using `template` for
/// every other field. Existing names are skipped. One audit entry for the batch.
pub fn bulk_create(
    conn: &Connection,
    device_id: i64,
    pattern: &str,
    template: &Interface,
) -> Result<BulkResult, CoreError> {
    let names = ifrange::expand(pattern)?;
    let tx = conn.unchecked_transaction()?;
    let device = device_name(&tx, device_id)?;
    let existing: Vec<String> = list(&tx, device_id)?.into_iter().map(|i| i.name).collect();
    let mut position = next_position(&tx, device_id)?;
    let mut result = BulkResult {
        created: Vec::new(),
        skipped: Vec::new(),
    };
    for name in names {
        if existing.contains(&name) {
            result.skipped.push(name);
            continue;
        }
        let v = clean(&Interface {
            id: 0,
            device_id,
            name,
            position,
            ..template.clone()
        })?;
        let id = insert(&tx, &v)?;
        position += 1;
        result.created.push(Interface { id, ..v });
    }
    if !result.created.is_empty() {
        let names: Vec<&str> = result.created.iter().map(|i| i.name.as_str()).collect();
        record(
            &tx,
            "interfaces",
            device_id,
            &format!("{device}: {} interfaces", names.len()),
            None,
            Some(&json!({ "names": names })),
        )?;
    }
    tx.commit()?;
    Ok(result)
}

/// Delete interfaces (one audit entry per batch).
pub fn delete(conn: &Connection, device_id: i64, ids: &[i64]) -> Result<usize, CoreError> {
    let tx = conn.unchecked_transaction()?;
    let device = device_name(&tx, device_id)?;
    let mut names = Vec::new();
    for id in ids {
        if let Some(i) = get(&tx, *id)?.filter(|i| i.device_id == device_id) {
            tx.execute("DELETE FROM interfaces WHERE id = ?1", [id])?;
            names.push(i.name);
        }
    }
    if !names.is_empty() {
        record(
            &tx,
            "interfaces",
            device_id,
            &format!("{device}: {} interfaces", names.len()),
            Some(&json!({ "names": names })),
            None,
        )?;
    }
    tx.commit()?;
    Ok(names.len())
}

/// Interface counts per device (for the inventory table).
pub fn counts(conn: &Connection) -> Result<std::collections::HashMap<i64, u32>, CoreError> {
    let mut stmt = conn.prepare("SELECT device_id, count(*) FROM interfaces GROUP BY device_id")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::super::testutil;
    use super::*;

    pub(crate) fn template() -> Interface {
        Interface {
            id: 0,
            device_id: 0,
            name: String::new(),
            kind: InterfaceKind::Copper,
            speed: "1G".into(),
            mode: InterfaceMode::Access,
            access_vlan: Some(20),
            native_vlan: Some(1),
            allowed_vlans: "1-5".into(),
            lag: String::new(),
            description: String::new(),
            enabled: true,
            position: 0,
        }
    }

    fn device(c: &Connection) -> i64 {
        c.execute(
            "INSERT INTO devices (hostname, created_at, updated_at) VALUES ('sw1', 'x', 'x')",
            [],
        )
        .expect("device");
        c.last_insert_rowid()
    }

    #[test]
    fn bulk_create_skips_existing_and_audits_once() {
        let c = testutil::conn();
        let d = device(&c);
        let first = bulk_create(&c, d, "Gi1/0/1-4", &template()).expect("bulk");
        assert_eq!(first.created.len(), 4);
        // Access ports drop trunk-only settings.
        assert_eq!(first.created[0].native_vlan, None);
        assert_eq!(first.created[0].allowed_vlans, "");
        let again = bulk_create(&c, d, "Gi1/0/3-6", &template()).expect("again");
        assert_eq!(again.skipped, ["Gi1/0/3", "Gi1/0/4"]);
        let all = list(&c, d).expect("list");
        assert_eq!(all.len(), 6);
        assert_eq!(all[5].name, "Gi1/0/6");
        assert_eq!(all[5].position, 5);
        assert_eq!(testutil::changes(&c).len(), 2);
        assert_eq!(counts(&c).expect("counts")[&d], 6);
    }

    #[test]
    fn trunks_canonicalize_and_names_are_unique() {
        let c = testutil::conn();
        let d = device(&c);
        let mut t = template();
        t.device_id = d;
        t.name = "Te1/1/1".into();
        t.mode = InterfaceMode::Trunk;
        t.allowed_vlans = "30, 10-12,11".into();
        let saved = save(&c, &t).expect("save");
        assert_eq!(saved.allowed_vlans, "10-12,30");
        assert_eq!(saved.access_vlan, None);
        assert_eq!(
            save(&c, &t).expect_err("dup").to_string(),
            "Te1/1/1 already exists on this device."
        );
        let mut bad = t.clone();
        bad.name = "Te1/1/2".into();
        bad.allowed_vlans = "5000".into();
        assert!(save(&c, &bad).is_err());
        assert_eq!(delete(&c, d, &[saved.id]).expect("delete"), 1);
        assert!(list(&c, d).expect("list").is_empty());
    }
}
