//! Interface-to-interface links (cables) between devices.

use crate::audit;
use crate::error::CoreError;
use crate::inventory::{gone, record, validate};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkMedia {
    Copper,
    SmFiber,
    MmFiber,
    Dac,
    Wireless,
}

fn media_str(m: LinkMedia) -> &'static str {
    match m {
        LinkMedia::Copper => "copper",
        LinkMedia::SmFiber => "sm-fiber",
        LinkMedia::MmFiber => "mm-fiber",
        LinkMedia::Dac => "dac",
        LinkMedia::Wireless => "wireless",
    }
}

/// Per-link label overrides; `None` follows the global toggle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LabelOverrides {
    pub ports: Option<bool>,
    pub speed: Option<bool>,
    pub vlans: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    #[serde(default)]
    pub id: i64,
    pub a_interface_id: i64,
    pub b_interface_id: i64,
    /// Filled in when read (device and interface of each end).
    #[serde(default)]
    pub a_device_id: i64,
    #[serde(default)]
    pub b_device_id: i64,
    #[serde(default)]
    pub a_name: String,
    #[serde(default)]
    pub b_name: String,
    pub media: LinkMedia,
    #[serde(default)]
    pub speed: String,
    /// VLAN list like `10,20-30` (canonicalized on save).
    #[serde(default)]
    pub vlans: String,
    /// LAG / port-channel this link belongs to (links with the same value between the
    /// same devices are drawn as one bundle).
    #[serde(default)]
    pub lag: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub labels: LabelOverrides,
}

const COLS: &str = "SELECT l.id, l.a_interface_id, l.b_interface_id, ia.device_id, ib.device_id,
    ia.name, ib.name, l.media, l.speed, l.vlans, l.lag, l.description, l.labels
    FROM links l
    JOIN interfaces ia ON ia.id = l.a_interface_id
    JOIN interfaces ib ON ib.id = l.b_interface_id";

fn row(r: &Row<'_>) -> rusqlite::Result<Link> {
    let media: String = r.get(7)?;
    Ok(Link {
        id: r.get(0)?,
        a_interface_id: r.get(1)?,
        b_interface_id: r.get(2)?,
        a_device_id: r.get(3)?,
        b_device_id: r.get(4)?,
        a_name: r.get(5)?,
        b_name: r.get(6)?,
        media: serde_json::from_value(serde_json::Value::String(media))
            .unwrap_or(LinkMedia::Copper),
        speed: r.get(8)?,
        vlans: r.get(9)?,
        lag: r.get(10)?,
        description: r.get(11)?,
        labels: crate::inventory::json_col(r, 12)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Link>, CoreError> {
    let mut stmt = conn.prepare(&format!("{COLS} ORDER BY l.id"))?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Link>, CoreError> {
    Ok(conn
        .query_row(&format!("{COLS} WHERE l.id = ?1"), [id], row)
        .optional()?)
}

/// `(device id, device hostname, interface name)` of an interface.
fn endpoint(conn: &Connection, iface: i64) -> Result<(i64, String, String), CoreError> {
    conn.query_row(
        "SELECT d.id, d.hostname, i.name FROM interfaces i JOIN devices d ON d.id = i.device_id
         WHERE i.id = ?1",
        [iface],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()?
    .ok_or_else(|| gone("interface"))
}

/// The link already using an interface, other than `except`.
fn used_by(conn: &Connection, iface: i64, except: i64) -> Result<Option<i64>, CoreError> {
    Ok(conn
        .query_row(
            "SELECT id FROM links WHERE (a_interface_id = ?1 OR b_interface_id = ?1) AND id != ?2",
            params![iface, except],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn save(conn: &Connection, input: &Link) -> Result<Link, CoreError> {
    if input.a_interface_id == input.b_interface_id {
        return Err(CoreError::Validation(
            "Choose two different interfaces.".into(),
        ));
    }
    let vlans = validate::format_vlan_list(&validate::vlan_list(&input.vlans)?);
    let speed = validate::text(&input.speed, "speed", 20)?;
    let lag = validate::text(&input.lag, "LAG name", 64)?;
    let description = validate::text(&input.description, "description", 500)?;
    let labels = serde_json::to_string(&input.labels)?;
    let now = audit::now();
    let tx = conn.unchecked_transaction()?;
    let a = endpoint(&tx, input.a_interface_id)?;
    let b = endpoint(&tx, input.b_interface_id)?;
    if a.0 == b.0 {
        return Err(CoreError::Validation(
            "A link connects two different devices.".into(),
        ));
    }
    for (iface, (_, host, name)) in [(input.a_interface_id, &a), (input.b_interface_id, &b)] {
        if used_by(&tx, iface, input.id)?.is_some() {
            return Err(CoreError::Validation(format!(
                "{host} {name} is already connected. Remove that link first."
            )));
        }
    }
    let (old, id) = if input.id == 0 {
        tx.execute(
            "INSERT INTO links (a_interface_id, b_interface_id, media, speed, vlans, lag,
             description, labels, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                input.a_interface_id,
                input.b_interface_id,
                media_str(input.media),
                speed,
                vlans,
                lag,
                description,
                labels,
                now
            ],
        )?;
        (None, tx.last_insert_rowid())
    } else {
        let old = get(&tx, input.id)?.ok_or_else(|| gone("link"))?;
        tx.execute(
            "UPDATE links SET a_interface_id = ?2, b_interface_id = ?3, media = ?4, speed = ?5,
             vlans = ?6, lag = ?7, description = ?8, labels = ?9, updated_at = ?10 WHERE id = ?1",
            params![
                input.id,
                input.a_interface_id,
                input.b_interface_id,
                media_str(input.media),
                speed,
                vlans,
                lag,
                description,
                labels,
                now
            ],
        )?;
        (Some(old), input.id)
    };
    let saved = get(&tx, id)?.ok_or_else(|| gone("link"))?;
    let name = format!("{} {} ↔ {} {}", a.1, a.2, b.1, b.2);
    record(&tx, "link", id, &name, old.as_ref(), Some(&saved))?;
    tx.commit()?;
    Ok(saved)
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), CoreError> {
    let tx = conn.unchecked_transaction()?;
    let old = get(&tx, id)?.ok_or_else(|| gone("link"))?;
    let a = endpoint(&tx, old.a_interface_id)?;
    let b = endpoint(&tx, old.b_interface_id)?;
    tx.execute("DELETE FROM links WHERE id = ?1", [id])?;
    let name = format!("{} {} ↔ {} {}", a.1, a.2, b.1, b.2);
    record(&tx, "link", id, &name, Some(&old), None)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inventory::testutil;

    /// Two devices with three interfaces each; returns interface ids per device.
    pub(crate) fn setup(c: &Connection) -> (Vec<i64>, Vec<i64>) {
        let mut out = Vec::new();
        for host in ["sw1", "sw2"] {
            c.execute(
                "INSERT INTO devices (hostname, created_at, updated_at) VALUES (?1, 'x', 'x')",
                [host],
            )
            .expect("device");
            let d = c.last_insert_rowid();
            let mut ids = Vec::new();
            for n in 1..=3 {
                c.execute(
                    "INSERT INTO interfaces (device_id, name) VALUES (?1, ?2)",
                    params![d, format!("Gi1/0/{n}")],
                )
                .expect("iface");
                ids.push(c.last_insert_rowid());
            }
            out.push(ids);
        }
        let b = out.pop().unwrap_or_default();
        let a = out.pop().unwrap_or_default();
        (a, b)
    }

    fn link(a: i64, b: i64) -> Link {
        Link {
            id: 0,
            a_interface_id: a,
            b_interface_id: b,
            a_device_id: 0,
            b_device_id: 0,
            a_name: String::new(),
            b_name: String::new(),
            media: LinkMedia::SmFiber,
            speed: "10G".into(),
            vlans: "20, 10-11".into(),
            lag: "Po1".into(),
            description: "uplink".into(),
            labels: LabelOverrides::default(),
        }
    }

    #[test]
    fn links_save_with_endpoint_names_and_audit() {
        let c = testutil::conn();
        let (a, b) = setup(&c);
        let l = save(&c, &link(a[0], b[0])).expect("save");
        assert_eq!(
            (l.a_name.as_str(), l.b_name.as_str()),
            ("Gi1/0/1", "Gi1/0/1")
        );
        assert_ne!(l.a_device_id, l.b_device_id);
        assert_eq!(l.vlans, "10-11,20");
        let log = testutil::changes(&c);
        assert_eq!(log[0]["entity"], "link");
        assert_eq!(log[0]["name"], "sw1 Gi1/0/1 ↔ sw2 Gi1/0/1");
        let mut changed = l.clone();
        changed.labels.speed = Some(true);
        save(&c, &changed).expect("update");
        assert_eq!(list(&c).expect("list")[0].labels.speed, Some(true));
    }

    #[test]
    fn an_interface_has_one_link_and_links_join_two_devices() {
        let c = testutil::conn();
        let (a, b) = setup(&c);
        save(&c, &link(a[0], b[0])).expect("first");
        assert_eq!(
            save(&c, &link(b[0], a[1])).expect_err("busy").to_string(),
            "sw2 Gi1/0/1 is already connected. Remove that link first."
        );
        assert!(save(&c, &link(a[1], a[2])).is_err(), "same device");
        assert!(save(&c, &link(a[1], a[1])).is_err(), "same interface");
        let mut bad = link(a[1], b[1]);
        bad.vlans = "9999".into();
        assert!(save(&c, &bad).is_err());
    }

    #[test]
    fn deleting_an_interface_removes_its_link() {
        let c = testutil::conn();
        let (a, b) = setup(&c);
        let l = save(&c, &link(a[0], b[0])).expect("save");
        c.execute("DELETE FROM interfaces WHERE id = ?1", [a[0]])
            .expect("delete iface");
        assert!(get(&c, l.id).expect("get").is_none());
        let l2 = save(&c, &link(a[1], b[1])).expect("save");
        delete(&c, l2.id).expect("delete");
        assert!(list(&c).expect("list").is_empty());
    }
}
