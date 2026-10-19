//! TFTP packet wire format (RFC 1350) with option extension (RFC 2347): `blksize`
//! (RFC 2348), `timeout` and `tsize` (RFC 2349).

/// Transfer mode of a read or write request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Octet,
    NetAscii,
}

impl Mode {
    fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "octet" => Some(Mode::Octet),
            "netascii" => Some(Mode::NetAscii),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Octet => "octet",
            Mode::NetAscii => "netascii",
        }
    }
}

/// TFTP error codes (RFC 1350 §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    NotDefined,
    FileNotFound,
    AccessViolation,
    DiskFull,
    IllegalOperation,
    UnknownTransferId,
    FileExists,
    NoSuchUser,
}

impl ErrorCode {
    fn from_u16(v: u16) -> Self {
        match v {
            1 => Self::FileNotFound,
            2 => Self::AccessViolation,
            3 => Self::DiskFull,
            4 => Self::IllegalOperation,
            5 => Self::UnknownTransferId,
            6 => Self::FileExists,
            7 => Self::NoSuchUser,
            _ => Self::NotDefined,
        }
    }

    fn to_u16(self) -> u16 {
        match self {
            Self::NotDefined => 0,
            Self::FileNotFound => 1,
            Self::AccessViolation => 2,
            Self::DiskFull => 3,
            Self::IllegalOperation => 4,
            Self::UnknownTransferId => 5,
            Self::FileExists => 6,
            Self::NoSuchUser => 7,
        }
    }
}

/// Request options as sent (names lower-cased), e.g. `("blksize", "1468")`.
pub type Options = Vec<(String, String)>;

/// A decoded TFTP packet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Packet {
    ReadRequest {
        filename: String,
        mode: Mode,
        options: Options,
    },
    WriteRequest {
        filename: String,
        mode: Mode,
        options: Options,
    },
    Data {
        block: u16,
        data: Vec<u8>,
    },
    Ack {
        block: u16,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
    /// Option acknowledgement (RFC 2347): the options the server accepted.
    OptionAck {
        options: Options,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PacketError {
    #[error("TFTP packet is too short")]
    TooShort,
    #[error("unknown TFTP opcode {0}")]
    UnknownOpcode(u16),
    #[error("malformed TFTP request: {0}")]
    Malformed(&'static str),
    #[error("unsupported TFTP transfer mode {0:?}")]
    UnsupportedMode(String),
    #[error("TFTP data block exceeds {MAX_BLOCK_SIZE} bytes")]
    DataTooLarge,
}

/// Maximum payload of a DATA packet without the blksize option.
pub const BLOCK_SIZE: usize = 512;
/// Largest block size the blksize option allows (RFC 2348).
pub const MAX_BLOCK_SIZE: usize = 65464;

const OP_RRQ: u16 = 1;
const OP_WRQ: u16 = 2;
const OP_DATA: u16 = 3;
const OP_ACK: u16 = 4;
const OP_ERROR: u16 = 5;
const OP_OACK: u16 = 6;

impl Packet {
    pub fn decode(buf: &[u8]) -> Result<Self, PacketError> {
        let (op, rest) = split_u16(buf)?;
        match op {
            OP_RRQ | OP_WRQ => {
                let (filename, rest) = take_cstr(rest).ok_or(PacketError::Malformed("filename"))?;
                let (mode, rest) = take_cstr(rest).ok_or(PacketError::Malformed("mode"))?;
                if filename.is_empty() {
                    return Err(PacketError::Malformed("empty filename"));
                }
                let mode = Mode::parse(&mode).ok_or(PacketError::UnsupportedMode(mode))?;
                let options = take_options(rest);
                Ok(if op == OP_RRQ {
                    Packet::ReadRequest {
                        filename,
                        mode,
                        options,
                    }
                } else {
                    Packet::WriteRequest {
                        filename,
                        mode,
                        options,
                    }
                })
            }
            OP_DATA => {
                let (block, data) = split_u16(rest)?;
                if data.len() > MAX_BLOCK_SIZE {
                    return Err(PacketError::DataTooLarge);
                }
                Ok(Packet::Data {
                    block,
                    data: data.to_vec(),
                })
            }
            OP_ACK => Ok(Packet::Ack {
                block: split_u16(rest)?.0,
            }),
            OP_ERROR => {
                let (code, rest) = split_u16(rest)?;
                let message = take_cstr(rest).map(|(m, _)| m).unwrap_or_default();
                Ok(Packet::Error {
                    code: ErrorCode::from_u16(code),
                    message,
                })
            }
            OP_OACK => Ok(Packet::OptionAck {
                options: take_options(rest),
            }),
            other => Err(PacketError::UnknownOpcode(other)),
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + BLOCK_SIZE);
        match self {
            Packet::ReadRequest {
                filename,
                mode,
                options,
            }
            | Packet::WriteRequest {
                filename,
                mode,
                options,
            } => {
                let op = if matches!(self, Packet::ReadRequest { .. }) {
                    OP_RRQ
                } else {
                    OP_WRQ
                };
                out.extend_from_slice(&op.to_be_bytes());
                push_cstr(&mut out, filename);
                push_cstr(&mut out, mode.as_str());
                push_options(&mut out, options);
            }
            Packet::OptionAck { options } => {
                out.extend_from_slice(&OP_OACK.to_be_bytes());
                push_options(&mut out, options);
            }
            Packet::Data { block, data } => {
                out.extend_from_slice(&OP_DATA.to_be_bytes());
                out.extend_from_slice(&block.to_be_bytes());
                out.extend_from_slice(data);
            }
            Packet::Ack { block } => {
                out.extend_from_slice(&OP_ACK.to_be_bytes());
                out.extend_from_slice(&block.to_be_bytes());
            }
            Packet::Error { code, message } => {
                out.extend_from_slice(&OP_ERROR.to_be_bytes());
                out.extend_from_slice(&code.to_u16().to_be_bytes());
                push_cstr(&mut out, message);
            }
        }
        out
    }
}

fn split_u16(buf: &[u8]) -> Result<(u16, &[u8]), PacketError> {
    match buf {
        [a, b, rest @ ..] => Ok((u16::from_be_bytes([*a, *b]), rest)),
        _ => Err(PacketError::TooShort),
    }
}

fn take_cstr(buf: &[u8]) -> Option<(String, &[u8])> {
    let nul = buf.iter().position(|&b| b == 0)?;
    let s = String::from_utf8_lossy(&buf[..nul]).into_owned();
    Some((s, &buf[nul + 1..]))
}

/// Option name/value pairs; an incomplete trailing pair is ignored.
fn take_options(mut buf: &[u8]) -> Options {
    let mut out = Vec::new();
    while let Some((name, rest)) = take_cstr(buf) {
        let Some((value, rest)) = take_cstr(rest) else {
            break;
        };
        if !name.is_empty() {
            out.push((name.to_ascii_lowercase(), value));
        }
        buf = rest;
    }
    out
}

fn push_options(out: &mut Vec<u8>, options: &Options) {
    for (name, value) in options {
        push_cstr(out, name);
        push_cstr(out, value);
    }
}

fn push_cstr(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(s.as_bytes());
    out.push(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(p: Packet) {
        assert_eq!(Packet::decode(&p.encode()), Ok(p));
    }

    #[test]
    fn roundtrips_all_packet_kinds() {
        roundtrip(Packet::ReadRequest {
            filename: "c2960-lanbasek9.bin".into(),
            mode: Mode::Octet,
            options: vec![
                ("blksize".into(), "1468".into()),
                ("tsize".into(), "0".into()),
            ],
        });
        roundtrip(Packet::WriteRequest {
            filename: "sw1-confg".into(),
            mode: Mode::NetAscii,
            options: vec![],
        });
        roundtrip(Packet::OptionAck {
            options: vec![("blksize".into(), "1468".into())],
        });
        roundtrip(Packet::Data {
            block: 7,
            data: vec![0xAB; BLOCK_SIZE],
        });
        roundtrip(Packet::Ack { block: 65535 });
        roundtrip(Packet::Error {
            code: ErrorCode::FileNotFound,
            message: "nope".into(),
        });
    }

    #[test]
    fn decodes_request_mode_case_insensitively() {
        let buf = b"\x00\x01file\x00OCTET\x00BLKSIZE\x001024\x00tsize\x00";
        assert_eq!(
            Packet::decode(buf),
            Ok(Packet::ReadRequest {
                filename: "file".into(),
                mode: Mode::Octet,
                options: vec![("blksize".into(), "1024".into())],
            })
        );
    }

    #[test]
    fn rejects_malformed_packets() {
        assert_eq!(Packet::decode(&[0]), Err(PacketError::TooShort));
        assert_eq!(Packet::decode(&[0, 9]), Err(PacketError::UnknownOpcode(9)));
        assert_eq!(
            Packet::decode(b"\x00\x01\x00octet\x00"),
            Err(PacketError::Malformed("empty filename"))
        );
        assert_eq!(
            Packet::decode(b"\x00\x02f\x00mail\x00"),
            Err(PacketError::UnsupportedMode("mail".into()))
        );
        let mut big = vec![0, 3, 0, 1];
        big.extend(std::iter::repeat_n(0u8, MAX_BLOCK_SIZE + 1));
        assert_eq!(Packet::decode(&big), Err(PacketError::DataTooLarge));
    }
}
