//! Devices: identity, location, connection methods, tags, notes and custom fields.

use super::{credentials, fields, gone, interfaces, locations, record, validate, vendors};
use crate::audit;
use crate::error::CoreError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceType {
    Switch,
    Router,
    Firewall,
    Server,
    AccessPoint,
    WirelessController,
    Storage,
    Hypervisor,
    Pdu,
    Ups,
    PatchPanel,
    Camera,
    IpPhone,
    Generic,
}

/// How to reach a device. The first method is the default (double-click on the map).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ConnectionMethod {
    #[serde(rename_all = "camelCase")]
    Ssh {
        #[serde(default = "port_22")]
        port: u16,
        /// Overrides the credential profile's username.
        #[serde(default)]
        username: String,
        /// Legacy algorithm ids (see `cairn_proto_ssh::LegacyAlgorithm`).
        #[serde(default)]
        legacy: Vec<String>,
        /// ProxyJump chain, e.g. `ops@bastion:22, core-jump`.
        #[serde(default)]
        jumps: String,
        #[serde(default)]
        agent_forwarding: bool,
    },
    #[serde(rename_all = "camelCase")]
    Telnet {
        #[serde(default = "port_23")]
        port: u16,
        #[serde(default)]
        raw: bool,
    },
    /// A local serial port. `settings`/`newline` mirror `cairn_proto_serial` types and are
    /// validated where the session is opened.
    #[serde(rename_all = "camelCase")]
    Serial {
        path: String,
        #[serde(default)]
        settings: Value,
        #[serde(default)]
        newline: Value,
        #[serde(default)]
        local_echo: bool,
    },
    /// Reverse Telnet through a console server.
    #[serde(rename_all = "camelCase")]
    ConsoleServer {
        host: String,
        /// `opengear`, `cisco-line`, `avocent`, `lantronix`, `digi` or `custom`.
        server: String,
        port: u16,
        #[serde(default)]
        raw: bool,
    },
    #[serde(rename_all = "camelCase")]
    Rdp {
        #[serde(default = "port_3389")]
        port: u16,
        #[serde(default)]
        username: String,
        #[serde(default)]
        domain: String,
        /// `nla` (CredSSP, falling back to TLS when the server lacks it) or `tls`.
        #[serde(default = "rdp_nla")]
        security: String,
        /// Fixed desktop size; 0×0 follows the window.
        #[serde(default)]
        width: u16,
        #[serde(default)]
        height: u16,
        /// 16 or 32 bits per pixel.
        #[serde(default = "depth_32")]
        color_depth: u8,
        #[serde(default = "yes")]
        clipboard: bool,
        /// SSH jump host (`user@host:port`) to tunnel through; empty connects directly.
        #[serde(default)]
        tunnel: String,
        /// Open in FreeRDP (Linux) or the system RDP app (macOS) instead of a tab.
        #[serde(default)]
        external: bool,
    },
    #[serde(rename_all = "camelCase")]
    Web { url: String },
}

fn port_22() -> u16 {
    22
}
fn port_23() -> u16 {
    23
}
fn port_3389() -> u16 {
    3389
}
fn rdp_nla() -> String {
    "nla".into()
}
fn depth_32() -> u8 {
    32
}
fn yes() -> bool {
    true
}

const CONSOLE_SERVERS: &[&str] = &[
    "opengear",
    "cisco-line",
    "avocent",
    "lantronix",
    "digi",
    "custom",
];

impl ConnectionMethod {
    fn clean(&self) -> Result<Self, CoreError> {
        Ok(match self {
            ConnectionMethod::Ssh {
                port,
                username,
                legacy,
                jumps,
                agent_forwarding,
            } => ConnectionMethod::Ssh {
                port: validate::port(*port, "SSH")?,
                username: validate::text(username, "username", 255)?,
                legacy: {
                    let mut l: Vec<String> = legacy.iter().map(|s| s.trim().to_owned()).collect();
                    l.sort();
                    l.dedup();
                    if l.len() > 16 || l.iter().any(|s| s.is_empty() || s.len() > 40) {
                        return Err(CoreError::Validation(
                            "Invalid legacy algorithm list.".into(),
                        ));
                    }
                    l
                },
                jumps: validate::text(jumps, "jump hosts", 1000)?,
                agent_forwarding: *agent_forwarding,
            },
            ConnectionMethod::Telnet { port, raw } => ConnectionMethod::Telnet {
                port: validate::port(*port, "Telnet")?,
                raw: *raw,
            },
            ConnectionMethod::Serial {
                path,
                settings,
                newline,
                local_echo,
            } => {
                if !(settings.is_object() || settings.is_null())
                    || !(newline.is_object() || newline.is_null())
                {
                    return Err(CoreError::Validation("Invalid serial settings.".into()));
                }
                ConnectionMethod::Serial {
                    path: validate::name(path, "serial port", 512)?,
                    settings: settings.clone(),
                    newline: newline.clone(),
                    local_echo: *local_echo,
                }
            }
            ConnectionMethod::ConsoleServer {
                host,
                server,
                port,
                raw,
            } => {
                if !CONSOLE_SERVERS.contains(&server.as_str()) {
                    return Err(CoreError::Validation("Unknown console server type.".into()));
                }
                let host = validate::name(host, "console server address", 253)?;
                if host.chars().any(char::is_whitespace) {
                    return Err(CoreError::Validation(
                        "The console server address cannot contain spaces.".into(),
                    ));
                }
                ConnectionMethod::ConsoleServer {
                    host,
                    server: server.clone(),
                    port: validate::port(*port, "console")?,
                    raw: *raw,
                }
            }
            ConnectionMethod::Rdp {
                port,
                username,
                domain,
                security,
                width,
                height,
                color_depth,
                clipboard,
                tunnel,
                external,
            } => {
                if !matches!(security.as_str(), "nla" | "tls") {
                    return Err(CoreError::Validation(
                        "RDP security must be NLA or TLS.".into(),
                    ));
                }
                let side = |v: u16| (200..=8192).contains(&v);
                if !((*width == 0 && *height == 0) || (side(*width) && side(*height))) {
                    return Err(CoreError::Validation(
                        "RDP resolution must be 200–8192 pixels per side, or fit the window."
                            .into(),
                    ));
                }
                if !matches!(color_depth, 16 | 32) {
                    return Err(CoreError::Validation(
                        "RDP color depth must be 16 or 32 bits.".into(),
                    ));
                }
                ConnectionMethod::Rdp {
                    port: validate::port(*port, "RDP")?,
                    username: validate::text(username, "username", 255)?,
                    domain: validate::text(domain, "domain", 255)?,
                    security: security.clone(),
                    width: *width,
                    height: *height,
                    color_depth: *color_depth,
                    clipboard: *clipboard,
                    tunnel: validate::text(tunnel, "SSH tunnel", 255)?,
                    external: *external,
                }
            }
            ConnectionMethod::Web { url } => ConnectionMethod::Web {
                url: validate::web_url(url)?,
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    #[serde(default)]
    pub id: i64,
    pub hostname: String,
    #[serde(default)]
    pub mgmt_ip: String,
    pub device_type: DeviceType,
    pub vendor: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub serial: String,
    #[serde(default)]
    pub firmware: String,
    /// Asset number (inventory tag), free text.
    #[serde(default)]
    pub asset_number: String,
    #[serde(default)]
    pub building_id: Option<i64>,
    #[serde(default)]
    pub floor_id: Option<i64>,
    #[serde(default)]
    pub room_id: Option<i64>,
    #[serde(default)]
    pub rack_id: Option<i64>,
    /// Lowest U the device occupies (1 = bottom).
    #[serde(default)]
    pub rack_u: Option<u16>,
    #[serde(default = "one_u")]
    pub u_height: u16,
    #[serde(default)]
    pub credential_id: Option<i64>,
    #[serde(default)]
    pub connections: Vec<ConnectionMethod>,
    #[serde(default)]
    pub vlans: Vec<u16>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Markdown, rendered as text-only Markdown in the UI.
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub custom: BTreeMap<String, Value>,
    /// Record terminal sessions to this device (also on when recording is on globally).
    #[serde(default)]
    pub record_sessions: bool,
    #[serde(default)]
    pub interface_count: u32,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn one_u() -> u16 {
    1
}

/// A saved device plus non-blocking warnings (duplicate IP or hostname).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub device: Device,
    pub warnings: Vec<String>,
}

const COLS: &str = "SELECT id, hostname, mgmt_ip, device_type, vendor, model, serial, firmware,
    building_id, floor_id, room_id, rack_id, rack_u, u_height, credential_id, connections,
    vlans, tags, notes, custom, created_at, updated_at,
    (SELECT count(*) FROM interfaces i WHERE i.device_id = devices.id), record_sessions,
    asset_number
    FROM devices";

fn row(r: &Row<'_>) -> rusqlite::Result<Device> {
    let kind: String = r.get(3)?;
    Ok(Device {
        id: r.get(0)?,
        hostname: r.get(1)?,
        mgmt_ip: r.get(2)?,
        device_type: serde_json::from_value(Value::String(kind)).unwrap_or(DeviceType::Generic),
        vendor: r.get(4)?,
        model: r.get(5)?,
        serial: r.get(6)?,
        firmware: r.get(7)?,
        asset_number: r.get(24)?,
        building_id: r.get(8)?,
        floor_id: r.get(9)?,
        room_id: r.get(10)?,
        rack_id: r.get(11)?,
        rack_u: r.get(12)?,
        u_height: r.get(13)?,
        credential_id: r.get(14)?,
        connections: super::json_col(r, 15)?,
        vlans: super::json_col(r, 16)?,
        tags: super::json_col(r, 17)?,
        notes: r.get(18)?,
        custom: super::json_col(r, 19)?,
        created_at: r.get(20)?,
        updated_at: r.get(21)?,
        interface_count: r.get(22)?,
        record_sessions: r.get(23)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Device>, CoreError> {
    let mut stmt = conn.prepare(&format!("{COLS} ORDER BY hostname COLLATE NOCASE, id"))?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Device>, CoreError> {
    Ok(conn
        .query_row(&format!("{COLS} WHERE id = ?1"), [id], row)
        .optional()?)
}

fn type_str(t: DeviceType) -> String {
    match serde_json::to_value(t) {
        Ok(Value::String(s)) => s,
        _ => "generic".into(),
    }
}

/// Fill parent locations from the most specific one and check they agree.
fn resolve_location(conn: &Connection, d: &mut Device) -> Result<(), CoreError> {
    if let Some(rack_id) = d.rack_id {
        let rack = locations::rack(conn, rack_id)?.ok_or_else(|| gone("rack"))?;
        d.floor_id = Some(rack.floor_id);
        d.room_id = rack.room_id.or(d.room_id);
        if let (Some(room), Some(rack_room)) = (d.room_id, rack.room_id) {
            if room != rack_room {
                d.room_id = Some(rack_room);
            }
        }
    }
    if let Some(room_id) = d.room_id {
        let room = locations::room(conn, room_id)?.ok_or_else(|| gone("room"))?;
        d.floor_id = Some(room.floor_id);
    }
    if let Some(floor_id) = d.floor_id {
        let floor = locations::floor(conn, floor_id)?.ok_or_else(|| gone("floor"))?;
        d.building_id = Some(floor.building_id);
    }
    if let Some(b) = d.building_id {
        locations::building(conn, b)?.ok_or_else(|| gone("building"))?;
    }
    if d.rack_id.is_none() {
        d.rack_u = None;
    }
    Ok(())
}

/// Check the U range is inside the rack and free.
fn check_rack(conn: &Connection, d: &Device) -> Result<(), CoreError> {
    let (Some(rack_id), Some(u)) = (d.rack_id, d.rack_u) else {
        return Ok(());
    };
    let rack = locations::rack(conn, rack_id)?.ok_or_else(|| gone("rack"))?;
    let top = u32::from(u) + u32::from(d.u_height) - 1;
    if u == 0 || top > u32::from(rack.height_u) {
        return Err(CoreError::Validation(format!(
            "{} is {} U high; it does not fit at U{u} in {} ({} U).",
            d.hostname, d.u_height, rack.name, rack.height_u
        )));
    }
    let clash: Option<(String, u16, u16)> = conn
        .query_row(
            "SELECT hostname, rack_u, u_height FROM devices
             WHERE rack_id = ?1 AND id != ?2 AND rack_u IS NOT NULL
               AND rack_u <= ?4 AND rack_u + u_height - 1 >= ?3
             ORDER BY rack_u LIMIT 1",
            params![rack_id, d.id, u, top],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((name, at, h)) = clash {
        let range = if h > 1 {
            format!("U{at}–U{}", at + h - 1)
        } else {
            format!("U{at}")
        };
        return Err(CoreError::Validation(format!(
            "{range} in {} is taken by {name}.",
            rack.name
        )));
    }
    Ok(())
}

fn clean(conn: &Connection, input: &Device) -> Result<Device, CoreError> {
    let mut d = input.clone();
    d.hostname = validate::hostname(&d.hostname)?;
    d.mgmt_ip = validate::ip_or_empty(&d.mgmt_ip, "management address")?;
    d.model = validate::text(&d.model, "model", 100)?;
    d.serial = validate::text(&d.serial, "serial number", 100)?;
    d.firmware = validate::text(&d.firmware, "firmware version", 100)?;
    d.asset_number = validate::text(&d.asset_number, "asset number", 100)?;
    d.notes = validate::text(&d.notes, "notes", 100_000)?;
    if !(1..=60).contains(&d.u_height) {
        return Err(CoreError::Validation("Height must be 1–60 U.".into()));
    }
    let vendor = d.vendor.trim();
    d.vendor = vendors(conn)?
        .into_iter()
        .find(|v| v.eq_ignore_ascii_case(vendor))
        .ok_or_else(|| {
            CoreError::Validation(format!("Add the vendor {vendor} before using it."))
        })?;
    if let Some(c) = d.credential_id {
        credentials::get(conn, c)?.ok_or_else(|| gone("credential profile"))?;
    }
    if d.connections.len() > 12 {
        return Err(CoreError::Validation(
            "At most 12 connection methods.".into(),
        ));
    }
    d.connections = d
        .connections
        .iter()
        .map(ConnectionMethod::clean)
        .collect::<Result<_, _>>()?;
    for v in &d.vlans {
        validate::vlan_id(*v)?;
    }
    d.vlans.sort_unstable();
    d.vlans.dedup();
    let mut tags = Vec::new();
    for t in &d.tags {
        let t = validate::name(t, "tag", 40)?;
        if !tags.iter().any(|x: &String| x.eq_ignore_ascii_case(&t)) {
            tags.push(t);
        }
    }
    if tags.len() > 50 {
        return Err(CoreError::Validation("At most 50 tags.".into()));
    }
    d.tags = tags;
    let defs = fields::list(conn)?;
    let mut custom = BTreeMap::new();
    for (key, value) in &d.custom {
        let def = defs
            .iter()
            .find(|f| &f.key == key)
            .ok_or_else(|| CoreError::Validation(format!("Unknown custom field {key}.")))?;
        let v = fields::check_value(def, value)?;
        if !v.is_null() {
            custom.insert(key.clone(), v);
        }
    }
    d.custom = custom;
    resolve_location(conn, &mut d)?;
    check_rack(conn, &d)?;
    Ok(d)
}

fn warnings(conn: &Connection, d: &Device) -> Result<Vec<String>, CoreError> {
    let mut out = Vec::new();
    if !d.mgmt_ip.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT hostname FROM devices WHERE mgmt_ip = ?1 AND id != ?2 ORDER BY hostname",
        )?;
        let names: Vec<String> = stmt
            .query_map(params![d.mgmt_ip, d.id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        if !names.is_empty() {
            out.push(format!(
                "{} is also used by {}.",
                d.mgmt_ip,
                names.join(", ")
            ));
        }
    }
    let same_name: i64 = conn.query_row(
        "SELECT count(*) FROM devices WHERE hostname = ?1 COLLATE NOCASE AND id != ?2",
        params![d.hostname, d.id],
        |r| r.get(0),
    )?;
    if same_name > 0 {
        out.push(format!("Another device is also named {}.", d.hostname));
    }
    Ok(out)
}

pub fn save(conn: &Connection, input: &Device) -> Result<SaveResult, CoreError> {
    let tx = conn.unchecked_transaction()?;
    let d = clean(&tx, input)?;
    let now = audit::now();
    let (old, id) = if d.id == 0 {
        tx.execute(
            "INSERT INTO devices (hostname, mgmt_ip, device_type, vendor, model, serial, firmware,
             building_id, floor_id, room_id, rack_id, rack_u, u_height, credential_id,
             connections, vlans, tags, notes, custom, created_at, updated_at, record_sessions,
             asset_number)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
             ?18, ?19, ?20, ?20, ?21, ?22)",
            params![
                d.hostname,
                d.mgmt_ip,
                type_str(d.device_type),
                d.vendor,
                d.model,
                d.serial,
                d.firmware,
                d.building_id,
                d.floor_id,
                d.room_id,
                d.rack_id,
                d.rack_u,
                d.u_height,
                d.credential_id,
                to_json(&d.connections)?,
                to_json(&d.vlans)?,
                to_json(&d.tags)?,
                d.notes,
                to_json(&d.custom)?,
                now,
                d.record_sessions,
                d.asset_number
            ],
        )?;
        (None, tx.last_insert_rowid())
    } else {
        let old = get(&tx, d.id)?.ok_or_else(|| gone("device"))?;
        tx.execute(
            "UPDATE devices SET hostname = ?2, mgmt_ip = ?3, device_type = ?4, vendor = ?5,
             model = ?6, serial = ?7, firmware = ?8, building_id = ?9, floor_id = ?10,
             room_id = ?11, rack_id = ?12, rack_u = ?13, u_height = ?14, credential_id = ?15,
             connections = ?16, vlans = ?17, tags = ?18, notes = ?19, custom = ?20,
             updated_at = ?21, record_sessions = ?22, asset_number = ?23 WHERE id = ?1",
            params![
                d.id,
                d.hostname,
                d.mgmt_ip,
                type_str(d.device_type),
                d.vendor,
                d.model,
                d.serial,
                d.firmware,
                d.building_id,
                d.floor_id,
                d.room_id,
                d.rack_id,
                d.rack_u,
                d.u_height,
                d.credential_id,
                to_json(&d.connections)?,
                to_json(&d.vlans)?,
                to_json(&d.tags)?,
                d.notes,
                to_json(&d.custom)?,
                now,
                d.record_sessions,
                d.asset_number
            ],
        )?;
        (Some(old), d.id)
    };
    let saved = get(&tx, id)?.ok_or_else(|| gone("device"))?;
    record(
        &tx,
        "device",
        id,
        &saved.hostname,
        old.as_ref(),
        Some(&saved),
    )?;
    let warnings = warnings(&tx, &saved)?;
    tx.commit()?;
    Ok(SaveResult {
        device: saved,
        warnings,
    })
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), CoreError> {
    let tx = conn.unchecked_transaction()?;
    let old = get(&tx, id)?.ok_or_else(|| gone("device"))?;
    tx.execute("DELETE FROM devices WHERE id = ?1", [id])?;
    crate::map::layout::forget_node(&tx, &format!("d:{id}"))?;
    record(&tx, "device", id, &old.hostname, Some(&old), None)?;
    tx.commit()?;
    Ok(())
}

/// Copy a device and its interfaces. The copy gets a new hostname, no management IP,
/// serial number or rack position (those are unique to the physical box).
pub fn duplicate(conn: &Connection, id: i64) -> Result<SaveResult, CoreError> {
    let src = get(conn, id)?.ok_or_else(|| gone("device"))?;
    let existing: Vec<String> = list(conn)?.into_iter().map(|d| d.hostname).collect();
    let base = format!("{}-copy", src.hostname);
    let mut hostname = base.clone();
    let mut n = 2;
    while existing.iter().any(|h| h.eq_ignore_ascii_case(&hostname)) {
        hostname = format!("{base}{n}");
        n += 1;
    }
    let copy = Device {
        id: 0,
        hostname,
        mgmt_ip: String::new(),
        serial: String::new(),
        rack_u: None,
        interface_count: 0,
        created_at: String::new(),
        updated_at: String::new(),
        ..src
    };
    let result = save(conn, &copy)?;
    let ifaces = interfaces::list(conn, id)?;
    if !ifaces.is_empty() {
        let tx = conn.unchecked_transaction()?;
        for i in &ifaces {
            tx.execute(
                "INSERT INTO interfaces (device_id, name, kind, speed, mode, access_vlan,
                 native_vlan, allowed_vlans, lag, description, enabled, position)
                 SELECT ?1, name, kind, speed, mode, access_vlan, native_vlan, allowed_vlans,
                 lag, description, enabled, position FROM interfaces WHERE id = ?2",
                params![result.device.id, i.id],
            )?;
        }
        let names: Vec<&str> = ifaces.iter().map(|i| i.name.as_str()).collect();
        record(
            &tx,
            "interfaces",
            result.device.id,
            &format!("{}: {} interfaces", result.device.hostname, names.len()),
            None,
            Some(&serde_json::json!({ "names": names })),
        )?;
        tx.commit()?;
    }
    let device = get(conn, result.device.id)?.ok_or_else(|| gone("device"))?;
    Ok(SaveResult {
        device,
        warnings: result.warnings,
    })
}

/// JSON text for a column.
fn to_json<T: Serialize>(v: &T) -> Result<String, CoreError> {
    Ok(serde_json::to_string(v)?)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::locations::{save_building, save_floor, save_rack, Building, Floor, Rack};
    use super::super::testutil;
    use super::*;
    use serde_json::json;

    pub(crate) fn device(name: &str) -> Device {
        Device {
            id: 0,
            hostname: name.into(),
            mgmt_ip: String::new(),
            device_type: DeviceType::Switch,
            vendor: "cisco".into(),
            model: "C9300-48P".into(),
            serial: String::new(),
            firmware: String::new(),
            asset_number: String::new(),
            building_id: None,
            floor_id: None,
            room_id: None,
            rack_id: None,
            rack_u: None,
            u_height: 1,
            credential_id: None,
            connections: vec![ConnectionMethod::Ssh {
                port: 22,
                username: String::new(),
                legacy: vec![],
                jumps: String::new(),
                agent_forwarding: false,
            }],
            vlans: vec![],
            tags: vec![],
            notes: String::new(),
            custom: BTreeMap::new(),
            interface_count: 0,
            record_sessions: false,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn rack(c: &Connection) -> Rack {
        let b = save_building(
            c,
            &Building {
                id: 0,
                site_id: 1,
                name: "HQ".into(),
                code: String::new(),
                address: String::new(),
                notes: String::new(),
            },
        )
        .expect("b");
        let f = save_floor(
            c,
            &Floor {
                id: 0,
                building_id: b.id,
                name: "1".into(),
                level: 1,
                notes: String::new(),
            },
        )
        .expect("f");
        save_rack(
            c,
            &Rack {
                id: 0,
                floor_id: f.id,
                room_id: None,
                name: "R1".into(),
                height_u: 10,
                notes: String::new(),
            },
        )
        .expect("r")
    }

    #[test]
    fn save_normalizes_and_warns_on_duplicate_ips() {
        let c = testutil::conn();
        let mut d = device("core-sw1");
        d.mgmt_ip = "10.0.0.1".into();
        d.tags = vec!["core".into(), "Core".into(), " lab ".into()];
        d.vlans = vec![20, 10, 20];
        let a = save(&c, &d).expect("save");
        assert_eq!(a.device.vendor, "Cisco");
        assert_eq!(a.device.tags, ["core", "lab"]);
        assert_eq!(a.device.vlans, [10, 20]);
        assert!(a.warnings.is_empty());
        let b = save(&c, &device("core-sw2").clone_with_ip("10.0.0.1")).expect("save b");
        assert_eq!(b.warnings, ["10.0.0.1 is also used by core-sw1."]);
        let mut bad = device("x");
        bad.mgmt_ip = "10.0.0".into();
        assert!(save(&c, &bad).is_err());
        let mut unknown = device("y");
        unknown.vendor = "Arista".into();
        assert!(save(&c, &unknown).is_err());
    }

    trait WithIp {
        fn clone_with_ip(self, ip: &str) -> Device;
    }
    impl WithIp for Device {
        fn clone_with_ip(mut self, ip: &str) -> Device {
            self.mgmt_ip = ip.into();
            self
        }
    }

    #[test]
    fn rack_placement_fills_location_and_prevents_collisions() {
        let c = testutil::conn();
        let r = rack(&c);
        let mut a = device("a");
        a.rack_id = Some(r.id);
        a.rack_u = Some(5);
        a.u_height = 2;
        let a = save(&c, &a).expect("a").device;
        assert_eq!(a.floor_id, Some(r.floor_id));
        assert!(a.building_id.is_some());
        let mut b = device("b");
        b.rack_id = Some(r.id);
        b.rack_u = Some(6);
        assert_eq!(
            save(&c, &b).expect_err("clash").to_string(),
            "U5–U6 in R1 is taken by a."
        );
        b.rack_u = Some(10);
        b.u_height = 2;
        assert!(save(&c, &b).is_err(), "does not fit");
        b.u_height = 1;
        save(&c, &b).expect("fits");
        // The rack cannot shrink below its contents.
        assert!(save_rack(
            &c,
            &Rack {
                height_u: 8,
                ..r.clone()
            }
        )
        .is_err());
    }

    #[test]
    fn custom_fields_and_connections_are_validated() {
        let c = testutil::conn();
        fields::save(
            &c,
            &fields::CustomField {
                id: 0,
                key: String::new(),
                label: "Asset tag".into(),
                kind: fields::FieldKind::Text,
                options: vec![],
                position: 0,
            },
        )
        .expect("field");
        let mut d = device("sw");
        d.custom.insert("asset_tag".into(), json!("A-100"));
        d.custom.insert("empty".into(), json!(null));
        assert!(save(&c, &d).is_err(), "unknown key");
        d.custom.remove("empty");
        d.connections.push(ConnectionMethod::Web {
            url: "javascript:alert(1)".into(),
        });
        assert!(save(&c, &d).is_err());
        d.connections.pop();
        let s = save(&c, &d).expect("save").device;
        assert_eq!(s.custom["asset_tag"], json!("A-100"));
    }

    #[test]
    fn update_audits_a_field_diff_and_duplicate_copies_interfaces() {
        let c = testutil::conn();
        let d = save(&c, &device("sw1")).expect("save").device;
        super::super::interfaces::bulk_create(
            &c,
            d.id,
            "Gi1/0/1-3",
            &super::super::interfaces::Interface {
                id: 0,
                device_id: 0,
                name: String::new(),
                kind: super::super::InterfaceKind::Copper,
                speed: String::new(),
                mode: super::super::InterfaceMode::Access,
                access_vlan: None,
                native_vlan: None,
                allowed_vlans: String::new(),
                lag: String::new(),
                description: String::new(),
                enabled: true,
                position: 0,
            },
        )
        .expect("ifaces");
        let mut changed = get(&c, d.id).expect("get").expect("some");
        changed.model = "C9300-24P".into();
        save(&c, &changed).expect("update");
        let log = testutil::changes(&c);
        let update = &log[2];
        assert_eq!(update["action"], "updated");
        assert_eq!(update["changes"].as_array().map(Vec::len), Some(1));
        assert_eq!(update["changes"][0]["field"], "model");

        // The asset number round-trips and its change is audited like any field.
        let mut tagged = get(&c, d.id).expect("get").expect("some");
        tagged.asset_number = "  INV-004211 ".into();
        let saved = save(&c, &tagged).expect("asset number").device;
        assert_eq!(saved.asset_number, "INV-004211");
        let log = testutil::changes(&c);
        assert_eq!(log[3]["changes"][0]["field"], "assetNumber");

        let copy = duplicate(&c, d.id).expect("dup").device;
        assert_eq!(copy.hostname, "sw1-copy");
        assert_eq!(copy.interface_count, 3);
        let copy2 = duplicate(&c, d.id).expect("dup2").device;
        assert_eq!(copy2.hostname, "sw1-copy2");
        delete(&c, d.id).expect("delete");
        assert_eq!(list(&c).expect("list").len(), 2);
    }

    #[test]
    fn rdp_methods_load_with_defaults_and_validate() {
        let old: ConnectionMethod =
            serde_json::from_value(json!({"kind": "rdp", "port": 3389, "username": "admin"}))
                .expect("old shape");
        let ConnectionMethod::Rdp {
            security,
            width,
            color_depth,
            clipboard,
            external,
            ..
        } = &old
        else {
            panic!("rdp");
        };
        assert_eq!((security.as_str(), *width, *color_depth), ("nla", 0, 32));
        assert!(*clipboard && !*external);
        assert!(old.clean().is_ok());

        let with = |patch: serde_json::Value| {
            let mut v = json!({"kind": "rdp"});
            if let (Some(o), Some(p)) = (v.as_object_mut(), patch.as_object()) {
                o.extend(p.clone());
            }
            serde_json::from_value::<ConnectionMethod>(v)
                .expect("shape")
                .clean()
        };
        assert!(with(json!({"security": "tls", "width": 1920, "height": 1080})).is_ok());
        assert!(with(json!({"security": "rdp"})).is_err());
        assert!(with(json!({"width": 1920, "height": 0})).is_err());
        assert!(with(json!({"width": 100, "height": 100})).is_err());
        assert!(with(json!({"colorDepth": 24})).is_err());
    }
}
