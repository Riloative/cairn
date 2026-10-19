//! Integration tests against a local xrdp server.
//!
//! Start it with `sudo scripts/test-xrdp.sh`, then
//! `source /tmp/cairn-xrdp/env && CAIRN_RDP_TESTS=1 cargo test -p cairn-proto-rdp`.
//! Without `CAIRN_RDP_TESTS=1` these tests pass without doing anything.

use cairn_proto_rdp::frame::{TAG_FRAME, TAG_POINTER};
use cairn_proto_rdp::{
    tcp_dialer, CertInfo, ColorDepth, RdpConfig, RdpEvent, RdpInput, RdpInteract, RdpSession,
    Security,
};
use futures::future::BoxFuture;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

macro_rules! require_xrdp {
    () => {
        if std::env::var("CAIRN_RDP_TESTS").as_deref() != Ok("1") {
            eprintln!("skipped: set CAIRN_RDP_TESTS=1 after scripts/test-xrdp.sh");
            return;
        }
    };
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} not set; source /tmp/cairn-xrdp/env"))
}

fn config(width: u16, height: u16) -> RdpConfig {
    RdpConfig {
        host: env("CAIRN_RDP_HOST"),
        port: env("CAIRN_RDP_PORT").parse().expect("port"),
        username: env("CAIRN_RDP_USER"),
        password: env("CAIRN_RDP_PASSWORD").into(),
        domain: None,
        security: Security::Nla,
        color_depth: ColorDepth::Bpp32,
        width,
        height,
        scale_factor: 0,
        clipboard: true,
    }
}

#[derive(Default)]
struct Recorder {
    trust: bool,
    certs: Mutex<Vec<CertInfo>>,
    events: Mutex<Vec<RdpEvent>>,
    frames: Mutex<Vec<Vec<u8>>>,
}

impl RdpInteract for Recorder {
    fn certificate(&self, cert: CertInfo) -> BoxFuture<'static, bool> {
        self.certs.lock().expect("lock").push(cert);
        let trust = self.trust;
        Box::pin(async move { trust })
    }

    fn event(&self, event: RdpEvent) {
        self.events.lock().expect("lock").push(event);
    }

    fn frame(&self, message: Vec<u8>) {
        self.frames.lock().expect("lock").push(message);
    }
}

impl Recorder {
    fn closed(&self) -> Option<(bool, String)> {
        self.events
            .lock()
            .expect("lock")
            .iter()
            .find_map(|e| match e {
                RdpEvent::Closed { graceful, message } => Some((*graceful, message.clone())),
                _ => None,
            })
    }

    /// Wait until `done` holds, failing early if the session closes.
    fn wait(&self, what: &str, secs: u64, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < deadline {
            if done(self) {
                return;
            }
            if let Some(closed) = self.closed() {
                panic!("session closed while waiting for {what}: {closed:?}");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!(
            "timed out waiting for {what}; events: {:?}",
            self.events.lock()
        );
    }

    /// Pixels received in frame messages that are not pure black.
    fn lit_pixels(&self) -> usize {
        let frames = self.frames.lock().expect("lock");
        frames
            .iter()
            .filter(|m| m.first() == Some(&TAG_FRAME))
            .map(|m| {
                m[7..]
                    .chunks(4)
                    .filter(|p| p.len() == 4 && p[..3] != [0, 0, 0])
                    .count()
            })
            .sum()
    }
}

/// Rebuild the desktop from the frame messages and write it as a PPM image, for
/// looking at what the test saw: `CAIRN_RDP_DUMP=/tmp/rdp.ppm`.
fn dump(rec: &Recorder) {
    let Ok(path) = std::env::var("CAIRN_RDP_DUMP") else {
        return;
    };
    let frames = rec.frames.lock().expect("lock");
    let mut desk: Vec<u8> = Vec::new();
    let (mut dw, mut dh) = (0usize, 0usize);
    let le = |m: &[u8], at: usize| usize::from(u16::from_le_bytes([m[at], m[at + 1]]));
    for m in frames.iter().filter(|m| m[0] == TAG_FRAME) {
        let (w, h) = (le(m, 1), le(m, 3));
        if (w, h) != (dw, dh) {
            (dw, dh) = (w, h);
            desk = vec![0; w * h * 3];
        }
        let mut at = 7;
        for _ in 0..le(m, 5) {
            let (x, y, rw, rh) = (le(m, at), le(m, at + 2), le(m, at + 4), le(m, at + 6));
            at += 8;
            for row in 0..rh {
                for col in 0..rw {
                    let px = &m[at + (row * rw + col) * 4..][..3];
                    let o = ((y + row) * dw + x + col) * 3;
                    desk[o..o + 3].copy_from_slice(px);
                }
            }
            at += rw * rh * 4;
        }
    }
    let mut out = format!("P6\n{dw} {dh}\n255\n").into_bytes();
    out.extend_from_slice(&desk);
    std::fs::write(path, out).expect("write dump");
}

fn start(trust: bool, width: u16, height: u16) -> (RdpSession, Arc<Recorder>) {
    let recorder = Arc::new(Recorder {
        trust,
        ..Default::default()
    });
    let cfg = config(width, height);
    let dialer = tcp_dialer(cfg.host.clone(), cfg.port);
    let session = RdpSession::start(cfg, dialer, recorder.clone());
    (session, recorder)
}

#[test]
fn rejected_certificate_stops_before_sign_in() {
    require_xrdp!();
    let (_session, rec) = start(false, 1024, 768);
    rec.wait("the close", 30, |r| r.closed().is_some());
    let (graceful, message) = rec.closed().expect("closed");
    assert!(!graceful);
    assert!(message.contains("certificate was not trusted"), "{message}");
    let certs = rec.certs.lock().expect("lock");
    assert_eq!(certs.len(), 1);
    assert_eq!(certs[0].port, 3389);
    assert!(certs[0].fingerprint.len() == 95, "{}", certs[0].fingerprint);
    // Nothing past the TLS phase happened.
    assert!(!rec
        .events
        .lock()
        .expect("lock")
        .iter()
        .any(|e| matches!(e, RdpEvent::Connected { .. })));
}

#[test]
fn connects_streams_frames_takes_input_and_closes() {
    require_xrdp!();
    let (session, rec) = start(true, 1024, 768);
    rec.wait("the desktop", 60, |r| {
        r.events
            .lock()
            .expect("lock")
            .iter()
            .any(|e| matches!(e, RdpEvent::Connected { .. }))
    });
    let size = rec
        .events
        .lock()
        .expect("lock")
        .iter()
        .find_map(|e| match e {
            RdpEvent::Connected { width, height } => Some((*width, *height)),
            _ => None,
        });
    assert_eq!(size, Some((1024, 768)));
    // The xterm session paints something other than black.
    rec.wait("painted frames", 60, |r| r.lit_pixels() > 1000);
    {
        let frames = rec.frames.lock().expect("lock");
        let first = frames.iter().find(|m| m[0] == TAG_FRAME).expect("a frame");
        assert_eq!(u16::from_le_bytes([first[1], first[2]]), 1024);
        assert_eq!(u16::from_le_bytes([first[3], first[4]]), 768);
        assert!(frames
            .iter()
            .all(|m| m[0] == TAG_FRAME || m[0] == TAG_POINTER));
    }

    // Typing into the xterm repaints it.
    let before = rec.frames.lock().expect("lock").len();
    let mut keys = vec![RdpInput::Move { x: 200, y: 100 }];
    for code in ["KeyE", "KeyC", "KeyH", "KeyO", "Space", "KeyX"] {
        keys.push(RdpInput::Key {
            code: code.into(),
            down: true,
        });
        keys.push(RdpInput::Key {
            code: code.into(),
            down: false,
        });
    }
    session.input(keys);
    rec.wait("a repaint after typing", 30, |r| {
        r.frames.lock().expect("lock").len() > before
    });
    std::thread::sleep(Duration::from_millis(300));
    dump(&rec);
    session.input(vec![RdpInput::ReleaseAll]);
    session.ctrl_alt_del();

    // xrdp 0.9 has no Display Control: a resize request is kept pending and the session
    // carries on at its size (the view scales). Servers with it answer with `Resized`.
    session.resize(1280, 800, 100);
    std::thread::sleep(Duration::from_millis(500));
    assert!(rec.closed().is_none(), "{:?}", rec.closed());

    session.close();
    rec.wait("the close", 30, |r| r.closed().is_some());
    let (graceful, message) = rec.closed().expect("closed");
    assert!(graceful, "{message}");
}
