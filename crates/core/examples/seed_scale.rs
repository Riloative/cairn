//! Fill a vault with an inventory at the size Cairn is built for (SPEC M9): 300 devices
//! in 5 buildings, ~7,000 interfaces and 500 links, then time the reads the UI makes.
//!
//! Usage: `echo "<master password>" | cargo run --release -p cairn-core --example seed_scale -- <vault dir>`
//! Creates the vault if it does not exist. The password is read from stdin.

use std::io::BufRead;
use std::time::Instant;

use cairn_core::audit::{self, AuditFilter};
use cairn_core::inventory::{self, devices, interfaces, locations, vlans};
use cairn_core::map::links;
use cairn_core::{CoreError, SecretString, Vault, VaultStatus};
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

pub const DEVICES: usize = 300;
pub const LINKS: usize = 500;
const BUILDINGS: usize = 5;
const FLOORS: usize = 3;

fn from<T: DeserializeOwned>(v: Value) -> Result<T, CoreError> {
    Ok(serde_json::from_value(v)?)
}

struct Dev {
    ifaces: Vec<i64>,
    next: usize,
}

impl Dev {
    /// The next unused interface.
    fn port(&mut self) -> i64 {
        let id = self.ifaces[self.next % self.ifaces.len()];
        self.next += 1;
        id
    }
}

fn device(c: &Connection, spec: Value, ports: usize, prefix: &str) -> Result<Dev, CoreError> {
    let saved = devices::save(c, &from(spec)?)?.device;
    let mut ifaces = Vec::with_capacity(ports);
    for p in 1..=ports {
        let i: interfaces::Interface = from(json!({
            "deviceId": saved.id, "name": format!("{prefix}{p}"), "kind": "copper",
            "mode": if p > ports - 2 { "trunk" } else { "access" },
            "accessVlan": if p > ports - 2 { Value::Null } else { json!(10) },
            "allowedVlans": if p > ports - 2 { "10,20,30,99" } else { "" },
        }))?;
        ifaces.push(interfaces::save(c, &i)?.id);
    }
    Ok(Dev { ifaces, next: 0 })
}

fn link(c: &Connection, a: i64, b: i64, media: &str, speed: &str) -> Result<(), CoreError> {
    links::save(
        c,
        &from(
            json!({"aInterfaceId": a, "bInterfaceId": b, "media": media, "speed": speed, "vlans": "10,20,30,99"}),
        )?,
    )?;
    Ok(())
}

fn seed(c: &Connection) -> Result<(), CoreError> {
    for (vid, name) in [(10, "users"), (20, "voice"), (30, "wifi"), (99, "mgmt")] {
        vlans::save(c, &from(json!({"vid": vid, "name": name}))?)?;
    }
    let ssh = json!([{"kind": "ssh", "port": 22, "username": "admin"}]);
    let mut cores = Vec::new();
    for n in 1..=4 {
        cores.push(device(
            c,
            json!({"hostname": format!("core-{n}"), "deviceType": "switch", "vendor": "Cisco",
                   "mgmtIp": format!("10.0.0.{n}"), "tags": ["core"], "connections": ssh}),
            48,
            "Te1/0/",
        )?);
    }
    let mut dists = Vec::new();
    let mut access = Vec::new();
    let per_floor = (DEVICES - cores.len() - BUILDINGS * 2) / (BUILDINGS * FLOORS);
    let mut made = cores.len();
    for b in 1..=BUILDINGS {
        let building = locations::save_building(
            c,
            &from(json!({"siteId": 1, "name": format!("Building {b}"), "code": format!("B{b}")}))?,
        )?;
        for d in 1..=2 {
            dists.push(device(
                c,
                json!({"hostname": format!("dist-b{b}-{d}"), "deviceType": "switch",
                       "vendor": "Aruba", "mgmtIp": format!("10.{b}.0.{d}"),
                       "buildingId": building.id, "tags": ["distribution"], "connections": ssh}),
                48,
                "1/1/",
            )?);
            made += 1;
        }
        for f in 0..FLOORS {
            let floor = locations::save_floor(
                c,
                &from(
                    json!({"buildingId": building.id, "name": format!("Floor {f}"), "level": f}),
                )?,
            )?;
            let rack = locations::save_rack(
                c,
                &from(
                    json!({"floorId": floor.id, "name": format!("B{b}-F{f}-R1"), "heightU": 42}),
                )?,
            )?;
            for n in 1..=per_floor {
                let in_rack = n <= 20;
                access.push(device(
                    c,
                    json!({"hostname": format!("acc-b{b}-f{f}-{n:02}"), "deviceType": "switch",
                           "vendor": "HP", "mgmtIp": format!("10.{b}.{}.{n}", f + 1),
                           "buildingId": building.id, "floorId": floor.id,
                           "rackId": if in_rack { json!(rack.id) } else { Value::Null },
                           "rackU": if in_rack { json!(n * 2) } else { Value::Null },
                           "tags": ["access"], "connections": ssh}),
                    26,
                    "",
                )?);
                made += 1;
            }
        }
    }
    // Fill up to exactly DEVICES with access points on the first building's ground floor.
    while made < DEVICES {
        access.push(device(
            c,
            json!({"hostname": format!("ap-{made}"), "deviceType": "access-point",
                   "vendor": "Aruba", "connections": ssh}),
            2,
            "eth",
        )?);
        made += 1;
    }

    // Core full mesh (6), each distribution pair to two cores (20), each access switch
    // to its building's distribution (one uplink each), then extra access cross-links.
    let mut count = 0usize;
    for i in 0..cores.len() {
        for j in i + 1..cores.len() {
            let (a, b) = (cores[i].port(), cores[j].port());
            link(c, a, b, "dac", "40G")?;
            count += 1;
        }
    }
    for (n, d) in dists.iter_mut().enumerate() {
        for k in 0..2 {
            let core = &mut cores[(n + k) % 4];
            link(c, d.port(), core.port(), "sm-fiber", "10G")?;
            count += 1;
        }
    }
    let dist_count = dists.len();
    for (n, a) in access.iter_mut().enumerate() {
        let d = &mut dists[n * dist_count / DEVICES % dist_count];
        link(c, a.port(), d.port(), "mm-fiber", "1G")?;
        count += 1;
    }
    let mut n = 0;
    while count < LINKS {
        let (i, j) = (n % access.len(), (n + 7) % access.len());
        if i != j {
            let a = access[i].port();
            let b = access[j].port();
            link(c, a, b, "copper", "1G")?;
            count += 1;
        }
        n += 1;
    }
    Ok(())
}

/// Median of `runs` timings of `f`, in milliseconds.
fn time<T>(runs: usize, mut f: impl FnMut() -> Result<T, CoreError>) -> Result<f64, CoreError> {
    let mut ms = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t = Instant::now();
        f()?;
        ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    ms.sort_by(f64::total_cmp);
    Ok(ms[runs / 2])
}

fn report(c: &Connection) -> Result<(), CoreError> {
    let snap = inventory::snapshot(c)?;
    let all_links = links::list(c)?;
    println!(
        "{} devices, {} links, {} audit entries",
        snap.devices.len(),
        all_links.len(),
        audit::query(c, &AuditFilter::default(), None, 1)?.total
    );
    println!(
        "inventory snapshot   {:7.1} ms",
        time(10, || inventory::snapshot(c))?
    );
    println!(
        "links list           {:7.1} ms",
        time(10, || links::list(c))?
    );
    println!(
        "audit first page     {:7.1} ms",
        time(10, || audit::query(c, &AuditFilter::default(), None, 200))?
    );
    println!(
        "audit device filter  {:7.1} ms",
        time(10, || {
            audit::query(
                c,
                &AuditFilter {
                    device: Some("core-1".into()),
                    ..Default::default()
                },
                None,
                200,
            )
        })?
    );
    println!(
        "audit facets         {:7.1} ms",
        time(10, || audit::facets(c))?
    );
    let json_bytes = serde_json::to_vec(&snap)?.len();
    println!("snapshot JSON        {:7.1} KB", json_bytes as f64 / 1024.0);
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::args()
        .nth(1)
        .ok_or("usage: seed_scale <vault dir> (password on stdin)")?;
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    let password = SecretString::new(line.trim_end_matches(['\r', '\n']).to_string());
    let mut vault = Vault::new(dir);
    let t = Instant::now();
    match vault.status() {
        VaultStatus::Uninitialized => vault.setup(&password)?,
        _ => vault.unlock(&password)?,
    }
    println!(
        "unlock               {:7.1} ms",
        t.elapsed().as_secs_f64() * 1000.0
    );
    let empty = vault.with_conn(|c| Ok(devices::list(c)?.is_empty()))?;
    if empty {
        let t = Instant::now();
        vault.with_conn(seed)?;
        println!("seeding              {:7.1} s", t.elapsed().as_secs_f64());
    }
    vault.with_conn(report)?;
    Ok(())
}
