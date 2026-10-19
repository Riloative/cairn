//! "Grab config": the vendor command that prints the configuration, the command that
//! turns paging off first, and a screen-scraping state machine that drives an
//! interactive shell (enable mode, paging, prompt detection) independent of transport.
//!
//! The transport feeds received bytes to [`Grabber::feed`], calls [`Grabber::idle`]
//! after a quiet period, and sends whatever [`Step::Send`] asks for.

use crate::secret::SecretString;

/// What to run on a vendor's CLI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrabPlan {
    /// Commands that turn paging off for this session.
    pub setup: Vec<String>,
    /// The command that prints the configuration.
    pub command: String,
    /// Whether a `>` prompt means "enter enable mode first" (Cisco-style CLIs).
    pub enable_mode: bool,
}

/// The plan for a device's vendor (case-insensitive); unknown vendors get the
/// Cisco-style commands most network operating systems accept.
pub fn plan(vendor: &str) -> GrabPlan {
    let p = |setup: &[&str], command: &str, enable_mode: bool| GrabPlan {
        setup: setup.iter().map(|s| (*s).to_owned()).collect(),
        command: command.to_owned(),
        enable_mode,
    };
    match vendor.trim().to_ascii_lowercase().as_str() {
        "juniper" => p(
            &["set cli screen-length 0", "set cli screen-width 0"],
            "show configuration | display set | no-more",
            false,
        ),
        // FortiOS has no per-session paging switch; the pager is answered instead.
        "fortinet" => p(&[], "show full-configuration", false),
        "aruba" | "hp" => p(&["no page"], "show running-config", true),
        "mikrotik" => p(&[], "/export", false),
        "ubiquiti" => p(&[], "show configuration commands | cat", false),
        _ => p(&["terminal length 0"], "show running-config", true),
    }
}

/// What the transport should do next.
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Send(Vec<u8>),
    /// The configuration, cleaned of echo, prompts and pager artifacts.
    Done(String),
    /// A user-facing reason the grab failed.
    Fail(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Waiting for the first prompt (after banners/MOTD).
    Prompt {
        nudged: bool,
    },
    /// Sent `enable`, waiting for a password prompt or the `#` prompt.
    Enable {
        sent_secret: bool,
    },
    /// Sent setup command `n`, waiting for the prompt.
    Setup(usize),
    /// Sent the configuration command, collecting output.
    Command,
    Finished,
}

/// Largest transcript collected before giving up (runaway output).
const MAX_OUTPUT: usize = 32 * 1024 * 1024;

pub struct Grabber {
    plan: GrabPlan,
    enable: Option<SecretString>,
    phase: Phase,
    /// Raw text received since the last command was sent.
    buf: String,
    prompt: Option<String>,
}

impl std::fmt::Debug for Grabber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Grabber")
            .field("phase", &self.phase)
            .field("prompt", &self.prompt)
            .finish_non_exhaustive()
    }
}

impl Grabber {
    pub fn new(plan: GrabPlan, enable: Option<SecretString>) -> Self {
        Self {
            plan,
            enable,
            phase: Phase::Prompt { nudged: false },
            buf: String::new(),
            prompt: None,
        }
    }

    pub fn is_finished(&self) -> bool {
        self.phase == Phase::Finished
    }

    fn send_line(&mut self, line: &str) -> Step {
        self.buf.clear();
        Step::Send(format!("{line}\n").into_bytes())
    }

    fn fail(&mut self, msg: impl Into<String>) -> Vec<Step> {
        self.phase = Phase::Finished;
        vec![Step::Fail(msg.into())]
    }

    /// Received output from the device.
    pub fn feed(&mut self, data: &[u8]) -> Vec<Step> {
        if self.phase == Phase::Finished {
            return Vec::new();
        }
        self.buf.push_str(&String::from_utf8_lossy(data));
        if self.buf.len() > MAX_OUTPUT {
            return self.fail("The device sent more than 32 MB; the grab was stopped.");
        }
        self.advance(false)
    }

    /// Nothing arrived for a while: prompts without a trailing newline are complete.
    pub fn idle(&mut self) -> Vec<Step> {
        if self.phase == Phase::Finished {
            return Vec::new();
        }
        self.advance(true)
    }

    fn advance(&mut self, idle: bool) -> Vec<Step> {
        let screen = clean_screen(&self.buf);
        let last = last_line(&screen);
        match self.phase {
            Phase::Prompt { nudged } => match last.filter(|l| looks_like_prompt(l)) {
                Some(prompt) => {
                    let prompt = prompt.to_owned();
                    self.prompt_found(prompt)
                }
                None if idle && !nudged => {
                    self.phase = Phase::Prompt { nudged: true };
                    vec![self.send_line("")]
                }
                None if idle => self.fail(
                    "No command prompt appeared. The device may need a different login or a pager key.",
                ),
                None => Vec::new(),
            },
            Phase::Enable { sent_secret } => {
                let lower = last.map(str::to_ascii_lowercase).unwrap_or_default();
                if !sent_secret && lower.trim_end().ends_with("password:") {
                    self.phase = Phase::Enable { sent_secret: true };
                    let secret = self
                        .enable
                        .as_ref()
                        .map(|s| s.expose().to_owned())
                        .unwrap_or_default();
                    self.buf.clear();
                    let mut bytes = secret.into_bytes();
                    bytes.push(b'\n');
                    return vec![Step::Send(bytes)];
                }
                match last.filter(|l| looks_like_prompt(l)) {
                    Some(p) if p.ends_with('#') => {
                        let p = p.to_owned();
                        self.prompt = Some(p);
                        self.next_setup(0)
                    }
                    Some(_) if sent_secret || idle => {
                        self.fail("Entering enable mode failed. Check the enable secret of the device's credential profile.")
                    }
                    _ => Vec::new(),
                }
            }
            Phase::Setup(n) => {
                if self.at_prompt(&screen) {
                    self.next_setup(n + 1)
                } else if idle && last.is_some_and(is_pager) {
                    vec![Step::Send(b" ".to_vec())]
                } else {
                    Vec::new()
                }
            }
            Phase::Command => {
                if last.is_some_and(is_pager) {
                    return vec![Step::Send(b" ".to_vec())];
                }
                if self.at_prompt(&screen) {
                    let config = extract(&screen, self.prompt.as_deref().unwrap_or_default());
                    self.phase = Phase::Finished;
                    if config.trim().is_empty() {
                        return vec![Step::Fail(format!(
                            "\"{}\" printed nothing. The account may lack the privilege to show the configuration.",
                            self.plan.command
                        ))];
                    }
                    if let Some(err) = cli_error(&config) {
                        return vec![Step::Fail(format!(
                            "The device rejected \"{}\": {err}",
                            self.plan.command
                        ))];
                    }
                    return vec![Step::Done(config)];
                }
                Vec::new()
            }
            Phase::Finished => Vec::new(),
        }
    }

    fn prompt_found(&mut self, prompt: String) -> Vec<Step> {
        if prompt.ends_with('>') && self.plan.enable_mode {
            if self.enable.is_none() {
                return self.fail(format!(
                    "The device is not in privileged mode (prompt \"{prompt}\") and its credential profile has no enable secret."
                ));
            }
            self.phase = Phase::Enable { sent_secret: false };
            return vec![self.send_line("enable")];
        }
        self.prompt = Some(prompt);
        self.next_setup(0)
    }

    fn next_setup(&mut self, n: usize) -> Vec<Step> {
        if let Some(cmd) = self.plan.setup.get(n).cloned() {
            self.phase = Phase::Setup(n);
            vec![self.send_line(&cmd)]
        } else {
            self.phase = Phase::Command;
            let cmd = self.plan.command.clone();
            vec![self.send_line(&cmd)]
        }
    }

    /// The output ends with the session's prompt on a line of its own, after the echo.
    fn at_prompt(&self, screen: &str) -> bool {
        let Some(prompt) = &self.prompt else {
            return false;
        };
        let lines: Vec<&str> = screen.lines().collect();
        lines.len() >= 2 && lines.last().is_some_and(|l| l.trim_end() == prompt)
    }
}

/// A CLI prompt: short, no spaces inside except Junos's `user@host>`, ends in > # $ %.
pub fn looks_like_prompt(line: &str) -> bool {
    let l = line.trim_end();
    let n = l.chars().count();
    (2..=128).contains(&n)
        && l.ends_with(['>', '#', '$', '%', ']'])
        && !is_pager(l)
        && !l.starts_with('!')
}

/// Pager prompts of common network operating systems.
pub fn is_pager(line: &str) -> bool {
    let l = line.trim().to_ascii_lowercase();
    l.contains("--more--")
        || l.contains("-- more --")
        || l.contains("<--- more --->")
        || l.contains("--(more)--")
        || l.starts_with("press any key")
        || l == "more"
}

fn last_line(screen: &str) -> Option<&str> {
    screen.lines().rev().find(|l| !l.trim().is_empty())
}

/// The command output between the echoed command and the final prompt, with pager
/// lines removed and a trailing newline.
fn extract(screen: &str, prompt: &str) -> String {
    let mut lines: Vec<&str> = screen.lines().collect();
    if lines.last().is_some_and(|l| l.trim_end() == prompt) {
        lines.pop();
    }
    // The first line is the echo of the command.
    let body: Vec<&str> = lines.into_iter().skip(1).filter(|l| !is_pager(l)).collect();
    let start = body
        .iter()
        .position(|l| !l.trim().is_empty())
        .unwrap_or(body.len());
    let end = body
        .iter()
        .rposition(|l| !l.trim().is_empty())
        .map_or(start, |i| i + 1);
    let mut out = body[start..end.max(start)].join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

/// Typical "invalid command" replies, so a rejected command is not stored as config.
fn cli_error(output: &str) -> Option<String> {
    let first: Vec<&str> = output.lines().take(3).collect();
    first
        .iter()
        .find(|l| {
            let l = l.trim().to_ascii_lowercase();
            l.starts_with("% invalid")
                || l.starts_with("% unknown command")
                || l.starts_with("% incomplete command")
                || l.starts_with("unknown command")
                || l.starts_with("syntax error")
                || l.starts_with("invalid input")
                || l.starts_with("command fail")
        })
        .map(|l| l.trim().to_owned())
}

/// Text as it appears on screen: escape sequences removed, backspaces applied,
/// carriage returns overwrite the line, line endings normalized to `\n`.
pub fn clean_screen(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut line: Vec<char> = Vec::new();
    let mut col = 0usize;
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => skip_escape(&mut chars),
            '\u{8}' => col = col.saturating_sub(1),
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    continue;
                }
                col = 0;
            }
            '\n' => {
                out.push_str(line.iter().collect::<String>().trim_end());
                out.push('\n');
                line.clear();
                col = 0;
            }
            c if c.is_control() && c != '\t' => {}
            c => {
                if col < line.len() {
                    line[col] = c;
                } else {
                    line.push(c);
                }
                col += 1;
            }
        }
    }
    out.push_str(line.iter().collect::<String>().trim_end());
    out
}

fn skip_escape(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    match chars.peek() {
        Some('[') => {
            chars.next();
            // CSI: parameters until a final byte in @..~
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        }
        Some(']') => {
            chars.next();
            // OSC: until BEL or ST (ESC \)
            while let Some(c) = chars.next() {
                if c == '\u{7}' {
                    break;
                }
                if c == '\u{1b}' {
                    chars.next();
                    break;
                }
            }
        }
        Some(_) => {
            chars.next();
        }
        None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run a scripted device: each (expected send, reply) pair; returns the outcome.
    fn run(mut g: Grabber, greeting: &str, script: &[(&str, &str)]) -> Step {
        let mut steps = g.feed(greeting.as_bytes());
        steps.extend(g.idle());
        let mut script = script.iter();
        loop {
            let Some(step) = steps.pop() else {
                steps = g.idle();
                if steps.is_empty() {
                    panic!("stalled");
                }
                continue;
            };
            match step {
                Step::Send(bytes) => {
                    let sent = String::from_utf8(bytes).expect("utf8");
                    let (expect, reply) = script
                        .next()
                        .unwrap_or_else(|| panic!("unexpected send {sent:?}"));
                    assert_eq!(sent, *expect);
                    steps = g.feed(reply.as_bytes());
                }
                done => return done,
            }
        }
    }

    #[test]
    fn plans_per_vendor() {
        assert_eq!(plan("Cisco").command, "show running-config");
        assert_eq!(plan("cisco").setup, vec!["terminal length 0"]);
        assert!(plan("Juniper").command.contains("display set"));
        assert_eq!(plan("Fortinet").command, "show full-configuration");
        assert_eq!(plan("Aruba").setup, vec!["no page"]);
        assert_eq!(plan("Whatever").command, "show running-config");
    }

    #[test]
    fn cisco_with_enable_and_paging_off() {
        let g = Grabber::new(plan("Cisco"), Some(SecretString::from("en4ble")));
        let out = run(
            g,
            "\r\n*** Authorized access only ***\r\n\r\nsw1>",
            &[
                ("enable\n", "enable\r\nPassword: "),
                ("en4ble\n", "\r\nsw1#"),
                ("terminal length 0\n", "terminal length 0\r\nsw1#"),
                (
                    "show running-config\n",
                    "show running-config\r\nBuilding configuration...\r\n\r\nhostname sw1\r\n!\r\ninterface Gi1/0/1\r\n description uplink\r\n!\r\nend\r\n\r\nsw1#",
                ),
            ],
        );
        assert_eq!(
            out,
            Step::Done(
                "Building configuration...\n\nhostname sw1\n!\ninterface Gi1/0/1\n description uplink\n!\nend\n"
                    .into()
            )
        );
    }

    #[test]
    fn answers_the_pager_and_removes_it() {
        let g = Grabber::new(plan("Fortinet"), None);
        let out = run(
            g,
            "fw01 # ",
            &[
                (
                    "show full-configuration\n",
                    "show full-configuration\r\nconfig system global\r\n    set hostname \"fw01\"\r\n--More-- ",
                ),
                (" ", "\r         \rend\r\n\r\nfw01 # "),
            ],
        );
        assert_eq!(
            out,
            Step::Done("config system global\n    set hostname \"fw01\"\nend\n".into())
        );
    }

    #[test]
    fn junos_prompt_is_not_enable_mode() {
        let g = Grabber::new(plan("Juniper"), None);
        let out = run(
            g,
            "admin@srx1> ",
            &[
                ("set cli screen-length 0\n", "set cli screen-length 0\r\nScreen length set to 0\r\n\r\nadmin@srx1> "),
                ("set cli screen-width 0\n", "set cli screen-width 0\r\n\r\nadmin@srx1> "),
                (
                    "show configuration | display set | no-more\n",
                    "show configuration | display set | no-more\r\nset system host-name srx1\r\n\r\nadmin@srx1> ",
                ),
            ],
        );
        assert_eq!(out, Step::Done("set system host-name srx1\n".into()));
    }

    #[test]
    fn failures_are_explained() {
        let g = Grabber::new(plan("Cisco"), None);
        match run(g, "sw1>", &[]) {
            Step::Fail(m) => assert!(m.contains("no enable secret"), "{m}"),
            s => panic!("{s:?}"),
        }
        let g = Grabber::new(plan("Cisco"), None);
        let out = run(
            g,
            "sw1#",
            &[
                ("terminal length 0\n", "terminal length 0\r\nsw1#"),
                (
                    "show running-config\n",
                    "show running-config\r\n          ^\r\n% Invalid input detected at '^' marker.\r\n\r\nsw1#",
                ),
            ],
        );
        assert!(matches!(out, Step::Fail(m) if m.contains("% Invalid input")));
        let mut g = Grabber::new(plan("Cisco"), None);
        assert_eq!(g.feed(b"Welcome\r\n"), vec![]);
        assert_eq!(g.idle(), vec![Step::Send(b"\n".to_vec())]);
        assert!(matches!(g.idle().as_slice(), [Step::Fail(_)]));
        assert!(g.is_finished());
    }

    #[test]
    fn screen_cleanup() {
        assert_eq!(clean_screen("a\u{1b}[1;32mb\u{1b}[0m\r\n"), "ab\n");
        assert_eq!(clean_screen("abc\u{8}\u{8}XY\r\n"), "aXY\n");
        assert_eq!(clean_screen("--More--\r        \rnext\r\n"), "next\n");
        assert_eq!(clean_screen("\u{1b}]0;title\u{7}sw1#"), "sw1#");
        assert!(looks_like_prompt("sw1#"));
        assert!(looks_like_prompt("admin@srx1> "));
        assert!(looks_like_prompt("[admin@MikroTik] >"));
        assert!(!looks_like_prompt("--More--"));
        assert!(!looks_like_prompt("! last change"));
    }
}
