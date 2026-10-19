//! Readable export of the inventory (SPEC §11): locations, devices, interfaces, links
//! and VLANs as one JSON file or a folder of CSV files. Credential profiles are left
//! out unless asked for; with them, their secrets are written in plain text.

use crate::csv::CsvWriter;
use crate::error::CoreError;
use crate::inventory::credentials::{self, CredentialProfile};
use crate::inventory::devices::{self, Device};
use crate::inventory::interfaces::{self, Interface};
use crate::inventory::locations::{self, Building, Floor, Rack, Room, Site};
use crate::inventory::vlans::{self, Vlan};
use crate::map::links::{self, Link};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// A credential profile with its secrets (only when the user opted in).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedCredential {
    #[serde(flatten)]
    pub profile: CredentialProfile,
    pub password: Option<String>,
    pub key_data: Option<String>,
    pub key_passphrase: Option<String>,
    pub enable_secret: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataExport {
    pub exported_at: String,
    pub app_version: String,
    pub sites: Vec<Site>,
    pub buildings: Vec<Building>,
    pub floors: Vec<Floor>,
    pub rooms: Vec<Room>,
    pub racks: Vec<Rack>,
    pub vlans: Vec<Vlan>,
    pub devices: Vec<Device>,
    pub interfaces: Vec<Interface>,
    pub links: Vec<Link>,
    /// Present only when credentials were included.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials: Option<Vec<ExportedCredential>>,
}

/// Everything to export, read in one go.
pub fn collect(
    conn: &Connection,
    include_credentials: bool,
    app_version: &str,
) -> Result<DataExport, CoreError> {
    let devices = devices::list(conn)?;
    let mut all_interfaces = Vec::new();
    for d in &devices {
        all_interfaces.extend(interfaces::list(conn, d.id)?);
    }
    let credentials = if include_credentials {
        let mut out = Vec::new();
        for profile in credentials::list(conn)? {
            let s = credentials::secrets(conn, profile.id)?;
            let reveal =
                |v: &Option<crate::SecretString>| v.as_ref().map(|s| s.expose().to_owned());
            out.push(ExportedCredential {
                password: reveal(&s.password),
                key_data: reveal(&s.key_data),
                key_passphrase: reveal(&s.key_passphrase),
                enable_secret: reveal(&s.enable_secret),
                profile,
            });
        }
        Some(out)
    } else {
        None
    };
    Ok(DataExport {
        exported_at: crate::audit::now(),
        app_version: app_version.to_owned(),
        sites: locations::sites(conn)?,
        buildings: locations::buildings(conn)?,
        floors: locations::floors(conn)?,
        rooms: locations::rooms(conn)?,
        racks: locations::racks(conn)?,
        vlans: vlans::list(conn)?,
        devices,
        interfaces: all_interfaces,
        links: links::list(conn)?,
        credentials,
    })
}

fn io(path: &Path) -> impl Fn(std::io::Error) -> CoreError + '_ {
    move |e| CoreError::io(path, e)
}

/// Write the export as one pretty-printed JSON file.
pub fn write_json(data: &DataExport, path: &Path) -> Result<(), CoreError> {
    let mut f = fs::File::create(path).map_err(io(path))?;
    serde_json::to_writer_pretty(&mut f, data)?;
    f.write_all(b"\n").map_err(io(path))?;
    Ok(())
}

/// An enum's serialized name (`router`, `trunk`, `sm-fiber`, …).
fn name_of<T: Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => String::new(),
    }
}

fn opt<T: ToString>(v: Option<T>) -> String {
    v.map(|x| x.to_string()).unwrap_or_default()
}

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// Write the export as CSV files in a new folder `dir`; returns the files written.
/// Location and device references are written as names, so the files read on their
/// own.
pub fn write_csv(data: &DataExport, dir: &Path) -> Result<Vec<PathBuf>, CoreError> {
    fs::create_dir_all(dir).map_err(io(dir))?;
    let mut written = Vec::new();
    let mut file = |name: &str, header: &[&str], rows: Vec<Vec<String>>| -> Result<(), CoreError> {
        let path = dir.join(name);
        let f = fs::File::create(&path).map_err(io(&path))?;
        let mut w = CsvWriter::new(std::io::BufWriter::new(f));
        w.row(header).map_err(io(&path))?;
        for r in rows {
            w.row(r).map_err(io(&path))?;
        }
        w.into_inner().flush().map_err(io(&path))?;
        written.push(path);
        Ok(())
    };

    let site: HashMap<i64, &str> = data.sites.iter().map(|s| (s.id, s.name.as_str())).collect();
    let building: HashMap<i64, &Building> = data.buildings.iter().map(|b| (b.id, b)).collect();
    let floor: HashMap<i64, &str> = data
        .floors
        .iter()
        .map(|f| (f.id, f.name.as_str()))
        .collect();
    let room: HashMap<i64, &str> = data.rooms.iter().map(|r| (r.id, r.name.as_str())).collect();
    let rack: HashMap<i64, &str> = data.racks.iter().map(|r| (r.id, r.name.as_str())).collect();
    let host: HashMap<i64, &str> = data
        .devices
        .iter()
        .map(|d| (d.id, d.hostname.as_str()))
        .collect();
    let profile: HashMap<i64, String> = data
        .credentials
        .iter()
        .flatten()
        .map(|c| (c.profile.id, c.profile.name.clone()))
        .collect();
    let name = |m: &HashMap<i64, &str>, id: Option<i64>| {
        id.and_then(|i| m.get(&i).map(|s| (*s).to_owned()))
            .unwrap_or_default()
    };

    file(
        "locations.csv",
        &[
            "type", "site", "building", "floor", "room", "name", "code", "level", "height_u",
            "address", "notes",
        ],
        {
            let mut rows = Vec::new();
            for s in &data.sites {
                rows.push(vec![
                    "site".into(),
                    s.name.clone(),
                    "".into(),
                    "".into(),
                    "".into(),
                    s.name.clone(),
                    "".into(),
                    "".into(),
                    "".into(),
                    "".into(),
                    s.notes.clone(),
                ]);
            }
            for b in &data.buildings {
                rows.push(vec![
                    "building".into(),
                    name(&site, Some(b.site_id)),
                    b.name.clone(),
                    "".into(),
                    "".into(),
                    b.name.clone(),
                    b.code.clone(),
                    "".into(),
                    "".into(),
                    b.address.clone(),
                    b.notes.clone(),
                ]);
            }
            for f in &data.floors {
                let b = building.get(&f.building_id);
                rows.push(vec![
                    "floor".into(),
                    name(&site, b.map(|b| b.site_id)),
                    b.map(|b| b.name.clone()).unwrap_or_default(),
                    f.name.clone(),
                    "".into(),
                    f.name.clone(),
                    "".into(),
                    f.level.to_string(),
                    "".into(),
                    "".into(),
                    f.notes.clone(),
                ]);
            }
            for r in &data.rooms {
                rows.push(vec![
                    "room".into(),
                    "".into(),
                    "".into(),
                    name(&floor, Some(r.floor_id)),
                    r.name.clone(),
                    r.name.clone(),
                    "".into(),
                    "".into(),
                    "".into(),
                    "".into(),
                    r.notes.clone(),
                ]);
            }
            for r in &data.racks {
                rows.push(vec![
                    "rack".into(),
                    "".into(),
                    "".into(),
                    name(&floor, Some(r.floor_id)),
                    name(&room, r.room_id),
                    r.name.clone(),
                    "".into(),
                    "".into(),
                    r.height_u.to_string(),
                    "".into(),
                    r.notes.clone(),
                ]);
            }
            rows
        },
    )?;

    file(
        "devices.csv",
        &[
            "hostname",
            "mgmt_ip",
            "type",
            "vendor",
            "model",
            "serial",
            "firmware",
            "asset_number",
            "building",
            "floor",
            "room",
            "rack",
            "rack_u",
            "u_height",
            "credential_profile",
            "vlans",
            "tags",
            "connections",
            "custom_fields",
            "notes",
            "created_at",
            "updated_at",
        ],
        data.devices
            .iter()
            .map(|d| {
                vec![
                    d.hostname.clone(),
                    d.mgmt_ip.clone(),
                    name_of(&d.device_type),
                    d.vendor.clone(),
                    d.model.clone(),
                    d.serial.clone(),
                    d.firmware.clone(),
                    d.asset_number.clone(),
                    d.building_id
                        .and_then(|i| building.get(&i).map(|b| b.name.clone()))
                        .unwrap_or_default(),
                    name(&floor, d.floor_id),
                    name(&room, d.room_id),
                    name(&rack, d.rack_id),
                    opt(d.rack_u),
                    d.u_height.to_string(),
                    d.credential_id
                        .and_then(|i| profile.get(&i).cloned())
                        .unwrap_or_default(),
                    d.vlans
                        .iter()
                        .map(u16::to_string)
                        .collect::<Vec<_>>()
                        .join(","),
                    d.tags.join(";"),
                    json(&d.connections),
                    json(&d.custom),
                    d.notes.clone(),
                    d.created_at.clone(),
                    d.updated_at.clone(),
                ]
            })
            .collect(),
    )?;

    file(
        "interfaces.csv",
        &[
            "device",
            "name",
            "kind",
            "speed",
            "mode",
            "access_vlan",
            "native_vlan",
            "allowed_vlans",
            "lag",
            "description",
            "enabled",
        ],
        data.interfaces
            .iter()
            .map(|i| {
                vec![
                    name(&host, Some(i.device_id)),
                    i.name.clone(),
                    name_of(&i.kind),
                    i.speed.clone(),
                    name_of(&i.mode),
                    opt(i.access_vlan),
                    opt(i.native_vlan),
                    i.allowed_vlans.clone(),
                    i.lag.clone(),
                    i.description.clone(),
                    i.enabled.to_string(),
                ]
            })
            .collect(),
    )?;

    file(
        "links.csv",
        &[
            "a_device",
            "a_interface",
            "b_device",
            "b_interface",
            "media",
            "speed",
            "vlans",
            "lag",
            "description",
        ],
        data.links
            .iter()
            .map(|l| {
                vec![
                    name(&host, Some(l.a_device_id)),
                    l.a_name.clone(),
                    name(&host, Some(l.b_device_id)),
                    l.b_name.clone(),
                    name_of(&l.media),
                    l.speed.clone(),
                    l.vlans.clone(),
                    l.lag.clone(),
                    l.description.clone(),
                ]
            })
            .collect(),
    )?;

    file(
        "vlans.csv",
        &["vid", "name", "subnet", "gateway", "description", "color"],
        data.vlans
            .iter()
            .map(|v| {
                vec![
                    v.vid.to_string(),
                    v.name.clone(),
                    v.subnet.clone(),
                    v.gateway.clone(),
                    v.description.clone(),
                    v.color.clone(),
                ]
            })
            .collect(),
    )?;

    if let Some(creds) = &data.credentials {
        file(
            "credentials.csv",
            &[
                "name",
                "username",
                "key_path",
                "auto_enable",
                "password",
                "key_data",
                "key_passphrase",
                "enable_secret",
                "notes",
            ],
            creds
                .iter()
                .map(|c| {
                    vec![
                        c.profile.name.clone(),
                        c.profile.username.clone(),
                        c.profile.key_path.clone().unwrap_or_default(),
                        c.profile.auto_enable.to_string(),
                        c.password.clone().unwrap_or_default(),
                        c.key_data.clone().unwrap_or_default(),
                        c.key_passphrase.clone().unwrap_or_default(),
                        c.enable_secret.clone().unwrap_or_default(),
                        c.profile.notes.clone(),
                    ]
                })
                .collect(),
        )?;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inventory::testutil;
    use serde_json::json;

    fn from<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> T {
        serde_json::from_value(v).expect("input")
    }

    /// Two devices with one link between them, a VLAN, a credential profile with a
    /// password, and a model that looks like a spreadsheet formula.
    fn seed(c: &Connection) {
        let profile = credentials::save(
            c,
            &from(json!({
                "name": "lab",
                "username": "admin",
                "password": { "action": "set", "value": "Hunter2-Secret" }
            })),
        )
        .expect("profile");
        let mut sw = devices::tests::device("sw1");
        sw.credential_id = Some(profile.id);
        sw.tags = vec!["core".into(), "lab".into()];
        let sw = devices::save(c, &sw).expect("sw1").device;
        // Hostnames are validated, but free text such as the model is not.
        let mut fw = devices::tests::device("fw1");
        fw.model = "=HYPERLINK(\"x\")".into();
        let evil = devices::save(c, &fw).expect("fw1").device;
        let a = interfaces::save(
            c,
            &from(json!({ "deviceId": sw.id, "name": "Gi1/0/1", "kind": "copper", "mode": "trunk", "allowedVlans": "10,20" })),
        )
        .expect("a");
        let b = interfaces::save(
            c,
            &from(json!({ "deviceId": evil.id, "name": "eth0", "kind": "copper", "mode": "access", "accessVlan": 10 })),
        )
        .expect("b");
        links::save(
            c,
            &from(json!({ "aInterfaceId": a.id, "bInterfaceId": b.id, "media": "copper", "speed": "1G" })),
        )
        .expect("link");
        vlans::save(
            c,
            &from(json!({ "vid": 10, "name": "users", "subnet": "10.0.10.0/24" })),
        )
        .expect("vlan");
    }

    #[test]
    fn json_leaves_credentials_out_unless_asked() {
        let c = testutil::conn();
        seed(&c);
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("inventory.json");
        write_json(&collect(&c, false, "0.1.0").expect("collect"), &path).expect("write");
        let text = fs::read_to_string(&path).expect("read");
        let v: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert_eq!(v["devices"].as_array().map(Vec::len), Some(2));
        assert_eq!(v["interfaces"].as_array().map(Vec::len), Some(2));
        assert_eq!(v["links"][0]["speed"], "1G");
        assert_eq!(v["vlans"][0]["vid"], 10);
        assert!(v.get("credentials").is_none());
        assert!(!text.contains("Hunter2"));

        write_json(&collect(&c, true, "0.1.0").expect("collect"), &path).expect("write");
        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(v["credentials"][0]["name"], "lab");
        assert_eq!(v["credentials"][0]["password"], "Hunter2-Secret");
    }

    #[test]
    fn csv_files_use_names_and_neutralize_formulas() {
        let c = testutil::conn();
        seed(&c);
        let dir = tempfile::tempdir().expect("tmp");
        let out = dir.path().join("export");
        let files = write_csv(&collect(&c, false, "0.1.0").expect("collect"), &out).expect("csv");
        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().expect("name").to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![
                "locations.csv",
                "devices.csv",
                "interfaces.csv",
                "links.csv",
                "vlans.csv"
            ]
        );
        let devices = fs::read_to_string(out.join("devices.csv")).expect("devices");
        assert!(devices.starts_with("hostname,mgmt_ip,type"));
        assert!(devices.contains("\r\nsw1,"));
        assert!(devices.contains("core;lab"));
        // The credential profile name is not exported without credentials.
        assert!(!devices.contains(",lab,"));
        assert!(devices.contains("\"'=HYPERLINK(\"\"x\"\")\""));
        let links = fs::read_to_string(out.join("links.csv")).expect("links");
        assert!(links.contains("sw1,Gi1/0/1,"));
        let interfaces = fs::read_to_string(out.join("interfaces.csv")).expect("interfaces");
        assert!(interfaces.contains("sw1,Gi1/0/1,copper,,trunk,,,\"10,20\""));

        let with = dir.path().join("with");
        let files = write_csv(&collect(&c, true, "0.1.0").expect("collect"), &with).expect("csv");
        assert_eq!(files.len(), 6);
        let creds = fs::read_to_string(with.join("credentials.csv")).expect("creds");
        assert!(creds.contains("lab,admin,,false,Hunter2-Secret"));
        let devices = fs::read_to_string(with.join("devices.csv")).expect("devices");
        assert!(devices.contains(",lab,"));
    }
}
