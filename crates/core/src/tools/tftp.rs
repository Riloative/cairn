//! Saved TFTP server preferences (the server itself lives in `cairn-tftp`).

use crate::error::CoreError;
use crate::settings;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};

const KEY: &str = "tftp";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TftpPrefs {
    /// Folder served to clients; empty until the user picks one.
    pub root: String,
    /// Address to listen on ("0.0.0.0" = all IPv4 interfaces).
    pub bind_host: String,
    pub port: u16,
    pub allow_read: bool,
    pub allow_write: bool,
    pub overwrite: bool,
}

impl Default for TftpPrefs {
    fn default() -> Self {
        Self {
            root: String::new(),
            bind_host: "0.0.0.0".into(),
            // Port 69 needs privileges on Linux; 6969 works everywhere.
            port: if cfg!(target_os = "linux") { 6969 } else { 69 },
            allow_read: true,
            allow_write: false,
            overwrite: false,
        }
    }
}

impl TftpPrefs {
    pub fn bind_addr(&self) -> Result<SocketAddr, CoreError> {
        let ip: IpAddr = self
            .bind_host
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse()
            .map_err(|_| {
                CoreError::Validation(format!(
                    "{} is not an IP address of this computer.",
                    self.bind_host
                ))
            })?;
        if self.port == 0 {
            return Err(CoreError::Validation(
                "The port must be between 1 and 65535.".into(),
            ));
        }
        Ok(SocketAddr::new(ip, self.port))
    }

    pub fn validate(&self) -> Result<(), CoreError> {
        self.bind_addr()?;
        if self.root.trim().is_empty() {
            return Err(CoreError::Validation("Choose the folder to serve.".into()));
        }
        if !self.allow_read && !self.allow_write {
            return Err(CoreError::Validation(
                "Allow downloads, uploads or both.".into(),
            ));
        }
        Ok(())
    }
}

pub fn prefs(conn: &Connection) -> Result<TftpPrefs, CoreError> {
    settings::load_doc(conn, KEY)
}

pub fn save_prefs(conn: &Connection, prefs: &TftpPrefs) -> Result<TftpPrefs, CoreError> {
    prefs.bind_addr()?;
    settings::save_doc(conn, KEY, Some("tftp"), prefs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_validation() {
        let c = crate::inventory::testutil::conn();
        let mut p = prefs(&c).expect("prefs");
        assert_eq!(p, TftpPrefs::default());
        assert!(p.validate().is_err(), "no root yet");
        p.root = "/srv/tftp".into();
        p.validate().expect("valid");
        p.bind_host = "[::1]".into();
        assert_eq!(
            p.bind_addr().expect("v6").to_string(),
            format!("[::1]:{}", p.port)
        );
        p.bind_host = "nope".into();
        assert!(save_prefs(&c, &p).is_err());
        p.bind_host = "127.0.0.1".into();
        p.allow_read = false;
        assert!(p.validate().is_err());
        p.allow_write = true;
        assert_eq!(save_prefs(&c, &p).expect("save"), p);
        assert_eq!(prefs(&c).expect("load"), p);
    }
}
