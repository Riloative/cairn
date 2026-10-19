//! Fill a Cairn vault with a small demo campus (two buildings, racks, VLANs, links)
//! for trying the inventory and the map.
//!
//! Usage: `echo "<master password>" | cargo run -p cairn-core --example seed_demo -- <vault dir>`
//! (Linux: `~/.local/share/app.cairn.desktop`). Creates the vault if it does not exist.
//! The password is read from stdin so it never appears in the process list.

use std::collections::HashMap;
use std::io::BufRead;

use cairn_core::inventory::{devices, interfaces, locations, vlans};
use cairn_core::map::links;
use cairn_core::{CoreError, SecretString, Vault, VaultStatus};
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

fn from<T: DeserializeOwned>(v: Value) -> Result<T, CoreError> {
    Ok(serde_json::from_value(v)?)
}

type Ifaces = HashMap<(String, String), i64>;

fn seed(c: &Connection) -> Result<(), CoreError> {
    let hq = locations::save_building(c, &from(json!({"siteId": 1, "name": "HQ", "code": "HQ"}))?)?;
    let wh = locations::save_building(
        c,
        &from(json!({"siteId": 1, "name": "Warehouse", "code": "WH"}))?,
    )?;
    let hq0 = locations::save_floor(
        c,
        &from(json!({"buildingId": hq.id, "name": "Ground", "level": 0}))?,
    )?;
    let hq1 = locations::save_floor(
        c,
        &from(json!({"buildingId": hq.id, "name": "First", "level": 1}))?,
    )?;
    let wh0 = locations::save_floor(
        c,
        &from(json!({"buildingId": wh.id, "name": "Hall", "level": 0}))?,
    )?;
    let r1 = locations::save_rack(
        c,
        &from(json!({"floorId": hq0.id, "name": "R1", "heightU": 24}))?,
    )?;
    locations::save_rack(
        c,
        &from(json!({"floorId": hq0.id, "name": "R2", "heightU": 24}))?,
    )?;

    for (vid, name, color) in [
        (10, "users", "#3b82f6"),
        (20, "voice", "#a855f7"),
        (30, "wifi", "#14b8a6"),
        (99, "mgmt", "#f59e0b"),
    ] {
        vlans::save(c, &from(json!({"vid": vid, "name": name, "color": color}))?)?;
    }

    // Devices as saved over IPC, plus "ifaces" to create; "rackU" places them in R1.
    let (hq, hq0, hq1, wh, wh0) = (hq.id, hq0.id, hq1.id, wh.id, wh0.id);
    let list = [
        json!({"hostname": "wan-rtr", "deviceType": "router", "vendor": "Juniper", "mgmtIp": "10.255.0.1", "ifaces": ["ge-0/0/0", "ge-0/0/1"]}),
        json!({"hostname": "fw-edge", "deviceType": "firewall", "vendor": "Fortinet", "mgmtIp": "10.0.0.1", "buildingId": hq, "floorId": hq0, "rackU": 20, "ifaces": ["port1", "port2", "port3"]}),
        json!({"hostname": "core-1", "deviceType": "switch", "vendor": "Cisco", "mgmtIp": "10.0.0.2", "buildingId": hq, "floorId": hq0, "rackU": 18, "tags": ["core"], "ifaces": ["Te1/1/1", "Te1/1/2", "Te1/1/3", "Te1/1/4", "Gi1/0/1", "Gi1/0/48"]}),
        json!({"hostname": "core-2", "deviceType": "switch", "vendor": "Cisco", "mgmtIp": "10.0.0.3", "buildingId": hq, "floorId": hq0, "rackU": 17, "tags": ["core"], "ifaces": ["Te1/1/1", "Te1/1/2", "Te1/1/3", "Te1/1/4", "Gi1/0/1"]}),
        json!({"hostname": "esx-01", "deviceType": "hypervisor", "vendor": "Dell", "mgmtIp": "10.0.0.20", "buildingId": hq, "floorId": hq0, "rackU": 10, "uHeight": 2, "ifaces": ["vmnic0"]}),
        json!({"hostname": "acc-1-1", "deviceType": "switch", "vendor": "Aruba", "mgmtIp": "10.0.1.11", "buildingId": hq, "floorId": hq1, "tags": ["access"], "ifaces": ["1/1/1", "1/1/49"]}),
        json!({"hostname": "acc-1-2", "deviceType": "switch", "vendor": "Aruba", "mgmtIp": "10.0.1.12", "buildingId": hq, "floorId": hq1, "tags": ["access"], "ifaces": ["1/1/49"]}),
        json!({"hostname": "ap-1-1", "deviceType": "access-point", "vendor": "Aruba", "mgmtIp": "10.0.1.31", "buildingId": hq, "floorId": hq1, "ifaces": ["eth0"]}),
        json!({"hostname": "dist-wh", "deviceType": "switch", "vendor": "HP", "mgmtIp": "10.0.2.1", "buildingId": wh, "floorId": wh0, "tags": ["distribution"], "ifaces": ["A1", "A2", "1"]}),
        json!({"hostname": "acc-wh-1", "deviceType": "switch", "vendor": "Ubiquiti", "mgmtIp": "10.0.2.11", "buildingId": wh, "floorId": wh0, "tags": ["access"], "ifaces": ["1", "5"]}),
        json!({"hostname": "cam-dock", "deviceType": "camera", "vendor": "Generic", "mgmtIp": "10.0.2.51", "buildingId": wh, "floorId": wh0, "ifaces": ["eth0"]}),
    ];
    let mut ifaces: Ifaces = HashMap::new();
    for mut spec in list {
        let names: Vec<String> = from(spec["ifaces"].take())?;
        if !spec["rackU"].is_null() {
            spec["rackId"] = json!(r1.id);
        }
        spec["connections"] = json!([{"kind": "ssh", "port": 22, "username": "admin"}]);
        let saved = devices::save(c, &from(spec)?)?.device;
        for name in names {
            let i: interfaces::Interface = from(json!({
                "deviceId": saved.id, "name": name, "kind": "copper", "mode": "access",
            }))?;
            let i = interfaces::save(c, &i)?;
            ifaces.insert((saved.hostname.clone(), name), i.id);
        }
    }

    let id = |h: &str, i: &str| -> Result<i64, CoreError> {
        ifaces
            .get(&(h.to_string(), i.to_string()))
            .copied()
            .ok_or_else(|| CoreError::Validation(format!("no interface {h} {i}")))
    };
    let cables = [
        (
            "wan-rtr", "ge-0/0/0", "fw-edge", "port1", "copper", "1G", "", "",
        ),
        (
            "fw-edge", "port2", "core-1", "Te1/1/1", "sm-fiber", "10G", "99", "",
        ),
        (
            "fw-edge", "port3", "core-2", "Te1/1/1", "sm-fiber", "10G", "99", "",
        ),
        (
            "core-1",
            "Te1/1/2",
            "core-2",
            "Te1/1/2",
            "dac",
            "10G",
            "10,20,30,99",
            "Po1",
        ),
        (
            "core-1",
            "Te1/1/3",
            "core-2",
            "Te1/1/3",
            "dac",
            "10G",
            "10,20,30,99",
            "Po1",
        ),
        (
            "core-1", "Gi1/0/1", "acc-1-1", "1/1/49", "mm-fiber", "1G", "10,20,30", "",
        ),
        (
            "core-2", "Gi1/0/1", "acc-1-2", "1/1/49", "mm-fiber", "1G", "10,20", "",
        ),
        (
            "acc-1-1", "1/1/1", "ap-1-1", "eth0", "copper", "1G", "30", "",
        ),
        (
            "core-1", "Gi1/0/48", "esx-01", "vmnic0", "copper", "10G", "99", "",
        ),
        (
            "core-1", "Te1/1/4", "dist-wh", "A1", "sm-fiber", "10G", "10,99", "",
        ),
        (
            "core-2", "Te1/1/4", "dist-wh", "A2", "sm-fiber", "10G", "10,99", "",
        ),
        ("dist-wh", "1", "acc-wh-1", "1", "copper", "1G", "10", ""),
        (
            "acc-wh-1", "5", "cam-dock", "eth0", "wireless", "100M", "10", "",
        ),
    ];
    for (a, ai, b, bi, media, speed, vlans, lag) in cables {
        let l: links::Link = from(json!({
            "aInterfaceId": id(a, ai)?, "bInterfaceId": id(b, bi)?, "media": media,
            "speed": speed, "vlans": vlans, "lag": lag,
        }))?;
        links::save(c, &l)?;
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::args()
        .nth(1)
        .ok_or("usage: seed_demo <vault dir> (password on stdin)")?;
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    let password = SecretString::new(line.trim_end_matches(['\r', '\n']).to_string());
    let mut vault = Vault::new(dir);
    match vault.status() {
        VaultStatus::Uninitialized => vault.setup(&password)?,
        _ => vault.unlock(&password)?,
    }
    vault.with_conn(seed)?;
    println!("Seeded a demo campus.");
    Ok(())
}
