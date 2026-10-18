//! Xmodem, Xmodem-1K and Ymodem (batch) file transfer, for firmware recovery over a
//! console port. Protocol logic only: I/O goes through [`Link`], so the same code runs
//! over a serial port, in tests over an in-memory pipe, or against `lrzsz`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const SOH: u8 = 0x01;
const STX: u8 = 0x02;
const EOT: u8 = 0x04;
const ACK: u8 = 0x06;
const NAK: u8 = 0x15;
const CAN: u8 = 0x18;
const CRC_REQ: u8 = b'C';
const SUB: u8 = 0x1a;

const MAX_RETRIES: u32 = 10;
/// How long the sender waits for the receiver to start.
pub const START_TIMEOUT: Duration = Duration::from_secs(60);
const BLOCK_TIMEOUT: Duration = Duration::from_secs(10);
const BYTE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Variant {
    /// 128-byte blocks, CRC-16 or checksum (negotiated by the receiver).
    Xmodem,
    /// 1024-byte blocks with CRC-16.
    Xmodem1k,
    /// Batch transfer with file name and size (1024-byte blocks, CRC-16).
    Ymodem,
}

/// Byte transport used by the protocol.
pub trait Link {
    fn send(&mut self, data: &[u8]) -> std::io::Result<()>;
    /// Next byte, or `None` on timeout.
    fn recv(&mut self, timeout: Duration) -> std::io::Result<Option<u8>>;
    /// Discard pending input (after an error, before a NAK).
    fn purge(&mut self) {
        while let Ok(Some(_)) = self.recv(Duration::from_millis(20)) {}
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub bytes: u64,
    pub total: Option<u64>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TransferError {
    #[error("The other side did not start the transfer in time.")]
    NoStart,
    #[error("Too many errors on block {0}; the line is too noisy or the settings do not match.")]
    TooManyRetries(u32),
    #[error("The other side cancelled the transfer.")]
    RemoteCancelled,
    #[error("The transfer was cancelled.")]
    Cancelled,
    #[error("Protocol error: {0}")]
    Protocol(String),
    #[error("I/O error: {0}")]
    Io(String),
}

impl From<std::io::Error> for TransferError {
    fn from(e: std::io::Error) -> Self {
        TransferError::Io(e.to_string())
    }
}

pub fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in data {
        crc ^= u16::from(b) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn checksum(data: &[u8]) -> u8 {
    data.iter().fold(0u8, |a, &b| a.wrapping_add(b))
}

fn check_cancel(cancel: &AtomicBool, link: &mut dyn Link) -> Result<(), TransferError> {
    if cancel.load(Ordering::SeqCst) {
        let _ = link.send(&[CAN, CAN, CAN, CAN, CAN]);
        return Err(TransferError::Cancelled);
    }
    Ok(())
}

/// A file to send.
#[derive(Debug, Clone)]
pub struct OutgoingFile {
    pub name: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceivedFile {
    /// From the Ymodem header; `None` for Xmodem.
    pub name: Option<String>,
    pub data: Vec<u8>,
}

// ── Sending ───────────────────────────────────────────────────────────────────────

/// Wait for the receiver's start byte; returns true for CRC mode.
fn wait_start(
    link: &mut dyn Link,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<bool, TransferError> {
    let deadline = Instant::now() + timeout;
    let mut cans = 0;
    while Instant::now() < deadline {
        check_cancel(cancel, link)?;
        match link.recv(Duration::from_millis(500))? {
            Some(CRC_REQ) => return Ok(true),
            Some(NAK) => return Ok(false),
            Some(CAN) => {
                cans += 1;
                if cans >= 2 {
                    return Err(TransferError::RemoteCancelled);
                }
            }
            _ => {}
        }
    }
    Err(TransferError::NoStart)
}

fn send_block(
    link: &mut dyn Link,
    cancel: &AtomicBool,
    num: u8,
    payload: &[u8],
    size: usize,
    crc: bool,
    pad: u8,
) -> Result<(), TransferError> {
    let mut block = Vec::with_capacity(size + 5);
    block.push(if size == 1024 { STX } else { SOH });
    block.push(num);
    block.push(!num);
    let mut data = payload.to_vec();
    data.resize(size, pad);
    block.extend_from_slice(&data);
    if crc {
        block.extend_from_slice(&crc16(&data).to_be_bytes());
    } else {
        block.push(checksum(&data));
    }
    for _ in 0..MAX_RETRIES {
        check_cancel(cancel, link)?;
        link.send(&block)?;
        let deadline = Instant::now() + BLOCK_TIMEOUT;
        loop {
            match link.recv(deadline.saturating_duration_since(Instant::now()))? {
                Some(ACK) => return Ok(()),
                Some(NAK) | None => break,
                Some(CAN) => {
                    if link.recv(BYTE_TIMEOUT)? == Some(CAN) {
                        return Err(TransferError::RemoteCancelled);
                    }
                }
                // Stray bytes (e.g. extra 'C') are ignored while waiting.
                Some(_) => {}
            }
            if Instant::now() >= deadline {
                break;
            }
        }
    }
    Err(TransferError::TooManyRetries(u32::from(num)))
}

fn send_eot(link: &mut dyn Link, ymodem: bool) -> Result<(), TransferError> {
    for attempt in 0..MAX_RETRIES {
        link.send(&[EOT])?;
        match link.recv(BLOCK_TIMEOUT)? {
            Some(ACK) => return Ok(()),
            // Ymodem receivers NAK the first EOT by design.
            Some(NAK) if ymodem || attempt > 0 => continue,
            _ => continue,
        }
    }
    Err(TransferError::Protocol(
        "no acknowledgment of end of file".into(),
    ))
}

fn send_data(
    link: &mut dyn Link,
    cancel: &AtomicBool,
    data: &[u8],
    block_size: usize,
    crc: bool,
    on_sent: &mut dyn FnMut(u64),
) -> Result<(), TransferError> {
    // Xmodem with checksum only supports 128-byte blocks.
    let size = if crc { block_size } else { 128 };
    let mut num: u8 = 1;
    let mut sent = 0usize;
    for chunk in data.chunks(size) {
        // Use short blocks for the tail of 1K transfers (less padding).
        let this = if size == 1024 && chunk.len() <= 128 {
            128
        } else {
            size
        };
        send_block(link, cancel, num, chunk, this, crc, SUB)?;
        num = num.wrapping_add(1);
        sent += chunk.len();
        on_sent(sent as u64);
    }
    Ok(())
}

/// Send files. Xmodem variants send only the first file.
pub fn send(
    link: &mut dyn Link,
    variant: Variant,
    files: &[OutgoingFile],
    progress: &mut dyn FnMut(Progress),
    cancel: &AtomicBool,
) -> Result<(), TransferError> {
    let total: u64 = files.iter().map(|f| f.data.len() as u64).sum();
    match variant {
        Variant::Xmodem | Variant::Xmodem1k => {
            let file = files
                .first()
                .ok_or_else(|| TransferError::Protocol("no file to send".into()))?;
            let crc = wait_start(link, cancel, START_TIMEOUT)?;
            let size = if variant == Variant::Xmodem1k {
                1024
            } else {
                128
            };
            send_data(link, cancel, &file.data, size, crc, &mut |n| {
                progress(Progress {
                    bytes: n,
                    total: Some(total),
                })
            })?;
            send_eot(link, false)
        }
        Variant::Ymodem => {
            let mut done = 0u64;
            for f in files {
                wait_start(link, cancel, START_TIMEOUT)?;
                let mut header = Vec::with_capacity(128);
                let name = f.name.rsplit(['/', '\\']).next().unwrap_or(&f.name);
                header.extend_from_slice(name.as_bytes());
                header.push(0);
                header.extend_from_slice(format!("{}", f.data.len()).as_bytes());
                let size = if header.len() > 128 { 1024 } else { 128 };
                send_block(link, cancel, 0, &header, size, true, 0)?;
                wait_start(link, cancel, BLOCK_TIMEOUT)?;
                send_data(link, cancel, &f.data, 1024, true, &mut |n| {
                    progress(Progress {
                        bytes: done + n,
                        total: Some(total),
                    })
                })?;
                send_eot(link, true)?;
                done += f.data.len() as u64;
            }
            // Empty header ends the batch. Some receivers (lrzsz `rb`) exit on it without
            // an ACK; every file was already acknowledged, so silence counts as done.
            wait_start(link, cancel, BLOCK_TIMEOUT)?;
            let mut end = vec![SOH, 0, 0xff];
            end.extend_from_slice(&[0u8; 128]);
            end.extend_from_slice(&crc16(&[0u8; 128]).to_be_bytes());
            link.send(&end)?;
            let _ = link.recv(Duration::from_secs(2))?;
            Ok(())
        }
    }
}

// ── Receiving ─────────────────────────────────────────────────────────────────────

enum Frame {
    Block(u8, Vec<u8>),
    Eot,
    Cancel,
    Bad,
    Timeout,
}

fn read_frame(
    link: &mut dyn Link,
    crc: bool,
    first_timeout: Duration,
) -> Result<Frame, TransferError> {
    let size = match link.recv(first_timeout)? {
        None => return Ok(Frame::Timeout),
        Some(SOH) => 128,
        Some(STX) => 1024,
        Some(EOT) => return Ok(Frame::Eot),
        Some(CAN) => {
            return Ok(if link.recv(BYTE_TIMEOUT)? == Some(CAN) {
                Frame::Cancel
            } else {
                Frame::Bad
            })
        }
        Some(_) => return Ok(Frame::Bad),
    };
    let mut rest = Vec::with_capacity(size + 4);
    let need = size + 2 + if crc { 2 } else { 1 };
    while rest.len() < need {
        match link.recv(BYTE_TIMEOUT)? {
            Some(b) => rest.push(b),
            None => return Ok(Frame::Bad),
        }
    }
    let (num, inv) = (rest[0], rest[1]);
    let data = rest[2..2 + size].to_vec();
    let ok_check = if crc {
        let got = u16::from_be_bytes([rest[2 + size], rest[3 + size]]);
        got == crc16(&data)
    } else {
        rest[2 + size] == checksum(&data)
    };
    if num != !inv || !ok_check {
        return Ok(Frame::Bad);
    }
    Ok(Frame::Block(num, data))
}

/// Receive one file body (after any Ymodem header). Returns raw block data.
fn receive_body(
    link: &mut dyn Link,
    cancel: &AtomicBool,
    crc: bool,
    mut start_byte: Option<u8>,
    ymodem: bool,
    progress: &mut dyn FnMut(Progress),
    total: Option<u64>,
) -> Result<Vec<u8>, TransferError> {
    let mut out = Vec::new();
    let mut expected: u8 = 1;
    let mut errors = 0u32;
    let mut eots = 0;
    loop {
        check_cancel(cancel, link)?;
        if let Some(b) = start_byte {
            link.send(&[b])?;
        }
        match read_frame(link, crc, BLOCK_TIMEOUT)? {
            Frame::Block(num, data) if num == expected => {
                out.extend_from_slice(&data);
                expected = expected.wrapping_add(1);
                errors = 0;
                start_byte = None;
                link.send(&[ACK])?;
                progress(Progress {
                    bytes: out.len() as u64,
                    total,
                });
            }
            // Retransmission of the block we already have (our ACK was lost).
            Frame::Block(num, _) if num == expected.wrapping_sub(1) => link.send(&[ACK])?,
            Frame::Block(..) => {
                return Err(TransferError::Protocol("block out of sequence".into()))
            }
            Frame::Eot => {
                eots += 1;
                if ymodem && eots == 1 {
                    link.send(&[NAK])?;
                    continue;
                }
                link.send(&[ACK])?;
                return Ok(out);
            }
            Frame::Cancel => return Err(TransferError::RemoteCancelled),
            Frame::Bad | Frame::Timeout => {
                errors += 1;
                if errors > MAX_RETRIES {
                    return Err(TransferError::TooManyRetries(u32::from(expected)));
                }
                link.purge();
                if start_byte.is_none() {
                    link.send(&[NAK])?;
                }
            }
        }
    }
}

/// Receive file(s). Xmodem returns one file with trailing SUB padding removed (Xmodem
/// does not carry the length); Ymodem returns every file of the batch, exact sizes.
pub fn receive(
    link: &mut dyn Link,
    variant: Variant,
    progress: &mut dyn FnMut(Progress),
    cancel: &AtomicBool,
) -> Result<Vec<ReceivedFile>, TransferError> {
    match variant {
        Variant::Xmodem | Variant::Xmodem1k => {
            // Ask for CRC mode; 'C' is resent until the first block arrives.
            let mut data = receive_body(link, cancel, true, Some(CRC_REQ), false, progress, None)?;
            while data.last() == Some(&SUB) {
                data.pop();
            }
            Ok(vec![ReceivedFile { name: None, data }])
        }
        Variant::Ymodem => {
            let mut files = Vec::new();
            loop {
                let header = receive_header(link, cancel)?;
                let Some((name, size)) = header else {
                    return Ok(files);
                };
                let mut data =
                    receive_body(link, cancel, true, Some(CRC_REQ), true, progress, size)?;
                if let Some(size) = size {
                    data.truncate(size as usize);
                }
                files.push(ReceivedFile {
                    name: Some(name),
                    data,
                });
            }
        }
    }
}

/// Receive a Ymodem block 0: `Some((name, size))`, or `None` at the end of the batch.
fn receive_header(
    link: &mut dyn Link,
    cancel: &AtomicBool,
) -> Result<Option<(String, Option<u64>)>, TransferError> {
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        check_cancel(cancel, link)?;
        link.send(&[CRC_REQ])?;
        match read_frame(link, true, Duration::from_secs(3))? {
            Frame::Block(0, data) => {
                link.send(&[ACK])?;
                if data.first().copied().unwrap_or(0) == 0 {
                    return Ok(None);
                }
                let nul = data.iter().position(|&b| b == 0).unwrap_or(data.len());
                let name = String::from_utf8_lossy(&data[..nul]).into_owned();
                let meta = &data[(nul + 1).min(data.len())..];
                let meta_end = meta.iter().position(|&b| b == 0).unwrap_or(meta.len());
                let size = String::from_utf8_lossy(&meta[..meta_end])
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse().ok());
                return Ok(Some((sanitize_name(&name), size)));
            }
            Frame::Cancel => return Err(TransferError::RemoteCancelled),
            Frame::Eot => link.send(&[ACK])?,
            _ if Instant::now() < deadline => link.purge(),
            _ => return Err(TransferError::NoStart),
        }
    }
}

/// Keep only the final path component of a remote-supplied file name.
pub fn sanitize_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control()).collect();
    match clean.trim() {
        "" | "." | ".." => "received.bin".into(),
        s => s.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::Arc;

    /// One end of an in-memory duplex pipe, with optional corruption of outgoing bytes.
    struct Pipe {
        tx: Sender<u8>,
        rx: Receiver<u8>,
        /// Flip a byte every N bytes sent (0 = never).
        corrupt_every: usize,
        sent: usize,
    }

    impl Link for Pipe {
        fn send(&mut self, data: &[u8]) -> std::io::Result<()> {
            for &b in data {
                self.sent += 1;
                let b = if self.corrupt_every > 0 && self.sent % self.corrupt_every == 0 {
                    b ^ 0x55
                } else {
                    b
                };
                let _ = self.tx.send(b);
            }
            Ok(())
        }
        fn recv(&mut self, timeout: Duration) -> std::io::Result<Option<u8>> {
            Ok(self.rx.recv_timeout(timeout).ok())
        }
    }

    fn pair(corrupt_every: usize) -> (Pipe, Pipe) {
        let (a_tx, b_rx) = channel();
        let (b_tx, a_rx) = channel();
        (
            Pipe {
                tx: a_tx,
                rx: a_rx,
                corrupt_every,
                sent: 0,
            },
            Pipe {
                tx: b_tx,
                rx: b_rx,
                corrupt_every: 0,
                sent: 0,
            },
        )
    }

    fn data(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 % 251) as u8).collect()
    }

    fn roundtrip(
        variant: Variant,
        files: Vec<OutgoingFile>,
        corrupt_every: usize,
    ) -> Vec<ReceivedFile> {
        let (mut a, mut b) = pair(corrupt_every);
        let cancel = Arc::new(AtomicBool::new(false));
        let c2 = cancel.clone();
        let sender = std::thread::spawn(move || send(&mut a, variant, &files, &mut |_| {}, &c2));
        let got = receive(&mut b, variant, &mut |_| {}, &cancel).expect("receive");
        sender.join().expect("join").expect("send");
        got
    }

    #[test]
    fn crc16_known_vector() {
        assert_eq!(crc16(b"123456789"), 0x31c3);
    }

    #[test]
    fn xmodem_roundtrip() {
        let d = data(1000);
        let got = roundtrip(
            Variant::Xmodem,
            vec![OutgoingFile {
                name: "f".into(),
                data: d.clone(),
            }],
            0,
        );
        assert_eq!(got[0].data, d);
    }

    #[test]
    fn xmodem_1k_roundtrip_with_block_number_wrap() {
        let d = data(300 * 1024 + 77);
        let got = roundtrip(
            Variant::Xmodem1k,
            vec![OutgoingFile {
                name: "f".into(),
                data: d.clone(),
            }],
            0,
        );
        assert_eq!(got[0].data, d);
    }

    #[test]
    fn recovers_from_line_noise() {
        let d = data(5000);
        let got = roundtrip(
            Variant::Xmodem1k,
            vec![OutgoingFile {
                name: "f".into(),
                data: d.clone(),
            }],
            1500,
        );
        assert_eq!(got[0].data, d);
    }

    #[test]
    fn ymodem_batch_keeps_names_and_exact_sizes() {
        let files = vec![
            OutgoingFile {
                name: "/tmp/c2960-lanbasek9.bin".into(),
                data: data(3000),
            },
            OutgoingFile {
                name: "config.txt".into(),
                data: b"hostname sw1\n".to_vec(),
            },
        ];
        let got = roundtrip(Variant::Ymodem, files.clone(), 0);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name.as_deref(), Some("c2960-lanbasek9.bin"));
        assert_eq!(got[0].data, files[0].data);
        assert_eq!(got[1].data, files[1].data);
    }

    #[test]
    fn sender_cancel_stops_the_transfer() {
        let (mut a, mut b) = pair(0);
        let cancel = Arc::new(AtomicBool::new(true));
        let c = cancel.clone();
        let t = std::thread::spawn(move || {
            send(
                &mut a,
                Variant::Xmodem,
                &[OutgoingFile {
                    name: "f".into(),
                    data: data(100),
                }],
                &mut |_| {},
                &c,
            )
        });
        b.send(&[CRC_REQ]).expect("send");
        assert_eq!(t.join().expect("join"), Err(TransferError::Cancelled));
    }

    #[test]
    fn remote_cancel_is_reported() {
        let (mut a, mut b) = pair(0);
        b.send(&[CAN, CAN]).expect("send");
        let cancel = AtomicBool::new(false);
        let r = send(
            &mut a,
            Variant::Xmodem,
            &[OutgoingFile {
                name: "f".into(),
                data: data(10),
            }],
            &mut |_| {},
            &cancel,
        );
        assert_eq!(r, Err(TransferError::RemoteCancelled));
    }

    #[test]
    fn sanitizes_remote_names() {
        assert_eq!(sanitize_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_name("C:\\\\boot\\\\ios.bin"), "ios.bin");
        assert_eq!(sanitize_name(".."), "received.bin");
    }
}
