//! Inventory commands: thin wrappers over `cairn_core::inventory`. Every mutation is
//! validated and audited in core; the frontend refreshes its snapshot afterwards.

use crate::error::CommandResult;
use crate::state::AppState;
use cairn_core::inventory::credentials::{self, CredentialInput, CredentialProfile, SecretField};
use cairn_core::inventory::devices::{self, Device, SaveResult};
use cairn_core::inventory::interfaces::{self, BulkResult, Interface};
use cairn_core::inventory::locations::{self, Building, Floor, LocationKind, Rack, Room, Site};
use cairn_core::inventory::{
    self as inv, fields, views, vlans, CustomField, SavedView, Snapshot, Vlan,
};
use cairn_core::CoreError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use zeroize::Zeroizing;

/// Copied secrets are removed from the clipboard after this long (SPEC §9).
pub const CLIPBOARD_CLEAR: Duration = Duration::from_secs(30);

fn with<T>(
    state: &AppState,
    f: impl FnOnce(&Connection) -> Result<T, CoreError>,
) -> CommandResult<T> {
    Ok(state.vault.lock().with_conn(f)?)
}

#[tauri::command]
pub fn inventory_snapshot(state: State<'_, AppState>) -> CommandResult<Snapshot> {
    with(&state, inv::snapshot)
}

/// Any location, tagged by kind.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LocationInput {
    Site(Site),
    Building(Building),
    Floor(Floor),
    Room(Room),
    Rack(Rack),
}

#[tauri::command]
pub fn location_save(
    state: State<'_, AppState>,
    location: LocationInput,
) -> CommandResult<LocationInput> {
    with(&state, |c| {
        Ok(match location {
            LocationInput::Site(v) => LocationInput::Site(locations::save_site(c, &v)?),
            LocationInput::Building(v) => LocationInput::Building(locations::save_building(c, &v)?),
            LocationInput::Floor(v) => LocationInput::Floor(locations::save_floor(c, &v)?),
            LocationInput::Room(v) => LocationInput::Room(locations::save_room(c, &v)?),
            LocationInput::Rack(v) => LocationInput::Rack(locations::save_rack(c, &v)?),
        })
    })
}

#[tauri::command]
pub fn location_delete(
    state: State<'_, AppState>,
    kind: LocationKind,
    id: i64,
) -> CommandResult<()> {
    with(&state, |c| locations::delete(c, kind, id))
}

#[tauri::command]
pub fn vendor_add(state: State<'_, AppState>, name: String) -> CommandResult<String> {
    with(&state, |c| inv::add_vendor(c, &name))
}

#[tauri::command]
pub fn device_save(state: State<'_, AppState>, device: Device) -> CommandResult<SaveResult> {
    with(&state, |c| devices::save(c, &device))
}

#[tauri::command]
pub fn device_delete(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    with(&state, |c| devices::delete(c, id))
}

#[tauri::command]
pub fn device_duplicate(state: State<'_, AppState>, id: i64) -> CommandResult<SaveResult> {
    with(&state, |c| devices::duplicate(c, id))
}

#[tauri::command]
pub fn interfaces_list(
    state: State<'_, AppState>,
    device_id: i64,
) -> CommandResult<Vec<Interface>> {
    with(&state, |c| interfaces::list(c, device_id))
}

#[tauri::command]
pub fn interface_save(
    state: State<'_, AppState>,
    interface: Interface,
) -> CommandResult<Interface> {
    with(&state, |c| interfaces::save(c, &interface))
}

#[tauri::command]
pub fn interfaces_bulk_create(
    state: State<'_, AppState>,
    device_id: i64,
    pattern: String,
    template: Interface,
) -> CommandResult<BulkResult> {
    with(&state, |c| {
        interfaces::bulk_create(c, device_id, &pattern, &template)
    })
}

#[tauri::command]
pub fn interfaces_delete(
    state: State<'_, AppState>,
    device_id: i64,
    ids: Vec<i64>,
) -> CommandResult<usize> {
    with(&state, |c| interfaces::delete(c, device_id, &ids))
}

/// Preview a bulk-create pattern (names only, nothing saved).
#[tauri::command]
pub fn interfaces_expand(pattern: String) -> CommandResult<Vec<String>> {
    Ok(inv::ifrange::expand(&pattern)?)
}

#[tauri::command]
pub fn vlan_save(state: State<'_, AppState>, vlan: Vlan) -> CommandResult<Vlan> {
    with(&state, |c| vlans::save(c, &vlan))
}

#[tauri::command]
pub fn vlan_delete(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    with(&state, |c| vlans::delete(c, id))
}

#[tauri::command]
pub fn field_save(state: State<'_, AppState>, field: CustomField) -> CommandResult<CustomField> {
    with(&state, |c| fields::save(c, &field))
}

#[tauri::command]
pub fn field_delete(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    with(&state, |c| fields::delete(c, id))
}

#[tauri::command]
pub fn view_save(state: State<'_, AppState>, view: SavedView) -> CommandResult<SavedView> {
    with(&state, |c| views::save(c, &view))
}

#[tauri::command]
pub fn view_delete(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    with(&state, |c| views::delete(c, id))
}

/// Create or update a profile. Secret values arrive only when the user typed them.
#[tauri::command]
pub fn credential_save(
    state: State<'_, AppState>,
    credential: CredentialInput,
) -> CommandResult<CredentialProfile> {
    with(&state, |c| credentials::save(c, &credential))
}

#[tauri::command]
pub fn credential_delete(state: State<'_, AppState>, id: i64) -> CommandResult<()> {
    with(&state, |c| credentials::delete(c, id))
}

/// Show a secret on explicit request. Audited as `credential_revealed`.
#[tauri::command]
pub fn credential_reveal(
    state: State<'_, AppState>,
    id: i64,
    field: SecretField,
) -> CommandResult<String> {
    let secret = with(&state, |c| credentials::reveal(c, id, field))?;
    Ok(secret.expose().to_owned())
}

fn digest(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}

/// Copy a secret to the clipboard from Rust (the value never reaches the webview) and
/// clear it after [`CLIPBOARD_CLEAR`] unless something else was copied meanwhile.
/// Audited as `credential_copied`.
#[tauri::command]
pub fn credential_copy<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    id: i64,
    field: SecretField,
) -> CommandResult<()> {
    let secret = with(&state, |c| credentials::for_copy(c, id, field))?;
    app.clipboard()
        .write_secret(secret.expose())
        .map_err(|e| crate::error::CommandError::internal(format!("clipboard: {e}")))?;
    // Only a hash is kept to recognize our value later.
    let hash = digest(secret.expose());
    drop(secret);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLIPBOARD_CLEAR).await;
        let current = app.clipboard().read_text().map(Zeroizing::new);
        if matches!(&current, Ok(text) if digest(text) == hash) {
            // Best effort: the clipboard may be unavailable (e.g. session ending).
            let _ = app.clipboard().clear();
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locations_are_tagged_by_kind() {
        let json = r#"{"kind":"rack","floorId":3,"name":"R1","heightU":42}"#;
        let parsed: LocationInput = serde_json::from_str(json).expect("parse");
        assert!(matches!(
            parsed,
            LocationInput::Rack(Rack {
                floor_id: 3,
                height_u: 42,
                ..
            })
        ));
        let out = serde_json::to_value(&parsed).expect("ser");
        assert_eq!(out["kind"], "rack");
        assert_eq!(out["roomId"], serde_json::Value::Null);
    }

    #[test]
    fn credential_input_defaults_to_keeping_secrets() {
        let json = r#"{"name":"Lab","password":{"action":"set","value":"x"},"enableSecret":{"action":"clear"}}"#;
        let i: CredentialInput = serde_json::from_str(json).expect("parse");
        assert!(matches!(i.key_data, credentials::SecretUpdate::Keep));
        assert!(matches!(i.enable_secret, credentials::SecretUpdate::Clear));
    }
}
