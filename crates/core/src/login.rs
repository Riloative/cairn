//! Answers login and enable prompts at the start of a session, for devices whose
//! credential profile is known (Telnet and console logins, and "auto-enter enable").
//!
//! The automator only reads output and decides what to type; the caller writes the
//! bytes to the session. Each secret is typed at most once, so a wrong password never
//! causes repeated attempts (and lockouts). It stops at the first privileged prompt, after
//! a failure message, or after [`MAX_SCAN`] bytes of output.

use crate::secret::SecretString;
use zeroize::Zeroizing;

/// Stop watching after this much output: past the banner and login, prompts belong to
/// the user.
pub const MAX_SCAN: usize = 64 * 1024;
const TAIL: usize = 256;

#[derive(Debug, Clone, Default)]
pub struct LoginPlan {
    /// Answer `Username:` / `login:` prompts (Telnet and console only).
    pub username: Option<String>,
    /// Answer the first `Password:` prompt.
    pub password: Option<SecretString>,
    /// Type `enable` at a `>` prompt and answer its `Password:` prompt.
    pub enable_secret: Option<SecretString>,
}

impl LoginPlan {
    pub fn is_empty(&self) -> bool {
        self.username.is_none() && self.password.is_none() && self.enable_secret.is_none()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Login,
    EnableSent,
    Done,
}

/// What to type next. Zeroed on drop.
pub type Keystrokes = Zeroizing<Vec<u8>>;

#[derive(Debug)]
pub struct LoginAutomator {
    plan: LoginPlan,
    stage: Stage,
    sent_username: bool,
    sent_password: bool,
    tail: String,
    scanned: usize,
}

impl LoginAutomator {
    pub fn new(plan: LoginPlan) -> Self {
        let stage = if plan.is_empty() {
            Stage::Done
        } else {
            Stage::Login
        };
        Self {
            plan,
            stage,
            sent_username: false,
            sent_password: false,
            tail: String::new(),
            scanned: 0,
        }
    }

    pub fn is_done(&self) -> bool {
        self.stage == Stage::Done
    }

    /// Feed session output; returns keystrokes to send, if a prompt was answered.
    pub fn feed(&mut self, data: &[u8]) -> Option<Keystrokes> {
        if self.is_done() {
            return None;
        }
        self.scanned += data.len();
        self.tail
            .push_str(&strip_escapes(&String::from_utf8_lossy(data)));
        if self.tail.len() > TAIL {
            let cut = self.tail.len() - TAIL;
            let cut = (cut..self.tail.len())
                .find(|&i| self.tail.is_char_boundary(i))
                .unwrap_or(self.tail.len());
            self.tail.drain(..cut);
        }
        let out = self.step();
        if out.is_none() && self.scanned > MAX_SCAN {
            self.stage = Stage::Done;
        }
        out
    }

    fn step(&mut self) -> Option<Keystrokes> {
        let tail_lower = self.tail.to_ascii_lowercase();
        if FAILURES.iter().any(|f| tail_lower.contains(f)) {
            self.stage = Stage::Done;
            return None;
        }
        let line = last_line(&self.tail);
        let lower = line.to_ascii_lowercase();
        match self.stage {
            Stage::Done => None,
            Stage::Login => {
                if is_user_prompt(&lower) {
                    if self.sent_username {
                        // Asked again: the login failed. Hand over to the user.
                        self.stage = Stage::Done;
                        return None;
                    }
                    let user = self.plan.username.clone()?;
                    self.sent_username = true;
                    return Some(self.answer(user.as_bytes()));
                }
                if lower.ends_with("password:") {
                    if self.sent_password {
                        self.stage = Stage::Done;
                        return None;
                    }
                    let pw = self.plan.password.clone()?;
                    self.sent_password = true;
                    return Some(self.answer(pw.expose().as_bytes()));
                }
                if is_privileged(line) {
                    self.stage = Stage::Done;
                    return None;
                }
                if is_user_exec(line) {
                    if self.plan.enable_secret.is_none() {
                        self.stage = Stage::Done;
                        return None;
                    }
                    self.stage = Stage::EnableSent;
                    return Some(self.answer(b"enable"));
                }
                None
            }
            Stage::EnableSent => {
                if lower.ends_with("password:") {
                    self.stage = Stage::Done;
                    let secret = self.plan.enable_secret.clone()?;
                    return Some(self.answer(secret.expose().as_bytes()));
                }
                if is_privileged(line) {
                    // No enable password configured on the device.
                    self.stage = Stage::Done;
                }
                None
            }
        }
    }

    fn answer(&mut self, text: &[u8]) -> Keystrokes {
        // Forget what was seen so the same prompt is not answered twice.
        self.tail.clear();
        let mut out = Zeroizing::new(Vec::with_capacity(text.len() + 1));
        out.extend_from_slice(text);
        out.push(b'\r');
        out
    }
}

const FAILURES: &[&str] = &[
    "% bad passwords",
    "% access denied",
    "% authentication failed",
    "login incorrect",
    "% bad secrets",
    "authentication failed",
];

fn last_line(s: &str) -> &str {
    let line = s
        .rsplit(['\n', '\r'])
        .find(|l| !l.trim().is_empty())
        .unwrap_or("");
    line.trim_end()
}

fn is_user_prompt(lower: &str) -> bool {
    lower.ends_with("username:") || lower.ends_with("login:") || lower.ends_with("user name:")
}

/// A short prompt-like line ending in `c`, without spaces in the hostname part.
fn prompt_with(line: &str, c: char) -> bool {
    let Some(head) = line.strip_suffix(c) else {
        return false;
    };
    let head = head.trim();
    !head.is_empty() && head.len() <= 64 && !head.contains(' ')
}

fn is_user_exec(line: &str) -> bool {
    prompt_with(line, '>')
}

fn is_privileged(line: &str) -> bool {
    prompt_with(line, '#')
}

/// Drop ANSI escape sequences (prompts are often colored or preceded by cursor moves).
fn strip_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for n in chars.by_ref() {
                if ('@'..='~').contains(&n) {
                    break;
                }
            }
        } else {
            chars.next();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(user: bool, pw: bool, enable: bool) -> LoginAutomator {
        LoginAutomator::new(LoginPlan {
            username: user.then(|| "admin".to_owned()),
            password: pw.then(|| SecretString::from("pw1")),
            enable_secret: enable.then(|| SecretString::from("en1")),
        })
    }

    fn typed(a: &mut LoginAutomator, out: &str) -> Option<String> {
        a.feed(out.as_bytes())
            .map(|k| String::from_utf8_lossy(&k).into_owned())
    }

    #[test]
    fn telnet_login_then_enable() {
        let mut a = plan(true, true, true);
        assert_eq!(
            typed(&mut a, "\r\nUser Access Verification\r\n\r\nUser"),
            None
        );
        assert_eq!(typed(&mut a, "name: ").as_deref(), Some("admin\r"));
        assert_eq!(
            typed(&mut a, "admin\r\nPassword: ").as_deref(),
            Some("pw1\r")
        );
        assert_eq!(typed(&mut a, "\r\nsw1>").as_deref(), Some("enable\r"));
        assert_eq!(
            typed(&mut a, "enable\r\nPassword: ").as_deref(),
            Some("en1\r")
        );
        assert!(a.is_done());
        assert_eq!(typed(&mut a, "\r\nsw1#\r\nPassword: "), None);
    }

    #[test]
    fn ssh_enable_only() {
        let mut a = plan(false, false, true);
        assert_eq!(
            typed(&mut a, "\x1b[1msw1\x1b[0m>").as_deref(),
            Some("enable\r")
        );
        assert_eq!(typed(&mut a, "\r\nPassword:").as_deref(), Some("en1\r"));
        assert!(a.is_done());
    }

    #[test]
    fn already_privileged_or_no_enable_needed() {
        let mut a = plan(false, false, true);
        assert_eq!(typed(&mut a, "Last login: x\r\nsw1#"), None);
        assert!(a.is_done());
        let mut b = plan(false, false, true);
        assert_eq!(typed(&mut b, "sw1>").as_deref(), Some("enable\r"));
        assert_eq!(typed(&mut b, "\r\nsw1#"), None);
        assert!(b.is_done());
    }

    #[test]
    fn never_retries_a_wrong_password() {
        let mut a = plan(true, true, false);
        assert_eq!(typed(&mut a, "Password: ").as_deref(), Some("pw1\r"));
        assert_eq!(typed(&mut a, "\r\n% Login invalid\r\n\r\nPassword: "), None);
        assert!(a.is_done());
        let mut b = plan(true, true, true);
        assert_eq!(typed(&mut b, "login: ").as_deref(), Some("admin\r"));
        assert_eq!(typed(&mut b, "\r\nPassword: ").as_deref(), Some("pw1\r"));
        assert_eq!(typed(&mut b, "\r\nLogin incorrect\r\nlogin: "), None);
        assert!(b.is_done());
    }

    #[test]
    fn ignores_prose_and_stops_after_the_banner_budget() {
        let mut a = plan(false, false, true);
        // "->" in a banner sentence is not a prompt.
        assert_eq!(
            typed(&mut a, "Authorized users only -> see policy\r\n"),
            None
        );
        assert!(!a.is_done());
        let filler = "x".repeat(MAX_SCAN + 1);
        assert_eq!(typed(&mut a, &filler), None);
        assert!(a.is_done());
        let empty = LoginAutomator::new(LoginPlan::default());
        assert!(empty.is_done());
    }
}
