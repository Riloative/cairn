//! Telnet stream parsing and option negotiation (RFC 854/855, loop-safe per RFC 1143).
//!
//! [`Negotiator::receive`] splits incoming bytes into terminal data and protocol
//! commands, and produces the replies to send back. It does no I/O.

use crate::codes::{Command, TelnetOption, IAC};
use std::collections::HashSet;

/// Terminal type reported to the server (RFC 1091).
pub const TERMINAL_TYPE: &str = "XTERM-256COLOR";

const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Data,
    Iac,
    /// After IAC WILL/WONT/DO/DONT.
    Option(Command),
    Sb,
    SbData,
    SbIac,
    /// After a CR in the data stream (CR NUL → CR).
    Cr,
}

/// Parser + negotiator for one connection.
#[derive(Debug)]
pub struct Negotiator {
    state: State,
    sb: Vec<u8>,
    /// Options we perform (we said WILL and the server agreed / asked).
    local: HashSet<u8>,
    /// Options the server performs (it said WILL and we answered DO).
    remote: HashSet<u8>,
    size: (u16, u16),
}

/// Output of feeding bytes to the negotiator.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Received {
    /// Bytes for the terminal.
    pub data: Vec<u8>,
    /// Bytes to send back to the server.
    pub reply: Vec<u8>,
}

/// Options the server may perform for us.
fn accept_remote(opt: TelnetOption) -> bool {
    matches!(
        opt,
        TelnetOption::Echo | TelnetOption::SuppressGoAhead | TelnetOption::BinaryTransmission
    )
}

/// Options we are willing to perform.
fn accept_local(opt: TelnetOption) -> bool {
    matches!(
        opt,
        TelnetOption::Naws
            | TelnetOption::TerminalType
            | TelnetOption::SuppressGoAhead
            | TelnetOption::BinaryTransmission
    )
}

fn cmd(c: Command, opt: u8) -> [u8; 3] {
    [IAC, c.to_byte(), opt]
}

/// Append bytes with IAC (0xFF) doubled, as required inside data and subnegotiation.
fn push_escaped(out: &mut Vec<u8>, bytes: &[u8]) {
    for &b in bytes {
        out.push(b);
        if b == IAC {
            out.push(IAC);
        }
    }
}

impl Negotiator {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            state: State::Data,
            sb: Vec::new(),
            local: HashSet::new(),
            remote: HashSet::new(),
            size: (cols, rows),
        }
    }

    pub fn remote_echo(&self) -> bool {
        self.remote.contains(&TelnetOption::Echo.to_byte())
    }

    fn binary_out(&self) -> bool {
        self.local
            .contains(&TelnetOption::BinaryTransmission.to_byte())
    }

    /// The NAWS subnegotiation for the current size.
    fn naws(&self) -> Vec<u8> {
        let (c, r) = self.size;
        let mut out = vec![IAC, Command::Sb.to_byte(), TelnetOption::Naws.to_byte()];
        push_escaped(&mut out, &c.to_be_bytes());
        push_escaped(&mut out, &r.to_be_bytes());
        out.extend_from_slice(&[IAC, Command::Se.to_byte()]);
        out
    }

    /// Record a new window size; returns the NAWS message if NAWS is active.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Option<Vec<u8>> {
        self.size = (cols, rows);
        self.local
            .contains(&TelnetOption::Naws.to_byte())
            .then(|| self.naws())
    }

    /// Encode user input: double IAC; Enter (CR) becomes CR LF unless in binary mode.
    pub fn encode_input(&self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len() + 4);
        for &b in data {
            match b {
                IAC => out.extend_from_slice(&[IAC, IAC]),
                b'\r' if !self.binary_out() => out.extend_from_slice(b"\r\n"),
                _ => out.push(b),
            }
        }
        out
    }

    /// The Telnet BREAK command (password recovery through console servers).
    pub fn break_command() -> [u8; 2] {
        [IAC, Command::Break.to_byte()]
    }

    pub fn receive(&mut self, input: &[u8]) -> Received {
        let mut r = Received::default();
        for &b in input {
            self.step(b, &mut r);
        }
        r
    }

    fn step(&mut self, b: u8, r: &mut Received) {
        match self.state {
            State::Data => match b {
                IAC => self.state = State::Iac,
                b'\r' => {
                    r.data.push(b);
                    self.state = State::Cr;
                }
                _ => r.data.push(b),
            },
            State::Cr => {
                self.state = State::Data;
                match b {
                    0 => {}
                    IAC => self.state = State::Iac,
                    _ => r.data.push(b),
                }
            }
            State::Iac => {
                self.state = State::Data;
                match Command::from_byte(b) {
                    Some(Command::Iac) => r.data.push(IAC),
                    Some(c) if c.takes_option() => self.state = State::Option(c),
                    Some(Command::Sb) => {
                        self.sb.clear();
                        self.state = State::Sb;
                    }
                    // NOP, GA, DM, AYT, … carry no data for us.
                    _ => {}
                }
            }
            State::Option(c) => {
                self.state = State::Data;
                self.negotiate(c, b, r);
            }
            State::Sb => {
                self.sb.push(b);
                self.state = State::SbData;
            }
            State::SbData => {
                if b == IAC {
                    self.state = State::SbIac;
                } else {
                    self.sb.push(b);
                }
            }
            State::SbIac => match b {
                IAC => {
                    self.sb.push(IAC);
                    self.state = State::SbData;
                }
                _ if Command::from_byte(b) == Some(Command::Se) => {
                    self.state = State::Data;
                    self.subnegotiation(r);
                }
                _ => self.state = State::Data,
            },
        }
    }

    fn negotiate(&mut self, c: Command, opt_byte: u8, r: &mut Received) {
        let opt = TelnetOption::from_byte(opt_byte);
        match c {
            Command::Will => {
                if accept_remote(opt) {
                    if self.remote.insert(opt_byte) {
                        r.reply.extend_from_slice(&cmd(Command::Do, opt_byte));
                    }
                } else {
                    r.reply.extend_from_slice(&cmd(Command::Dont, opt_byte));
                }
            }
            // Only acknowledge changes, so a misbehaving server cannot make us loop.
            Command::Wont if self.remote.remove(&opt_byte) => {
                r.reply.extend_from_slice(&cmd(Command::Dont, opt_byte));
            }
            Command::Do => {
                if accept_local(opt) {
                    if self.local.insert(opt_byte) {
                        r.reply.extend_from_slice(&cmd(Command::Will, opt_byte));
                    }
                    if opt == TelnetOption::Naws {
                        r.reply.extend_from_slice(&self.naws());
                    }
                } else {
                    r.reply.extend_from_slice(&cmd(Command::Wont, opt_byte));
                }
            }
            Command::Dont if self.local.remove(&opt_byte) => {
                r.reply.extend_from_slice(&cmd(Command::Wont, opt_byte));
            }
            _ => {}
        }
    }

    fn subnegotiation(&mut self, r: &mut Received) {
        let opt = self.sb.first().copied().map(TelnetOption::from_byte);
        if opt == Some(TelnetOption::TerminalType) && self.sb.get(1) == Some(&TTYPE_SEND) {
            r.reply.extend_from_slice(&[
                IAC,
                Command::Sb.to_byte(),
                TelnetOption::TerminalType.to_byte(),
                TTYPE_IS,
            ]);
            r.reply.extend_from_slice(TERMINAL_TYPE.as_bytes());
            r.reply.extend_from_slice(&[IAC, Command::Se.to_byte()]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WILL: u8 = 251;
    const WONT: u8 = 252;
    const DO: u8 = 253;
    const DONT: u8 = 254;
    const SB: u8 = 250;
    const SE: u8 = 240;

    #[test]
    fn passes_plain_data_through() {
        let mut n = Negotiator::new(80, 24);
        let r = n.receive(b"User Access Verification\r\n\r\nUsername: ");
        assert_eq!(r.data, b"User Access Verification\r\n\r\nUsername: ");
        assert!(r.reply.is_empty());
    }

    #[test]
    fn accepts_server_echo_and_sga_refuses_others() {
        let mut n = Negotiator::new(80, 24);
        let r = n.receive(&[IAC, WILL, 1, IAC, WILL, 3, IAC, WILL, 37]);
        assert_eq!(r.reply, [IAC, DO, 1, IAC, DO, 3, IAC, DONT, 37]);
        assert!(n.remote_echo());
        // Repeating WILL ECHO must not loop.
        assert!(n.receive(&[IAC, WILL, 1]).reply.is_empty());
        assert_eq!(n.receive(&[IAC, WONT, 1]).reply, [IAC, DONT, 1]);
        assert!(!n.remote_echo());
    }

    #[test]
    fn performs_naws_and_ttype() {
        let mut n = Negotiator::new(132, 43);
        let r = n.receive(&[IAC, DO, 31]);
        assert_eq!(
            r.reply,
            [IAC, WILL, 31, IAC, SB, 31, 0, 132, 0, 43, IAC, SE]
        );
        let r = n.receive(&[IAC, DO, 24, IAC, SB, 24, 1, IAC, SE]);
        let mut expected = vec![IAC, WILL, 24, IAC, SB, 24, 0];
        expected.extend_from_slice(b"XTERM-256COLOR");
        expected.extend_from_slice(&[IAC, SE]);
        assert_eq!(r.reply, expected);
        assert_eq!(
            n.receive(&[IAC, DO, 32]).reply,
            [IAC, WONT, 32],
            "TSPEED refused"
        );
    }

    #[test]
    fn naws_escapes_255_and_follows_resizes() {
        let mut n = Negotiator::new(80, 24);
        assert_eq!(n.resize(100, 30), None, "not negotiated yet");
        n.receive(&[IAC, DO, 31]);
        let msg = n.resize(255, 50).expect("naws");
        assert_eq!(msg, [IAC, SB, 31, 0, IAC, IAC, 0, 50, IAC, SE]);
    }

    #[test]
    fn handles_escapes_cr_nul_and_split_sequences() {
        let mut n = Negotiator::new(80, 24);
        let mut data = Vec::new();
        for chunk in [
            &[b'a', IAC][..],
            &[IAC, b'\r'][..],
            &[0, b'b', IAC][..],
            &[WILL][..],
            &[1, b'c'][..],
        ] {
            data.extend(n.receive(chunk).data);
        }
        assert_eq!(data, [b'a', IAC, b'\r', b'b', b'c']);
    }

    #[test]
    fn encodes_input() {
        let n = Negotiator::new(80, 24);
        assert_eq!(n.encode_input(b"en\r"), b"en\r\n");
        assert_eq!(n.encode_input(&[IAC]), [IAC, IAC]);
        assert_eq!(Negotiator::break_command(), [IAC, 243]);
    }
}
