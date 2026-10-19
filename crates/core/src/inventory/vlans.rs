//! VLAN registry. The color is reused on the map.

use super::{gone, record, unique, validate};
use crate::audit;
use crate::error::CoreError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vlan {
    #[serde(default)]
    pub id: i64,
    pub vid: u16,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub subnet: String,
    #[serde(default)]
    pub gateway: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub color: String,
}

const COLS: &str = "SELECT id, vid, name, subnet, gateway, description, color FROM vlans";

fn row(r: &Row<'_>) -> rusqlite::Result<Vlan> {
    Ok(Vlan {
        id: r.get(0)?,
        vid: r.get(1)?,
        name: r.get(2)?,
        subnet: r.get(3)?,
        gateway: r.get(4)?,
        description: r.get(5)?,
        color: r.get(6)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Vlan>, CoreError> {
    let mut stmt = conn.prepare(&format!("{COLS} ORDER BY vid"))?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn get(conn: &Connection, id: i64) -> Result<Option<Vlan>, CoreError> {
    Ok(conn
        .query_row(&format!("{COLS} WHERE id = ?1"), [id], row)
        .optional()?)
}

fn clean(v: &Vlan) -> Result<Vlan, CoreError> {
    let subnet = validate::subnet_or_empty(&v.subnet)?;
    let gateway = validate::ip_or_empty(&v.gateway, "gateway address")?;
    if !subnet.is_empty() && !gateway.is_empty() && !validate::subnet_contains(&subnet, &gateway) {
        return Err(CoreError::Validation(format!(
            "The gateway {gateway} is not inside {subnet}."
        )));
    }
    Ok(Vlan {
        id: v.id,
        vid: validate::vlan_id(v.vid)?,
        name: validate::text(&v.name, "VLAN name", 64)?,
        subnet,
        gateway,
        description: validate::text(&v.description, "description", 1000)?,
        color: validate::color_or_empty(&v.color)?,
    })
}

pub fn save(conn: &Connection, input: &Vlan) -> Result<Vlan, CoreError> {
    let v = clean(input)?;
    let now = audit::now();
    let tx = conn.unchecked_transaction()?;
    let dup = || format!("VLAN {} already exists.", v.vid);
    let (old, id) = if v.id == 0 {
        tx.execute(
            "INSERT INTO vlans (vid, name, subnet, gateway, description, color, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![v.vid, v.name, v.subnet, v.gateway, v.description, v.color, now],
        )
        .map_err(|e| unique(e, dup))?;
        (None, tx.last_insert_rowid())
    } else {
        let old = get(&tx, v.id)?.ok_or_else(|| gone("VLAN"))?;
        tx.execute(
            "UPDATE vlans SET vid = ?2, name = ?3, subnet = ?4, gateway = ?5, description = ?6,
             color = ?7, updated_at = ?8 WHERE id = ?1",
            params![
                v.id,
                v.vid,
                v.name,
                v.subnet,
                v.gateway,
                v.description,
                v.color,
                now
            ],
        )
        .map_err(|e| unique(e, dup))?;
        (Some(old), v.id)
    };
    let saved = Vlan { id, ..v };
    record(&tx, "vlan", id, &label(&saved), old.as_ref(), Some(&saved))?;
    tx.commit()?;
    Ok(saved)
}

fn label(v: &Vlan) -> String {
    if v.name.is_empty() {
        format!("VLAN {}", v.vid)
    } else {
        format!("VLAN {} ({})", v.vid, v.name)
    }
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), CoreError> {
    let tx = conn.unchecked_transaction()?;
    let old = get(&tx, id)?.ok_or_else(|| gone("VLAN"))?;
    tx.execute("DELETE FROM vlans WHERE id = ?1", [id])?;
    record(&tx, "vlan", id, &label(&old), Some(&old), None)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::testutil;
    use super::*;

    fn vlan(vid: u16) -> Vlan {
        Vlan {
            id: 0,
            vid,
            name: "users".into(),
            subnet: "10.1.20.0/24".into(),
            gateway: "10.1.20.1".into(),
            description: String::new(),
            color: "#3B82F6".into(),
        }
    }

    #[test]
    fn save_validate_and_delete() {
        let c = testutil::conn();
        let v = save(&c, &vlan(20)).expect("save");
        assert_eq!(v.color, "#3b82f6");
        assert_eq!(
            save(&c, &vlan(20)).expect_err("dup").to_string(),
            "VLAN 20 already exists."
        );
        let mut bad = vlan(30);
        bad.gateway = "10.9.9.1".into();
        assert!(save(&c, &bad).is_err());
        let mut renamed = v.clone();
        renamed.name = "staff".into();
        save(&c, &renamed).expect("update");
        delete(&c, v.id).expect("delete");
        assert!(list(&c).expect("list").is_empty());
        let log = testutil::changes(&c);
        assert_eq!(log.len(), 3);
        assert_eq!(log[1]["changes"][0]["field"], "name");
        assert_eq!(log[2]["name"], "VLAN 20 (staff)");
    }
}
