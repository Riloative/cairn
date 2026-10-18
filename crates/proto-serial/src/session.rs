//! A serial console session as a [`TerminalSession`], with line controls and file
//! transfers that temporarily take over the port.

use crate::error::SerialError;
use crate::settings::{LineSettings, NewlineMapping};
use crate::xmodem::{self, Link, OutgoingFile, Progress, ReceivedFile, Variant};
use cairn_core::terminal::{CloseReason, EventSink, TermEvent, TerminalError, TerminalSession};
use parking_lot::Mutex;
use serde::Deserialize;
use serialport::SerialPort;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::Duration;

/// Everything needed to open a serial session.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialOptions {
    pub path: String,
    #[serde(default)]
    pub settings: LineSettings,
    #[serde(default)]
    pub newline: NewlineMapping,
    #[serde(default)]
    pub local_echo: bool,
}

/// How long BREAK is held (Cisco ROMMON wants at least ~250 ms).
pub const BREAK_DURATION: Duration = Duration::from_millis(500);
const READ_TIMEOUT: Duration = Duration::from_millis(50);

/// Where received bytes go.
enum Route {
    Terminal,
    Transfer(Sender<u8>),
}

struct Shared {
    route: Mutex<Route>,
    closing: AtomicBool,
    newline: NewlineMapping,
    local_echo: bool,
    sink: EventSink,
}

pub struct SerialSession {
    writer: Mutex<Box<dyn SerialPort>>,
    shared: Arc<Shared>,
    transfer_busy: AtomicBool,
}

impl std::fmt::Debug for SerialSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SerialSession").finish_non_exhaustive()
    }
}

fn io(e: std::io::Error) -> TerminalError {
    TerminalError::Io(e.to_string())
}

impl SerialSession {
    pub fn open(opts: &SerialOptions, sink: EventSink) -> Result<Arc<Self>, SerialError> {
        opts.settings.validate()?;
        let s = &opts.settings;
        let port = serialport::new(&opts.path, s.baud)
            .data_bits(s.data_bits.into())
            .parity(s.parity.into())
            .stop_bits(s.stop_bits.into())
            .flow_control(s.flow_control.into())
            .timeout(READ_TIMEOUT)
            .open()
            .map_err(|e| SerialError::from_open(e, &opts.path))?;
        let reader = port
            .try_clone()
            .map_err(|e| SerialError::from_open(e, &opts.path))?;
        let shared = Arc::new(Shared {
            route: Mutex::new(Route::Terminal),
            closing: AtomicBool::new(false),
            newline: opts.newline,
            local_echo: opts.local_echo,
            sink,
        });
        let session = Arc::new(Self {
            writer: Mutex::new(port),
            shared: shared.clone(),
            transfer_busy: AtomicBool::new(false),
        });
        let path = opts.path.clone();
        std::thread::Builder::new()
            .name("cairn-serial-reader".into())
            .spawn(move || read_loop(reader, shared, path))
            .map_err(|e| SerialError::Io(e.to_string()))?;
        Ok(session)
    }

    pub fn set_dtr(&self, on: bool) -> Result<(), TerminalError> {
        self.writer
            .lock()
            .write_data_terminal_ready(on)
            .map_err(|e| TerminalError::Io(e.to_string()))
    }

    pub fn set_rts(&self, on: bool) -> Result<(), TerminalError> {
        self.writer
            .lock()
            .write_request_to_send(on)
            .map_err(|e| TerminalError::Io(e.to_string()))
    }

    /// Send a BREAK condition (password recovery: Cisco ROMMON, Juniper, …).
    pub fn send_break(&self) -> Result<(), TerminalError> {
        let port = self.writer.lock();
        port.set_break()
            .map_err(|e| TerminalError::Io(e.to_string()))?;
        std::thread::sleep(BREAK_DURATION);
        port.clear_break()
            .map_err(|e| TerminalError::Io(e.to_string()))
    }

    /// Run a transfer with exclusive use of the port. Received bytes stop going to the
    /// terminal until it finishes.
    fn with_link<T>(&self, f: impl FnOnce(&mut PortLink) -> T) -> Result<T, SerialError> {
        if self.transfer_busy.swap(true, Ordering::SeqCst) {
            return Err(SerialError::Transfer(
                "a transfer is already running".into(),
            ));
        }
        let (tx, rx) = channel();
        *self.shared.route.lock() = Route::Transfer(tx);
        let writer = self
            .writer
            .lock()
            .try_clone()
            .map_err(|e| SerialError::Io(e.to_string()));
        let result = writer.map(|w| {
            let mut link = PortLink { writer: w, rx };
            f(&mut link)
        });
        *self.shared.route.lock() = Route::Terminal;
        self.transfer_busy.store(false, Ordering::SeqCst);
        result
    }

    pub fn send_files(
        &self,
        variant: Variant,
        files: &[OutgoingFile],
        progress: &mut dyn FnMut(Progress),
        cancel: &AtomicBool,
    ) -> Result<(), SerialError> {
        self.with_link(|link| xmodem::send(link, variant, files, progress, cancel))?
            .map_err(transfer_error)
    }

    pub fn receive_files(
        &self,
        variant: Variant,
        progress: &mut dyn FnMut(Progress),
        cancel: &AtomicBool,
    ) -> Result<Vec<ReceivedFile>, SerialError> {
        self.with_link(|link| xmodem::receive(link, variant, progress, cancel))?
            .map_err(transfer_error)
    }
}

fn transfer_error(e: xmodem::TransferError) -> SerialError {
    match e {
        xmodem::TransferError::Cancelled => SerialError::Cancelled,
        other => SerialError::Transfer(other.to_string()),
    }
}

struct PortLink {
    writer: Box<dyn SerialPort>,
    rx: Receiver<u8>,
}

impl Link for PortLink {
    fn send(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()
    }

    fn recv(&mut self, timeout: Duration) -> std::io::Result<Option<u8>> {
        match self.rx.recv_timeout(timeout) {
            Ok(b) => Ok(Some(b)),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "the serial port closed",
            )),
        }
    }
}

fn read_loop(mut port: Box<dyn SerialPort>, shared: Arc<Shared>, path: String) {
    let mut buf = [0u8; 4096];
    let mut prev = 0u8;
    let reason = loop {
        if shared.closing.load(Ordering::SeqCst) {
            break CloseReason::Closed;
        }
        match port.read(&mut buf) {
            Ok(0) => continue,
            Ok(n) => {
                let route = shared.route.lock();
                match &*route {
                    Route::Transfer(tx) => {
                        for &b in &buf[..n] {
                            let _ = tx.send(b);
                        }
                    }
                    Route::Terminal => {
                        let mapped = shared.newline.map_rx(&buf[..n], &mut prev);
                        (shared.sink)(TermEvent::Data(mapped));
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                break if shared.closing.load(Ordering::SeqCst) {
                    CloseReason::Closed
                } else {
                    CloseReason::Error {
                        message: format!(
                            "The serial port {path} stopped responding ({e}). Was the cable unplugged?"
                        ),
                    }
                };
            }
        }
    };
    (shared.sink)(TermEvent::Closed(reason));
}

impl TerminalSession for SerialSession {
    fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        if self.transfer_busy.load(Ordering::SeqCst) {
            // Keystrokes would corrupt the transfer.
            return Ok(());
        }
        let out = self.shared.newline.map_tx(data);
        {
            let mut w = self.writer.lock();
            w.write_all(&out).map_err(io)?;
            w.flush().map_err(io)?;
        }
        if self.shared.local_echo {
            let echo: Vec<u8> = data
                .iter()
                .flat_map(|&b| {
                    if b == b'\r' {
                        vec![b'\r', b'\n']
                    } else {
                        vec![b]
                    }
                })
                .collect();
            (self.shared.sink)(TermEvent::Data(echo));
        }
        Ok(())
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), TerminalError> {
        // Serial lines have no window-size signalling.
        Ok(())
    }

    fn close(&self) {
        self.shared.closing.store(true, Ordering::SeqCst);
    }
}
