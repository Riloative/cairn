//! Discovery of local development containers (Linux) for quick-launch shell entries.
//!
//! Podman is the source of truth (`podman ps -a --format json`); Toolbox and Distrobox
//! containers are recognised by their labels. `distrobox list` is consulted as well so
//! Docker-backed Distrobox containers appear too.

use crate::shell::ShellSpec;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerKind {
    Toolbox,
    Distrobox,
    Podman,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub name: String,
    pub kind: ContainerKind,
    pub image: String,
    pub running: bool,
}

impl Container {
    /// How to open a shell inside this container.
    pub fn shell_spec(&self) -> ShellSpec {
        let (program, args): (&str, Vec<String>) = match self.kind {
            ContainerKind::Toolbox => ("toolbox", vec!["enter".into(), self.name.clone()]),
            ContainerKind::Distrobox => ("distrobox", vec!["enter".into(), self.name.clone()]),
            ContainerKind::Podman => (
                "podman",
                vec![
                    "exec".into(),
                    "-it".into(),
                    self.name.clone(),
                    "sh".into(),
                    "-c".into(),
                    "exec \"$(command -v bash || command -v sh)\" -l".into(),
                ],
            ),
        };
        ShellSpec {
            program: Some(program.into()),
            args,
            ..Default::default()
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct PodmanPs {
    #[serde(default)]
    names: Vec<String>,
    #[serde(default)]
    image: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    labels: Option<std::collections::HashMap<String, String>>,
}

/// Parse `podman ps -a --format json`.
pub fn parse_podman(json: &str) -> Vec<Container> {
    let Ok(rows) = serde_json::from_str::<Vec<PodmanPs>>(json) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|r| {
            let name = r.names.into_iter().next()?;
            let labels = r.labels.unwrap_or_default();
            let kind = if labels.contains_key("com.github.containers.toolbox") {
                ContainerKind::Toolbox
            } else if labels.get("manager").map(String::as_str) == Some("distrobox") {
                ContainerKind::Distrobox
            } else {
                ContainerKind::Podman
            };
            Some(Container {
                name,
                kind,
                image: r.image,
                running: r.state.eq_ignore_ascii_case("running"),
            })
        })
        .collect()
}

/// Parse `distrobox list --no-color` (`ID | NAME | STATUS | IMAGE`).
pub fn parse_distrobox(text: &str) -> Vec<Container> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let cols: Vec<&str> = line.split('|').map(str::trim).collect();
            let [_, name, status, image] = cols.as_slice() else {
                return None;
            };
            if name.is_empty() {
                return None;
            }
            Some(Container {
                name: (*name).to_owned(),
                kind: ContainerKind::Distrobox,
                image: (*image).to_owned(),
                running: status.starts_with("Up"),
            })
        })
        .collect()
}

/// Merge sources, keeping the first entry per name, sorted by kind then name.
pub fn merge(sources: impl IntoIterator<Item = Vec<Container>>) -> Vec<Container> {
    let mut out: Vec<Container> = Vec::new();
    for c in sources.into_iter().flatten() {
        if !out.iter().any(|o| o.name == c.name) {
            out.push(c);
        }
    }
    out.sort_by(|a, b| (a.kind as u8, &a.name).cmp(&(b.kind as u8, &b.name)));
    out
}

/// Run a command and return stdout, or `None` if it is missing, fails or times out.
fn run(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

/// Detect containers on this machine. Always empty on macOS.
pub fn detect() -> Vec<Container> {
    if !cfg!(target_os = "linux") {
        return Vec::new();
    }
    let timeout = Duration::from_secs(3);
    let podman = run("podman", &["ps", "-a", "--format", "json"], timeout)
        .map(|s| parse_podman(&s))
        .unwrap_or_default();
    let distrobox = run("distrobox", &["list", "--no-color"], timeout)
        .map(|s| parse_distrobox(&s))
        .unwrap_or_default();
    merge([podman, distrobox])
}

#[cfg(test)]
mod tests {
    use super::*;

    const PODMAN: &str = r#"[
      {"Names":["fedora-toolbox-40"],"Image":"registry.fedoraproject.org/fedora-toolbox:40","State":"exited",
       "Labels":{"com.github.containers.toolbox":"true"}},
      {"Names":["deb"],"Image":"docker.io/library/debian:12","State":"running",
       "Labels":{"manager":"distrobox"}},
      {"Names":["nginx"],"Image":"docker.io/library/nginx","State":"running","Labels":null}
    ]"#;

    const DISTROBOX: &str = "ID           | NAME | STATUS             | IMAGE\n\
        1a2b3c4d5e6f | deb  | Up 2 hours         | docker.io/library/debian:12\n\
        6f5e4d3c2b1a | arch | Exited (0) 3 days  | quay.io/toolbx/arch-toolbox\n";

    #[test]
    fn classifies_podman_containers_by_label() {
        let c = parse_podman(PODMAN);
        assert_eq!(c.len(), 3);
        assert_eq!(c[0].kind, ContainerKind::Toolbox);
        assert!(!c[0].running);
        assert_eq!(c[1].kind, ContainerKind::Distrobox);
        assert_eq!(c[2].kind, ContainerKind::Podman);
        assert!(c[2].running);
    }

    #[test]
    fn parses_distrobox_list() {
        let c = parse_distrobox(DISTROBOX);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].name, "deb");
        assert!(c[0].running);
        assert!(!c[1].running);
    }

    #[test]
    fn tolerates_garbage() {
        assert!(parse_podman("not json").is_empty());
        assert!(parse_distrobox("").is_empty());
        assert!(parse_distrobox("header\nno pipes here").is_empty());
    }

    #[test]
    fn merge_dedupes_and_sorts() {
        let all = merge([parse_podman(PODMAN), parse_distrobox(DISTROBOX)]);
        let names: Vec<&str> = all.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["fedora-toolbox-40", "arch", "deb", "nginx"]);
    }

    #[test]
    fn launch_commands() {
        let c = parse_podman(PODMAN);
        assert_eq!(c[0].shell_spec().program.as_deref(), Some("toolbox"));
        assert_eq!(c[0].shell_spec().args, ["enter", "fedora-toolbox-40"]);
        assert_eq!(c[1].shell_spec().args, ["enter", "deb"]);
        assert_eq!(c[2].shell_spec().args[..3], ["exec", "-it", "nginx"]);
    }

    #[test]
    fn run_handles_missing_programs() {
        assert!(run("definitely-not-a-real-program", &[], Duration::from_secs(1)).is_none());
    }
}
