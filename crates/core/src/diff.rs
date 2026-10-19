//! Field-level diffs between two serializable values, used in audit entries.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One changed field. Paths use dots for nested objects (e.g. `ssh.port`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldChange {
    pub field: String,
    pub old: Value,
    pub new: Value,
}

/// Compare two values and list the fields that differ. Objects are compared key by key
/// (recursively); anything else is compared as a whole.
pub fn diff_values(old: &Value, new: &Value) -> Vec<FieldChange> {
    let mut out = Vec::new();
    walk("", old, new, &mut out);
    out
}

/// Serialize both values and diff them.
pub fn diff<T: Serialize>(old: &T, new: &T) -> Result<Vec<FieldChange>, serde_json::Error> {
    Ok(diff_values(
        &serde_json::to_value(old)?,
        &serde_json::to_value(new)?,
    ))
}

fn walk(prefix: &str, old: &Value, new: &Value, out: &mut Vec<FieldChange>) {
    match (old, new) {
        (Value::Object(a), Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
            keys.sort();
            keys.dedup();
            for k in keys {
                let path = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                walk(
                    &path,
                    a.get(k).unwrap_or(&Value::Null),
                    b.get(k).unwrap_or(&Value::Null),
                    out,
                );
            }
        }
        _ if old != new => out.push(FieldChange {
            field: prefix.to_owned(),
            old: old.clone(),
            new: new.clone(),
        }),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reports_changed_added_and_removed_fields() {
        let old = json!({"a": 1, "b": {"c": 2, "d": 3}, "gone": true});
        let new = json!({"a": 1, "b": {"c": 5, "d": 3}, "added": "x"});
        let d = diff_values(&old, &new);
        let fields: Vec<&str> = d.iter().map(|c| c.field.as_str()).collect();
        assert_eq!(fields, ["added", "b.c", "gone"]);
        assert_eq!(d[1].old, json!(2));
        assert_eq!(d[1].new, json!(5));
        assert_eq!(d[2].new, Value::Null);
    }

    #[test]
    fn identical_values_have_no_diff() {
        let v = json!({"x": [1, 2], "y": null});
        assert!(diff_values(&v, &v).is_empty());
    }

    #[test]
    fn arrays_compare_as_a_whole() {
        let d = diff_values(&json!({"vlans": [1, 2]}), &json!({"vlans": [1, 3]}));
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].field, "vlans");
    }
}
