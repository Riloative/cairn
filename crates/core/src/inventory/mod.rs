//! Inventory: locations, devices, interfaces, VLANs, credential profiles, custom fields
//! and saved table views, stored in the encrypted database.
//!
//! Every create/update/delete is audited with a field-level diff
//! ([`AuditEvent::InventoryChanged`]). Secrets of credential profiles never leave this
//! crate except through [`credentials::secrets`] (for connecting) and the audited
//! [`credentials::reveal`].

pub mod credentials;
pub mod devices;
pub mod fields;
pub mod ifrange;
pub mod interfaces;
pub mod locations;
pub mod validate;
pub mod views;
pub mod vlans;

use crate::audit::{self, AuditEvent, ChangeAction};
use crate::diff;
use crate::error::CoreError;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

pub use credentials::CredentialProfile;
pub use devices::{ConnectionMethod, Device, DeviceType};
pub use fields::{CustomField, FieldKind};
pub use interfaces::{Interface, InterfaceKind, InterfaceMode};
pub use locations::{Building, Floor, Rack, Room, Site};
pub use views::SavedView;
pub use vlans::Vlan;

/// Fields that change on every save or are derived; left out of audit diffs.
const VOLATILE: &[&str] = &["id", "createdAt", "updatedAt", "interfaceCount"];

fn audit_value<T: Serialize>(v: Option<&T>) -> Result<Value, CoreError> {
    let mut value = match v {
        Some(v) => serde_json::to_value(v)?,
        None => Value::Object(Default::default()),
    };
    if let Value::Object(map) = &mut value {
        for k in VOLATILE {
            map.remove(*k);
        }
    }
    Ok(value)
}

/// Audit a change to an entity. Updates without any field change are not recorded.
pub(crate) fn record<T: Serialize>(
    conn: &Connection,
    entity: &str,
    id: i64,
    name: &str,
    old: Option<&T>,
    new: Option<&T>,
) -> Result<(), CoreError> {
    let action = match (old, new) {
        (None, _) => ChangeAction::Created,
        (Some(_), Some(_)) => ChangeAction::Updated,
        (Some(_), None) => ChangeAction::Deleted,
    };
    let changes = diff::diff_values(&audit_value(old)?, &audit_value(new)?);
    if action == ChangeAction::Updated && changes.is_empty() {
        return Ok(());
    }
    audit::append(
        conn,
        &AuditEvent::InventoryChanged {
            entity: entity.to_owned(),
            entity_id: id,
            name: name.to_owned(),
            action,
            changes,
        },
    )?;
    Ok(())
}

/// Map a UNIQUE constraint failure to a friendly message; pass other errors through.
pub(crate) fn unique(e: rusqlite::Error, msg: impl FnOnce() -> String) -> CoreError {
    match &e {
        rusqlite::Error::SqliteFailure(f, _)
            if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            CoreError::Validation(msg())
        }
        _ => e.into(),
    }
}

pub(crate) fn gone(what: &str) -> CoreError {
    CoreError::Validation(format!(
        "That {what} no longer exists. Refresh and try again."
    ))
}

pub(crate) fn json_col<T: serde::de::DeserializeOwned>(
    r: &rusqlite::Row<'_>,
    idx: usize,
) -> rusqlite::Result<T> {
    let text: String = r.get(idx)?;
    serde_json::from_str(&text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
    })
}

/// Vendors offered by default; users can add more.
pub const BUILTIN_VENDORS: &[&str] = &[
    "Cisco", "Juniper", "Fortinet", "Aruba", "HP", "Ubiquiti", "MikroTik", "Dell", "Generic",
];

/// Built-in plus user-added vendor names, built-ins first.
pub fn vendors(conn: &Connection) -> Result<Vec<String>, CoreError> {
    let mut out: Vec<String> = BUILTIN_VENDORS.iter().map(|v| (*v).to_owned()).collect();
    let mut stmt = conn.prepare("SELECT name FROM vendors ORDER BY name COLLATE NOCASE")?;
    for name in stmt.query_map([], |r| r.get::<_, String>(0))? {
        out.push(name?);
    }
    Ok(out)
}

/// Add a user vendor (no-op if it exists, case-insensitively).
pub fn add_vendor(conn: &Connection, name: &str) -> Result<String, CoreError> {
    let name = validate::name(name, "vendor name", 64)?;
    if vendors(conn)?.iter().any(|v| v.eq_ignore_ascii_case(&name)) {
        return Ok(name);
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute("INSERT INTO vendors (name) VALUES (?1)", [&name])?;
    record(
        &tx,
        "vendor",
        0,
        &name,
        None,
        Some(&serde_json::json!({ "name": name })),
    )?;
    tx.commit()?;
    Ok(name)
}

/// Everything the inventory UI needs in one round trip (interfaces load per device).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub sites: Vec<Site>,
    pub buildings: Vec<Building>,
    pub floors: Vec<Floor>,
    pub rooms: Vec<Room>,
    pub racks: Vec<Rack>,
    pub vendors: Vec<String>,
    pub credentials: Vec<CredentialProfile>,
    pub vlans: Vec<Vlan>,
    pub fields: Vec<CustomField>,
    pub devices: Vec<Device>,
    pub views: Vec<SavedView>,
}

pub fn snapshot(conn: &Connection) -> Result<Snapshot, CoreError> {
    Ok(Snapshot {
        sites: locations::sites(conn)?,
        buildings: locations::buildings(conn)?,
        floors: locations::floors(conn)?,
        rooms: locations::rooms(conn)?,
        racks: locations::racks(conn)?,
        vendors: vendors(conn)?,
        credentials: credentials::list(conn)?,
        vlans: vlans::list(conn)?,
        fields: fields::list(conn)?,
        devices: devices::list(conn)?,
        views: views::list(conn)?,
    })
}

#[cfg(test)]
pub(crate) mod testutil {
    use crate::secret::Key256;
    use rusqlite::Connection;

    pub fn conn() -> Connection {
        crate::db::open_in_memory(&Key256::new([3; 32])).expect("db")
    }

    /// Audit entries of kind `inventory_changed`, oldest first, as JSON payloads.
    pub fn changes(conn: &Connection) -> Vec<serde_json::Value> {
        let mut out: Vec<_> = crate::audit::recent(conn, 1000)
            .expect("recent")
            .into_iter()
            .filter(|e| e.kind == "inventory_changed")
            .map(|e| e.payload)
            .collect();
        out.reverse();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendors_are_builtin_plus_user_added_once() {
        let c = testutil::conn();
        assert_eq!(vendors(&c).expect("v").len(), BUILTIN_VENDORS.len());
        add_vendor(&c, "Arista").expect("add");
        add_vendor(&c, "arista").expect("again");
        add_vendor(&c, "cisco").expect("builtin");
        let v = vendors(&c).expect("v");
        assert_eq!(v.len(), BUILTIN_VENDORS.len() + 1);
        assert_eq!(v.last().map(String::as_str), Some("Arista"));
        assert_eq!(testutil::changes(&c).len(), 1);
    }

    #[test]
    fn empty_snapshot_has_the_implicit_site() {
        let c = testutil::conn();
        let s = snapshot(&c).expect("snapshot");
        assert_eq!(s.sites.len(), 1);
        assert!(s.devices.is_empty());
    }
}
