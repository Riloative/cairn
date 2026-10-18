//! Application metadata commands.

use serde::Serialize;

/// Static information about the running app, mirrored by `AppInfo` in `ui/src/lib/ipc.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
}

impl AppInfo {
    pub fn current() -> Self {
        Self {
            name: cairn_core::APP_NAME,
            version: env!("CARGO_PKG_VERSION"),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        }
    }
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo::current()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_current_build() {
        let info = app_info();
        assert_eq!(info.name, "Cairn");
        assert_eq!(info.version, cairn_core::VERSION);
        assert!(!info.os.is_empty() && !info.arch.is_empty());
    }

    #[test]
    fn serializes_with_the_fields_the_frontend_expects() {
        let json = serde_json::to_value(AppInfo::current()).expect("serializable");
        for key in ["name", "version", "os", "arch"] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
    }
}
