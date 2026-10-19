//! Terminal preferences: profiles, user-imported palettes and privileged-prompt patterns.
//! Stored as one settings document (`terminal`), validated here, consumed by the UI.

use crate::error::CoreError;
use crate::settings::{load_doc, save_doc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorStyle {
    Block,
    Bar,
    Underline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BellStyle {
    None,
    Visual,
    Sound,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    pub id: String,
    pub name: String,
    pub font_family: String,
    pub font_size: f32,
    pub line_height: f32,
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
    pub scrollback: u32,
    /// Palette id; `None` follows the app theme (Cairn Dark / Cairn Light).
    pub palette_id: Option<String>,
    /// Background opacity, 0.5–1.
    pub opacity: f32,
    pub bell: BellStyle,
    pub copy_on_select: bool,
    /// Delay between lines when pasting multi-line text (slow network gear), in ms.
    pub paste_line_delay_ms: u32,
    /// Local shell program for this profile; `None` uses the login shell.
    pub shell: Option<String>,
}

impl TerminalProfile {
    pub fn default_profile() -> Self {
        Self {
            id: "default".into(),
            name: "Default".into(),
            font_family: "JetBrains Mono Variable".into(),
            font_size: 13.0,
            line_height: 1.2,
            cursor_style: CursorStyle::Block,
            cursor_blink: true,
            scrollback: 10_000,
            palette_id: None,
            opacity: 1.0,
            bell: BellStyle::Visual,
            copy_on_select: false,
            paste_line_delay_ms: 0,
            shell: None,
        }
    }

    fn validate(&self) -> Result<(), CoreError> {
        let bad = |m: String| Err(CoreError::Validation(m));
        if self.id.trim().is_empty() || self.name.trim().is_empty() {
            return bad("A terminal profile needs a name.".into());
        }
        if !(6.0..=48.0).contains(&self.font_size) {
            return bad(format!(
                "Font size must be between 6 and 48 (profile \"{}\").",
                self.name
            ));
        }
        if !(1.0..=2.0).contains(&self.line_height) {
            return bad(format!(
                "Line height must be between 1.0 and 2.0 (profile \"{}\").",
                self.name
            ));
        }
        if !(100..=1_000_000).contains(&self.scrollback) {
            return bad(format!(
                "Scrollback must be between 100 and 1,000,000 lines (profile \"{}\").",
                self.name
            ));
        }
        if !(0.5..=1.0).contains(&self.opacity) {
            return bad(format!(
                "Opacity must be between 50% and 100% (profile \"{}\").",
                self.name
            ));
        }
        if self.paste_line_delay_ms > 5_000 {
            return bad("Paste line delay must be at most 5000 ms.".into());
        }
        Ok(())
    }
}

/// A palette imported by the user. Colors are `#rrggbb`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomPalette {
    pub id: String,
    pub name: String,
    pub scheme: String,
    pub source: String,
    pub license: String,
    pub colors: BTreeMap<String, String>,
}

/// Color keys every palette must define.
pub const PALETTE_KEYS: [&str; 20] = [
    "background",
    "foreground",
    "cursor",
    "selectionBackground",
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
];

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

impl CustomPalette {
    fn validate(&self) -> Result<(), CoreError> {
        if !self.id.starts_with("custom-") || self.name.trim().is_empty() {
            return Err(CoreError::Validation(
                "Imported palettes need a name and a custom- id.".into(),
            ));
        }
        if self.scheme != "dark" && self.scheme != "light" {
            return Err(CoreError::Validation(
                "Palette scheme must be dark or light.".into(),
            ));
        }
        for key in PALETTE_KEYS {
            match self.colors.get(key) {
                Some(c) if is_hex_color(c) => {}
                _ => {
                    return Err(CoreError::Validation(format!(
                        "Palette \"{}\" is missing a valid {key} color.",
                        self.name
                    )))
                }
            }
        }
        Ok(())
    }
}

/// A keyword highlighting rule (regex → style). Colors are palette ANSI names or `#rrggbb`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightRule {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub case_insensitive: bool,
    pub fg: Option<String>,
    pub bg: Option<String>,
    pub bold: bool,
    pub underline: bool,
    pub enabled: bool,
}

/// A user rule set; replaces the built-in set with the same id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightRuleSet {
    pub id: String,
    pub name: String,
    pub vendors: Vec<String>,
    pub rules: Vec<HighlightRule>,
}

fn is_color(c: &str) -> bool {
    is_hex_color(c) || PALETTE_KEYS[4..].contains(&c)
}

impl HighlightRuleSet {
    fn validate(&self) -> Result<(), CoreError> {
        let bad = |m: String| Err(CoreError::Validation(m));
        if self.id.trim().is_empty() || self.name.trim().is_empty() {
            return bad("Highlighting rule sets need a name.".into());
        }
        if self.rules.len() > 200 {
            return bad(format!("\"{}\" has more than 200 rules.", self.name));
        }
        for r in &self.rules {
            if r.pattern.is_empty() || r.pattern.len() > 500 {
                return bad(format!(
                    "Rule \"{}\" needs a pattern under 500 characters.",
                    r.name
                ));
            }
            for c in [&r.fg, &r.bg].into_iter().flatten() {
                if !is_color(c) {
                    return bad(format!("Rule \"{}\" has an invalid color {c}.", r.name));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalPrefs {
    pub profiles: Vec<TerminalProfile>,
    pub default_profile_id: String,
    pub custom_palettes: Vec<CustomPalette>,
    /// Regexes matched against the cursor line; a match tints the header red.
    pub privileged_prompt_patterns: Vec<String>,
    /// Ask before pasting text with more than one line.
    pub confirm_multiline_paste: bool,
    pub highlight_enabled: bool,
    /// User-edited or added highlighting rule sets.
    pub highlight_sets: Vec<HighlightRuleSet>,
}

/// Defaults: Cisco/Aruba/HP privileged exec (`hostname#`), Juniper root shell
/// (`root@host%`/`root@host#`), Linux root prompts (`root@host:~#`, `[root@host ~]#`),
/// HP Comware system view (`[HP-5130]`). Mirrored in `ui/src/stores/terminalPrefs.ts`.
pub const DEFAULT_PRIVILEGED_PATTERNS: [&str; 5] = [
    r"^[\w.\-/()]+(\([\w.\-]+\))?#\s?$",
    r"^root@[\w.\-]+[%#]\s?$",
    r"^root@[\w.\-]+:[^\s]*#\s?$",
    r"^\[root@[^\]]+\]#\s?$",
    r"^\[[\w.\-/]+\]\s?$",
];

impl Default for TerminalPrefs {
    fn default() -> Self {
        Self {
            profiles: vec![TerminalProfile::default_profile()],
            default_profile_id: "default".into(),
            custom_palettes: Vec::new(),
            privileged_prompt_patterns: DEFAULT_PRIVILEGED_PATTERNS
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
            confirm_multiline_paste: true,
            highlight_enabled: true,
            highlight_sets: Vec::new(),
        }
    }
}

impl TerminalPrefs {
    pub fn validate(&self) -> Result<(), CoreError> {
        if self.profiles.is_empty() {
            return Err(CoreError::Validation(
                "Keep at least one terminal profile.".into(),
            ));
        }
        let mut ids = std::collections::HashSet::new();
        for p in &self.profiles {
            p.validate()?;
            if !ids.insert(&p.id) {
                return Err(CoreError::Validation(format!(
                    "Duplicate profile id {}.",
                    p.id
                )));
            }
        }
        if !self
            .profiles
            .iter()
            .any(|p| p.id == self.default_profile_id)
        {
            return Err(CoreError::Validation(
                "The default profile does not exist.".into(),
            ));
        }
        for p in &self.custom_palettes {
            p.validate()?;
        }
        if self.highlight_sets.len() > 50 {
            return Err(CoreError::Validation(
                "At most 50 highlighting rule sets.".into(),
            ));
        }
        for set in &self.highlight_sets {
            set.validate()?;
        }
        if self
            .privileged_prompt_patterns
            .iter()
            .any(|p| p.len() > 500)
        {
            return Err(CoreError::Validation(
                "Prompt patterns must be under 500 characters.".into(),
            ));
        }
        Ok(())
    }
}

const KEY: &str = "terminal";

pub fn load(conn: &Connection) -> Result<TerminalPrefs, CoreError> {
    load_doc(conn, KEY)
}

pub fn save(conn: &Connection, prefs: &TerminalPrefs) -> Result<TerminalPrefs, CoreError> {
    prefs.validate()?;
    save_doc(conn, KEY, Some(KEY), prefs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{audit, db};
    use zeroize::Zeroizing;

    fn conn() -> Connection {
        db::open_in_memory(&Zeroizing::new([4u8; 32])).expect("db")
    }

    fn palette() -> CustomPalette {
        CustomPalette {
            id: "custom-test".into(),
            name: "Test".into(),
            scheme: "dark".into(),
            source: "import".into(),
            license: "unknown".into(),
            colors: PALETTE_KEYS
                .iter()
                .map(|k| ((*k).to_owned(), "#112233".to_owned()))
                .collect(),
        }
    }

    #[test]
    fn defaults_are_valid_and_match_the_spec() {
        let p = TerminalPrefs::default();
        p.validate().expect("valid");
        assert_eq!(p.profiles[0].scrollback, 10_000);
        assert!(p.confirm_multiline_paste);
        assert_eq!(load(&conn()).expect("load"), p);
    }

    #[test]
    fn saves_and_audits_with_prefix() {
        let c = conn();
        let mut p = TerminalPrefs::default();
        p.profiles[0].font_size = 15.0;
        p.custom_palettes.push(palette());
        save(&c, &p).expect("save");
        assert_eq!(load(&c).expect("load"), p);
        let entry = &audit::recent(&c, 1).expect("audit")[0];
        let fields: Vec<String> = entry.payload["changes"]
            .as_array()
            .expect("changes")
            .iter()
            .map(|c| c["field"].as_str().unwrap_or_default().to_owned())
            .collect();
        assert!(
            fields.iter().all(|f| f.starts_with("terminal.")),
            "{fields:?}"
        );
    }

    #[test]
    fn rejects_invalid_profiles() {
        let mut p = TerminalPrefs::default();
        p.profiles[0].scrollback = 10;
        assert!(p.validate().is_err());
        let p = TerminalPrefs {
            default_profile_id: "missing".into(),
            ..Default::default()
        };
        assert!(p.validate().is_err());
        let mut p = TerminalPrefs::default();
        p.profiles.push(TerminalProfile::default_profile());
        assert!(p.validate().is_err(), "duplicate ids");
        let mut p = TerminalPrefs::default();
        p.profiles.clear();
        assert!(p.validate().is_err());
    }

    #[test]
    fn validates_highlight_sets() {
        let rule = HighlightRule {
            id: "r".into(),
            name: "r".into(),
            pattern: "Gi\\d+".into(),
            case_insensitive: false,
            fg: Some("brightBlue".into()),
            bg: Some("#112233".into()),
            bold: true,
            underline: false,
            enabled: true,
        };
        let set = |rules| HighlightRuleSet {
            id: "cisco".into(),
            name: "Cisco".into(),
            vendors: vec!["cisco".into()],
            rules,
        };
        let mut p = TerminalPrefs::default();
        p.highlight_sets.push(set(vec![rule.clone()]));
        assert!(p.validate().is_ok());
        let mut bad = rule.clone();
        bad.fg = Some("chartreuse".into());
        p.highlight_sets = vec![set(vec![bad])];
        assert!(p.validate().is_err());
        let mut bad = rule;
        bad.pattern = String::new();
        p.highlight_sets = vec![set(vec![bad])];
        assert!(p.validate().is_err());
    }

    #[test]
    fn rejects_incomplete_palettes() {
        let mut p = TerminalPrefs::default();
        let mut pal = palette();
        pal.colors.insert("red".into(), "red".into());
        p.custom_palettes.push(pal);
        assert!(p.validate().is_err());
        let mut p = TerminalPrefs::default();
        let mut pal = palette();
        pal.colors.remove("brightWhite");
        p.custom_palettes.push(pal);
        assert!(p.validate().is_err());
    }
}
