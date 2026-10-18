//! User-defined custom fields for devices.

use super::{gone, record, unique, validate};
use crate::audit;
use crate::error::CoreError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FieldKind {
    Text,
    Number,
    Select,
    MultiSelect,
    Date,
    Url,
    Ip,
    Boolean,
}

impl FieldKind {
    fn as_str(self) -> &'static str {
        match self {
            FieldKind::Text => "text",
            FieldKind::Number => "number",
            FieldKind::Select => "select",
            FieldKind::MultiSelect => "multi-select",
            FieldKind::Date => "date",
            FieldKind::Url => "url",
            FieldKind::Ip => "ip",
            FieldKind::Boolean => "boolean",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "text" => FieldKind::Text,
            "number" => FieldKind::Number,
            "select" => FieldKind::Select,
            "multi-select" => FieldKind::MultiSelect,
            "date" => FieldKind::Date,
            "url" => FieldKind::Url,
            "ip" => FieldKind::Ip,
            "boolean" => FieldKind::Boolean,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomField {
    #[serde(default)]
    pub id: i64,
    /// Stable key used in device data (`asset_tag`); derived from the label when empty.
    #[serde(default)]
    pub key: String,
    pub label: String,
    pub kind: FieldKind,
    /// Choices for select / multi-select.
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub position: i64,
}

const COLS: &str = "SELECT id, key, label, kind, options, position FROM custom_fields";

fn row(r: &Row<'_>) -> rusqlite::Result<CustomField> {
    let kind: String = r.get(3)?;
    Ok(CustomField {
        id: r.get(0)?,
        key: r.get(1)?,
        label: r.get(2)?,
        kind: FieldKind::parse(&kind).unwrap_or(FieldKind::Text),
        options: super::json_col(r, 4)?,
        position: r.get(5)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<CustomField>, CoreError> {
    let mut stmt = conn.prepare(&format!("{COLS} ORDER BY position, id"))?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn get(conn: &Connection, id: i64) -> Result<Option<CustomField>, CoreError> {
    Ok(conn
        .query_row(&format!("{COLS} WHERE id = ?1"), [id], row)
        .optional()?)
}

/// `Asset tag` → `asset_tag`.
pub fn key_from_label(label: &str) -> String {
    let mut key = String::new();
    for c in label.trim().chars() {
        if c.is_ascii_alphanumeric() {
            key.push(c.to_ascii_lowercase());
        } else if !key.ends_with('_') && !key.is_empty() {
            key.push('_');
        }
    }
    key.trim_end_matches('_').to_owned()
}

fn clean(f: &CustomField) -> Result<CustomField, CoreError> {
    let label = validate::name(&f.label, "field name", 64)?;
    let key = if f.key.trim().is_empty() {
        key_from_label(&label)
    } else {
        f.key.trim().to_owned()
    };
    if key.is_empty()
        || key.len() > 64
        || !key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(CoreError::Validation(
            "The field key may only use a–z, 0–9 and _.".into(),
        ));
    }
    let mut options = Vec::new();
    for o in &f.options {
        let o = validate::name(o, "option", 100)?;
        if !options.contains(&o) {
            options.push(o);
        }
    }
    let needs_options = matches!(f.kind, FieldKind::Select | FieldKind::MultiSelect);
    if needs_options && options.is_empty() {
        return Err(CoreError::Validation(
            "Add at least one option for a select field.".into(),
        ));
    }
    if !needs_options {
        options.clear();
    }
    Ok(CustomField {
        id: f.id,
        key,
        label,
        kind: f.kind,
        options,
        position: f.position,
    })
}

pub fn save(conn: &Connection, input: &CustomField) -> Result<CustomField, CoreError> {
    let v = clean(input)?;
    let now = audit::now();
    let tx = conn.unchecked_transaction()?;
    let dup = || format!("A field with the key {} already exists.", v.key);
    let options = serde_json::to_string(&v.options)?;
    let (old, id) = if v.id == 0 {
        let position: i64 = tx.query_row(
            "SELECT coalesce(max(position), -1) + 1 FROM custom_fields",
            [],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO custom_fields (key, label, kind, options, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![v.key, v.label, v.kind.as_str(), options, position, now],
        )
        .map_err(|e| unique(e, dup))?;
        (None, tx.last_insert_rowid())
    } else {
        let old = get(&tx, v.id)?.ok_or_else(|| gone("field"))?;
        if old.key != v.key || old.kind != v.kind {
            return Err(CoreError::Validation(
                "A field's key and type cannot change; create a new field instead.".into(),
            ));
        }
        tx.execute(
            "UPDATE custom_fields SET label = ?2, options = ?3, position = ?4, updated_at = ?5
             WHERE id = ?1",
            params![v.id, v.label, options, v.position, now],
        )?;
        (Some(old), v.id)
    };
    let saved = get(&tx, id)?.ok_or_else(|| gone("field"))?;
    record(
        &tx,
        "custom_field",
        id,
        &saved.label,
        old.as_ref(),
        Some(&saved),
    )?;
    tx.commit()?;
    Ok(saved)
}

/// Delete a field and its values on every device.
pub fn delete(conn: &Connection, id: i64) -> Result<(), CoreError> {
    let tx = conn.unchecked_transaction()?;
    let old = get(&tx, id)?.ok_or_else(|| gone("field"))?;
    tx.execute("DELETE FROM custom_fields WHERE id = ?1", [id])?;
    let rows: Vec<(i64, String)> = {
        let mut stmt = tx.prepare("SELECT id, custom FROM devices")?;
        let it = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<Result<_, _>>()?
    };
    for (device, custom) in rows {
        let mut map: serde_json::Map<String, Value> = serde_json::from_str(&custom)?;
        if map.remove(&old.key).is_some() {
            tx.execute(
                "UPDATE devices SET custom = ?2 WHERE id = ?1",
                params![device, serde_json::to_string(&map)?],
            )?;
        }
    }
    record(&tx, "custom_field", id, &old.label, Some(&old), None)?;
    tx.commit()?;
    Ok(())
}

/// Validate one value for a field; returns the normalized value (`Null` = unset).
pub fn check_value(field: &CustomField, value: &Value) -> Result<Value, CoreError> {
    let bad = |what: &str| Err(CoreError::Validation(format!("{}: {what}", field.label)));
    if value.is_null() || value.as_str().is_some_and(|s| s.trim().is_empty()) {
        return Ok(Value::Null);
    }
    match field.kind {
        FieldKind::Text => match value.as_str() {
            Some(s) if s.chars().count() <= 2000 => Ok(Value::String(s.trim().to_owned())),
            _ => bad("enter text up to 2000 characters."),
        },
        FieldKind::Number => match value.as_f64() {
            Some(n) if n.is_finite() => Ok(value.clone()),
            _ => bad("enter a number."),
        },
        FieldKind::Boolean => match value.as_bool() {
            Some(_) => Ok(value.clone()),
            None => bad("must be yes or no."),
        },
        FieldKind::Date => match value.as_str() {
            Some(s) if chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok() => {
                Ok(value.clone())
            }
            _ => bad("enter a date as YYYY-MM-DD."),
        },
        FieldKind::Url => match value.as_str().map(validate::web_url) {
            Some(Ok(u)) => Ok(Value::String(u)),
            _ => bad("enter an http:// or https:// address."),
        },
        FieldKind::Ip => match value.as_str().map(|s| validate::ip_or_empty(s, "address")) {
            Some(Ok(ip)) => Ok(Value::String(ip)),
            _ => bad("enter a valid IPv4 or IPv6 address."),
        },
        FieldKind::Select => match value.as_str() {
            Some(s) if field.options.iter().any(|o| o == s) => Ok(value.clone()),
            _ => bad("choose one of the options."),
        },
        FieldKind::MultiSelect => {
            let Some(items) = value.as_array() else {
                return bad("choose from the options.");
            };
            let mut out = Vec::new();
            for item in items {
                match item.as_str() {
                    Some(s) if field.options.iter().any(|o| o == s) => {
                        if !out.contains(&Value::String(s.to_owned())) {
                            out.push(Value::String(s.to_owned()));
                        }
                    }
                    _ => return bad("choose from the options."),
                }
            }
            Ok(if out.is_empty() {
                Value::Null
            } else {
                Value::Array(out)
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil;
    use super::*;
    use serde_json::json;

    fn field(label: &str, kind: FieldKind, options: &[&str]) -> CustomField {
        CustomField {
            id: 0,
            key: String::new(),
            label: label.into(),
            kind,
            options: options.iter().map(|s| (*s).to_owned()).collect(),
            position: 0,
        }
    }

    #[test]
    fn keys_are_derived_and_unique() {
        assert_eq!(key_from_label(" Asset Tag #"), "asset_tag");
        let c = testutil::conn();
        let f = save(&c, &field("Asset tag", FieldKind::Text, &[])).expect("save");
        assert_eq!(f.key, "asset_tag");
        assert!(save(&c, &field("Asset-tag", FieldKind::Number, &[])).is_err());
        let g = save(
            &c,
            &field("Owner", FieldKind::Select, &["NetOps", "SecOps"]),
        )
        .expect("g");
        assert_eq!(g.position, 1);
        assert!(save(&c, &field("Empty", FieldKind::Select, &[])).is_err());
        let mut changed = f.clone();
        changed.kind = FieldKind::Number;
        assert!(save(&c, &changed).is_err());
    }

    #[test]
    fn values_are_checked_by_kind() {
        let sel = field("Owner", FieldKind::Select, &["NetOps"]);
        assert_eq!(
            check_value(&sel, &json!("NetOps")).expect("ok"),
            json!("NetOps")
        );
        assert!(check_value(&sel, &json!("Other")).is_err());
        let multi = field("Roles", FieldKind::MultiSelect, &["core", "edge"]);
        assert_eq!(
            check_value(&multi, &json!(["core", "core"])).expect("ok"),
            json!(["core"])
        );
        assert!(check_value(&multi, &json!(["x"])).is_err());
        let n = field("Ports", FieldKind::Number, &[]);
        assert!(check_value(&n, &json!(48)).is_ok());
        assert!(check_value(&n, &json!("48")).is_err());
        let d = field("Warranty", FieldKind::Date, &[]);
        assert!(check_value(&d, &json!("2027-02-30")).is_err());
        assert!(check_value(&d, &json!("2027-02-28")).is_ok());
        let ip = field("OOB", FieldKind::Ip, &[]);
        assert_eq!(
            check_value(&ip, &json!("2001:DB8::1")).expect("ip"),
            json!("2001:db8::1")
        );
        assert_eq!(check_value(&ip, &json!("  ")).expect("empty"), Value::Null);
        let b = field("PoE", FieldKind::Boolean, &[]);
        assert!(check_value(&b, &json!(true)).is_ok());
        assert!(check_value(&b, &json!("yes")).is_err());
    }
}
