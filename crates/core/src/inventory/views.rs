//! Saved inventory table views (filters, grouping, sorting, columns). The state is an
//! opaque JSON document owned by the frontend; it is size-limited and not audited.

use super::{gone, unique, validate};
use crate::audit;
use crate::error::CoreError;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_STATE: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedView {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    pub state: Value,
}

fn row(r: &Row<'_>) -> rusqlite::Result<SavedView> {
    Ok(SavedView {
        id: r.get(0)?,
        name: r.get(1)?,
        state: super::json_col(r, 2)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<SavedView>, CoreError> {
    let mut stmt =
        conn.prepare("SELECT id, name, state FROM saved_views ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn save(conn: &Connection, input: &SavedView) -> Result<SavedView, CoreError> {
    let name = validate::name(&input.name, "view name", 64)?;
    if !input.state.is_object() {
        return Err(CoreError::Validation("The view state is invalid.".into()));
    }
    let state = serde_json::to_string(&input.state)?;
    if state.len() > MAX_STATE {
        return Err(CoreError::Validation(
            "The view is too large to save.".into(),
        ));
    }
    let now = audit::now();
    let dup = || format!("A view named {name} already exists.");
    let id = if input.id == 0 {
        conn.execute(
            "INSERT INTO saved_views (name, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![name, state, now],
        )
        .map_err(|e| unique(e, dup))?;
        conn.last_insert_rowid()
    } else {
        let n = conn
            .execute(
                "UPDATE saved_views SET name = ?2, state = ?3, updated_at = ?4 WHERE id = ?1",
                params![input.id, name, state, now],
            )
            .map_err(|e| unique(e, dup))?;
        if n == 0 {
            return Err(gone("view"));
        }
        input.id
    };
    Ok(SavedView {
        id,
        name,
        state: input.state.clone(),
    })
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), CoreError> {
    conn.execute("DELETE FROM saved_views WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::testutil;
    use super::*;
    use serde_json::json;

    #[test]
    fn views_round_trip() {
        let c = testutil::conn();
        let v = save(
            &c,
            &SavedView {
                id: 0,
                name: "Core switches".into(),
                state: json!({"groupBy": "building"}),
            },
        )
        .expect("save");
        assert_eq!(list(&c).expect("list"), std::slice::from_ref(&v));
        assert!(save(&c, &SavedView { id: 0, ..v.clone() }).is_err());
        assert!(save(
            &c,
            &SavedView {
                id: 0,
                name: "x".into(),
                state: json!([1])
            }
        )
        .is_err());
        delete(&c, v.id).expect("delete");
        assert!(list(&c).expect("list").is_empty());
    }
}
