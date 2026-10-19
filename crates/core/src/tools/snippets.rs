//! Snippet library: saved commands organized by folder and vendor, with variables that
//! are asked for when the snippet is inserted (`{{name}}` or `{{name:default}}`).

use crate::audit;
use crate::error::CoreError;
use crate::inventory::validate;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    /// "/"-separated folder path; empty for the top level.
    #[serde(default)]
    pub folder: String,
    /// Vendor the snippet is meant for; empty for any device.
    #[serde(default)]
    pub vendor: String,
    pub body: String,
    #[serde(default)]
    pub description: String,
    /// Variables in order of first use (derived from `body`, never stored).
    #[serde(default)]
    pub variables: Vec<Variable>,
}

/// A `{{name}}` / `{{name:default}}` placeholder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub name: String,
    pub default: String,
}

const MAX_BODY: usize = 64 * 1024;
const COLS: &str = "SELECT id, name, folder, vendor, body, description FROM snippets";

fn row(r: &Row<'_>) -> rusqlite::Result<Snippet> {
    let body: String = r.get(4)?;
    Ok(Snippet {
        id: r.get(0)?,
        name: r.get(1)?,
        folder: r.get(2)?,
        vendor: r.get(3)?,
        variables: variables(&body).unwrap_or_default(),
        body,
        description: r.get(5)?,
    })
}

fn is_name_char(c: char, first: bool) -> bool {
    c.is_ascii_alphabetic() || c == '_' || (!first && (c.is_ascii_digit() || c == '-'))
}

/// The placeholders in `body`, in order of first appearance. A malformed placeholder
/// (`{{` without a valid name and `}}`) is an error, so typos are caught on save.
pub fn variables(body: &str) -> Result<Vec<Variable>, CoreError> {
    let mut out: Vec<Variable> = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let end = after.find("}}").ok_or_else(|| {
            CoreError::Validation("A variable is missing its closing \"}}\".".into())
        })?;
        let inner = &after[..end];
        let (name, default) = match inner.split_once(':') {
            Some((n, d)) => (n.trim(), d),
            None => (inner.trim(), ""),
        };
        let valid = name
            .chars()
            .enumerate()
            .all(|(i, c)| is_name_char(c, i == 0))
            && !name.is_empty()
            && name.len() <= 64;
        if !valid {
            return Err(CoreError::Validation(format!(
                "\"{{{{{inner}}}}}\" is not a valid variable. Use {{{{name}}}} or {{{{name:default}}}} with letters, digits, '-' and '_'."
            )));
        }
        if !out.iter().any(|v| v.name == name) {
            out.push(Variable {
                name: name.to_owned(),
                default: default.to_owned(),
            });
        }
        rest = &after[end + 2..];
    }
    Ok(out)
}

/// Replace placeholders with `values` (missing ones fall back to their default).
pub fn render(body: &str, values: &[(String, String)]) -> Result<String, CoreError> {
    variables(body)?;
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        // Checked by `variables` above.
        let end = after.find("}}").unwrap_or(after.len());
        let inner = &after[..end];
        let (name, default) = inner.split_once(':').unwrap_or((inner, ""));
        let name = name.trim();
        let value = values
            .iter()
            .find(|(n, _)| n == name)
            .map_or(default, |(_, v)| v.as_str());
        out.push_str(value);
        rest = after.get(end + 2..).unwrap_or("");
    }
    out.push_str(rest);
    Ok(out)
}

fn clean_folder(folder: &str) -> Result<String, CoreError> {
    let parts: Vec<&str> = folder
        .split('/')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    let joined = parts.join("/");
    if joined.chars().count() > 200 || joined.chars().any(char::is_control) {
        return Err(CoreError::Validation(
            "The folder name is too long or contains control characters.".into(),
        ));
    }
    Ok(joined)
}

fn clean(s: &Snippet) -> Result<Snippet, CoreError> {
    let body = s.body.replace("\r\n", "\n");
    if body.trim().is_empty() {
        return Err(CoreError::Validation(
            "Enter the command(s) to insert.".into(),
        ));
    }
    if body.len() > MAX_BODY {
        return Err(CoreError::Validation(
            "A snippet can be up to 64 KB.".into(),
        ));
    }
    Ok(Snippet {
        id: s.id,
        name: validate::name(&s.name, "snippet name", 120)?,
        folder: clean_folder(&s.folder)?,
        vendor: validate::text(&s.vendor, "vendor", 64)?,
        variables: variables(&body)?,
        body,
        description: validate::text(&s.description, "description", 1000)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Snippet>, CoreError> {
    let mut stmt = conn.prepare(&format!("{COLS} ORDER BY folder, name COLLATE NOCASE"))?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn get(conn: &Connection, id: i64) -> Result<Option<Snippet>, CoreError> {
    Ok(conn
        .query_row(&format!("{COLS} WHERE id = ?1"), [id], row)
        .optional()?)
}

pub fn save(conn: &Connection, input: &Snippet) -> Result<Snippet, CoreError> {
    let s = clean(input)?;
    let now = audit::now();
    let dup = |e: rusqlite::Error| match e {
        rusqlite::Error::SqliteFailure(f, _)
            if f.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            CoreError::Validation(format!(
                "A snippet named \"{}\" already exists in this folder.",
                s.name
            ))
        }
        e => CoreError::Database(e),
    };
    let id = if s.id == 0 {
        conn.execute(
            "INSERT INTO snippets (name, folder, vendor, body, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![s.name, s.folder, s.vendor, s.body, s.description, now],
        )
        .map_err(dup)?;
        conn.last_insert_rowid()
    } else {
        let n = conn
            .execute(
                "UPDATE snippets SET name = ?2, folder = ?3, vendor = ?4, body = ?5,
                 description = ?6, updated_at = ?7 WHERE id = ?1",
                params![s.id, s.name, s.folder, s.vendor, s.body, s.description, now],
            )
            .map_err(dup)?;
        if n == 0 {
            return Err(CoreError::Validation(
                "This snippet no longer exists.".into(),
            ));
        }
        s.id
    };
    get(conn, id)?.ok_or_else(|| CoreError::Validation("The snippet was not saved.".into()))
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), CoreError> {
    conn.execute("DELETE FROM snippets WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snippet(name: &str, body: &str) -> Snippet {
        Snippet {
            id: 0,
            name: name.into(),
            folder: " Cisco / Interfaces ".into(),
            vendor: "Cisco".into(),
            body: body.into(),
            description: String::new(),
            variables: vec![],
        }
    }

    #[test]
    fn parses_variables_in_order_without_duplicates() {
        let vars = variables("interface {{iface}}\n description {{desc:uplink}}\n! {{iface}}")
            .expect("vars");
        assert_eq!(
            vars,
            vec![
                Variable {
                    name: "iface".into(),
                    default: String::new()
                },
                Variable {
                    name: "desc".into(),
                    default: "uplink".into()
                },
            ]
        );
        assert!(variables("show {{ }}").is_err());
        assert!(variables("show {{1x}}").is_err());
        assert!(variables("show {{open").is_err());
        assert!(variables("no variables here { } }}")
            .expect("plain")
            .is_empty());
    }

    #[test]
    fn renders_values_and_defaults() {
        let out = render(
            "int {{iface}}\n desc {{desc:uplink}}\n vlan {{vlan:1}}",
            &[
                ("iface".into(), "Gi1/0/1".into()),
                ("vlan".into(), "20".into()),
            ],
        )
        .expect("render");
        assert_eq!(out, "int Gi1/0/1\n desc uplink\n vlan 20");
    }

    #[test]
    fn crud_and_validation() {
        let c = crate::inventory::testutil::conn();
        let starters = list(&c).expect("list").len();
        let s = save(
            &c,
            &snippet(
                "Set description",
                "interface {{iface}}\r\n description {{text}}",
            ),
        )
        .expect("save");
        assert_eq!(s.folder, "Cisco/Interfaces");
        assert_eq!(s.body, "interface {{iface}}\n description {{text}}");
        assert_eq!(s.variables.len(), 2);
        assert!(
            save(&c, &snippet("Set description", "x")).is_err(),
            "duplicate name"
        );
        assert!(save(&c, &snippet("Empty", "  ")).is_err());
        assert!(save(&c, &snippet("Broken", "show {{")).is_err());
        let renamed = save(
            &c,
            &Snippet {
                name: "Describe".into(),
                ..s.clone()
            },
        )
        .expect("update");
        assert_eq!(renamed.id, s.id);
        delete(&c, s.id).expect("delete");
        assert_eq!(list(&c).expect("list").len(), starters);
    }
}
