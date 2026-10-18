//! Integration tests over a `socat` virtual null-modem (PTY pair), with `lrzsz` on the
//! far end for Xmodem/Ymodem. Skipped when `socat` (or `lrzsz`) is not installed.

use cairn_core::terminal::{CloseReason, EventSink, TermEvent, TerminalSession};
use cairn_proto_serial::xmodem::{OutgoingFile, Variant};
use cairn_proto_serial::{Newline, NewlineMapping, SerialOptions, SerialSession};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn have(cmd: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {cmd}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// A PTY pair; `a` is opened by Cairn, `b` is the "device".
struct NullModem {
    _dir: tempfile::TempDir,
    a: PathBuf,
    b: PathBuf,
    socat: Child,
}

impl NullModem {
    fn new() -> Option<Self> {
        if !have("socat") {
            eprintln!("skipped: socat not installed");
            return None;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        // CAIRN_SOCAT_LOG=<file> records a hex trace of the line (debugging aid).
        let log = std::env::var("CAIRN_SOCAT_LOG").ok();
        let mut cmd = Command::new("socat");
        if log.is_some() {
            cmd.args(["-x", "-v"]);
        }
        let socat = cmd
            .arg(format!("pty,raw,echo=0,link={}", a.display()))
            .arg(format!("pty,raw,echo=0,link={}", b.display()))
            .stderr(match &log {
                Some(path) => Stdio::from(std::fs::File::create(path).expect("log file")),
                None => Stdio::null(),
            })
            .spawn()
            .expect("socat");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !(a.exists() && b.exists()) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        Some(Self {
            _dir: dir,
            a,
            b,
            socat,
        })
    }
}

impl Drop for NullModem {
    fn drop(&mut self) {
        let _ = self.socat.kill();
        let _ = self.socat.wait();
    }
}

fn sink() -> (EventSink, Receiver<TermEvent>) {
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    (
        Arc::new(move |e| {
            let _ = tx.lock().expect("lock").send(e);
        }),
        rx,
    )
}

fn open(path: &Path, newline: NewlineMapping) -> (Arc<SerialSession>, Receiver<TermEvent>) {
    let (s, rx) = sink();
    let opts = SerialOptions {
        path: path.display().to_string(),
        settings: Default::default(),
        newline,
        local_echo: false,
    };
    (SerialSession::open(&opts, s).expect("open"), rx)
}

fn collect_until(rx: &Receiver<TermEvent>, needle: &str) -> String {
    let mut out = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(TermEvent::Data(d)) = rx.recv_timeout(Duration::from_millis(100)) {
            out.extend(d);
            if String::from_utf8_lossy(&out).contains(needle) {
                break;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn device(path: &Path) -> std::fs::File {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .expect("open device end")
}

#[test]
fn bytes_flow_both_ways_with_newline_mapping() {
    let Some(nm) = NullModem::new() else { return };
    let (s, rx) = open(
        &nm.a,
        NewlineMapping {
            transmit: Newline::CrLf,
            receive: Newline::Lf,
        },
    );
    let mut dev = device(&nm.b);
    dev.write_all(b"Switch>\nready").expect("write");
    let got = collect_until(&rx, "ready");
    assert_eq!(got, "Switch>\r\nready");

    s.write(b"enable\r").expect("write");
    let mut buf = [0u8; 8];
    dev.read_exact(&mut buf).expect("read");
    assert_eq!(&buf, b"enable\r\n");
    s.close();
}

#[test]
fn line_controls_do_not_fail_on_a_pty() {
    let Some(nm) = NullModem::new() else { return };
    let (s, _rx) = open(&nm.a, NewlineMapping::default());
    // PTYs have no modem lines (ENOTTY for DTR/RTS) but support BREAK.
    for r in [s.set_dtr(false), s.set_rts(true)] {
        if let Err(e) = r {
            assert!(e.to_string().contains("typewriter"), "{e}");
        }
    }
    s.send_break().expect("break");
    s.close();
}

#[test]
fn unplugging_reports_an_error() {
    let Some(mut nm) = NullModem::new() else {
        return;
    };
    let (_s, rx) = open(&nm.a, NewlineMapping::default());
    let _ = nm.socat.kill();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(TermEvent::Closed(CloseReason::Error { message })) => {
                assert!(message.contains("unplugged"), "{message}");
                break;
            }
            _ if Instant::now() > deadline => panic!("no close event"),
            _ => {}
        }
    }
}

/// Run an lrzsz command with the device end of the PTY as stdin/stdout.
fn lrzsz(cmd: &str, args: &[&str], dev: &Path, cwd: &Path) -> Child {
    Command::new(cmd)
        .args(args)
        .current_dir(cwd)
        .stdin(device(dev))
        .stdout(device(dev))
        .stderr(Stdio::null())
        .spawn()
        .expect("lrzsz")
}

fn payload(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i * 7 % 256) as u8).collect()
}

fn require_lrzsz() -> bool {
    if !have("sx") || !have("rb") {
        eprintln!("skipped: lrzsz not installed");
        return false;
    }
    true
}

#[test]
fn xmodem_receive_from_sx() {
    if !require_lrzsz() {
        return;
    }
    let Some(nm) = NullModem::new() else { return };
    let work = tempfile::tempdir().expect("tempdir");
    let data = payload(20_000);
    std::fs::write(work.path().join("fw.bin"), &data).expect("write");
    let (s, _rx) = open(&nm.a, NewlineMapping::default());
    let mut child = lrzsz("sx", &["fw.bin"], &nm.b, work.path());
    let files = s
        .receive_files(Variant::Xmodem, &mut |_| {}, &AtomicBool::new(false))
        .expect("receive");
    let _ = child.wait();
    // Xmodem pads to the block size; trailing padding is stripped.
    assert_eq!(files[0].data, data);
}

#[test]
fn xmodem_1k_send_to_rx() {
    if !require_lrzsz() {
        return;
    }
    let Some(nm) = NullModem::new() else { return };
    let work = tempfile::tempdir().expect("tempdir");
    let data = payload(50_000);
    let (s, _rx) = open(&nm.a, NewlineMapping::default());
    let mut child = lrzsz("rx", &["-c", "out.bin"], &nm.b, work.path());
    let mut last = 0;
    s.send_files(
        Variant::Xmodem1k,
        &[OutgoingFile {
            name: "fw.bin".into(),
            data: data.clone(),
        }],
        &mut |p| last = p.bytes,
        &AtomicBool::new(false),
    )
    .expect("send");
    let _ = child.wait();
    assert_eq!(last, data.len() as u64);
    let mut got = std::fs::read(work.path().join("out.bin")).expect("received file");
    while got.last() == Some(&0x1a) {
        got.pop();
    }
    assert_eq!(got, data);
}

#[test]
fn ymodem_both_directions() {
    if !require_lrzsz() {
        return;
    }
    let Some(nm) = NullModem::new() else { return };
    let (s, _rx) = open(&nm.a, NewlineMapping::default());

    // Cairn → rb
    let inbox = tempfile::tempdir().expect("tempdir");
    let data = payload(70_001);
    let mut child = lrzsz("rb", &[], &nm.b, inbox.path());
    s.send_files(
        Variant::Ymodem,
        &[OutgoingFile {
            name: "c2960.bin".into(),
            data: data.clone(),
        }],
        &mut |_| {},
        &AtomicBool::new(false),
    )
    .expect("send");
    let _ = child.wait();
    assert_eq!(
        std::fs::read(inbox.path().join("c2960.bin")).expect("file"),
        data
    );

    // sb → Cairn
    let outbox = tempfile::tempdir().expect("tempdir");
    std::fs::write(outbox.path().join("startup-config"), b"hostname sw1\n").expect("write");
    let mut child = lrzsz("sb", &["startup-config"], &nm.b, outbox.path());
    let files = s
        .receive_files(Variant::Ymodem, &mut |_| {}, &AtomicBool::new(false))
        .expect("receive");
    let _ = child.wait();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].name.as_deref(), Some("startup-config"));
    assert_eq!(files[0].data, b"hostname sw1\n");
}
