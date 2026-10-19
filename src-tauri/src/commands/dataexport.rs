//! Readable inventory export (JSON or a folder of CSV files).

use crate::commands::vault::blocking;
use crate::error::CommandResult;
use crate::state::AppState;
use cairn_core::audit::AuditEvent;
use cairn_core::dataexport;
use cairn_core::CoreError;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataFormat {
    Json,
    Csv,
}

/// Export the inventory. For JSON `path` is the file; for CSV it is a new (or empty)
/// folder that receives one file per table. Returns the files written. Audited, and
/// marked when credentials (with their secrets) were included.
#[tauri::command]
pub async fn data_export(
    state: State<'_, AppState>,
    format: DataFormat,
    path: String,
    include_credentials: bool,
) -> CommandResult<Vec<String>> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(CoreError::Validation("Choose where to save the export.".into()).into());
    }
    if format == DataFormat::Csv
        && path
            .read_dir()
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
    {
        return Err(CoreError::Validation(
            "That folder is not empty. Choose a new folder name for the CSV files.".into(),
        )
        .into());
    }
    let vault = state.vault.clone();
    let target = path.clone();
    let files = blocking(move || {
        let data = vault.lock().with_conn(|c| {
            dataexport::collect(c, include_credentials, env!("CARGO_PKG_VERSION"))
        })?;
        Ok(match format {
            DataFormat::Json => {
                dataexport::write_json(&data, &target)?;
                vec![target]
            }
            DataFormat::Csv => dataexport::write_csv(&data, &target)?,
        })
    })
    .await?;
    state.audit.record(
        &state.vault,
        AuditEvent::DataExported {
            what: if include_credentials {
                "inventory with credentials and their secrets".into()
            } else {
                "inventory".into()
            },
            format: match format {
                DataFormat::Json => "json".into(),
                DataFormat::Csv => "csv".into(),
            },
            path: path.display().to_string(),
        },
    );
    Ok(files.iter().map(|p| p.display().to_string()).collect())
}
