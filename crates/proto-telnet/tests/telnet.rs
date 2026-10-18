//! Telnet integration tests: a scripted fake server (always) and a real telnetd started
//! by `scripts/test-telnetd.sh` (when `CAIRN_TELNET_PORT` is set).

use cairn_core::terminal::{CloseReason, EventSink, TermEvent, TerminalSession};
use cairn_proto_telnet::{TelnetOptions, TelnetSession};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const IAC: u8 = 255;
const SB: u8 = 250;
const SE: u8 = 240;
const DO: u8 = 253;

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

fn start(port: u16, raw: bool, sink: EventSink) -> TelnetSession {
    TelnetSession::start(
        &tokio::runtime::Handle::current(),
        TelnetOptions {
            host: "127.0.0.1".into(),
            port,
            raw,
            connect_timeout_secs: 5,
        },
        100,
        30,
        sink,
        Box::new(|| {}),
    )
}

/// Read from the server side until `pred` holds on everything received so far.
async fn read_until(s: &mut tokio::net::TcpStream, pred: impl Fn(&[u8]) -> bool) -> Vec<u8> {
    let mut all = Vec::new();
    let mut buf = [0u8; 1024];
    let deadline = Instant::now() + Duration::from_secs(5);
    while !pred(&all) {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, s.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => all.extend_from_slice(&buf[..n]),
            _ => panic!("server did not receive the expected bytes; got {all:?}"),
        }
    }
    all
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn negotiates_naws_ttype_and_break_with_a_scripted_server() {
    let l = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = l.local_addr().expect("addr").port();
    let (sink, rx) = sink();
    let session = start(port, false, sink);
    let (mut srv, _) = l.accept().await.expect("accept");

    srv.write_all(&[IAC, DO, 31, IAC, DO, 24, IAC, SB, 24, 1, IAC, SE])
        .await
        .expect("write");
    let got = read_until(&mut srv, |b| contains(b, b"XTERM-256COLOR")).await;
    assert!(
        contains(&got, &[IAC, SB, 31, 0, 100, 0, 30, IAC, SE]),
        "{got:?}"
    );

    session.resize(120, 40).expect("resize");
    read_until(&mut srv, |b| {
        contains(b, &[IAC, SB, 31, 0, 120, 0, 40, IAC, SE])
    })
    .await;

    session.write(b"show ver\r").expect("write");
    read_until(&mut srv, |b| contains(b, b"show ver\r\n")).await;

    session.send_break().expect("break");
    read_until(&mut srv, |b| contains(b, &[IAC, 243])).await;

    srv.write_all(b"Router>").await.expect("write");
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut data = Vec::new();
    while !contains(&data, b"Router>") && Instant::now() < deadline {
        if let Ok(TermEvent::Data(d)) = rx.recv_timeout(Duration::from_millis(100)) {
            data.extend(d);
        }
    }
    assert_eq!(data, b"Router>");
    drop(srv);
    let reason = tokio::task::spawn_blocking(move || loop {
        if let Ok(TermEvent::Closed(r)) = rx.recv_timeout(Duration::from_secs(5)) {
            return r;
        }
    })
    .await
    .expect("join");
    assert_eq!(reason, CloseReason::Exited { code: None });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn raw_mode_passes_bytes_untouched() {
    let l = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = l.local_addr().expect("addr").port();
    let (sink, rx) = sink();
    let session = start(port, true, sink);
    let (mut srv, _) = l.accept().await.expect("accept");
    srv.write_all(&[IAC, DO, 31, b'x']).await.expect("write");
    session.write(b"a\r").expect("write");
    let got = read_until(&mut srv, |b| b.len() >= 2).await;
    assert_eq!(
        got, b"a\r",
        "no CR LF translation or negotiation in raw mode"
    );
    let mut data = Vec::new();
    while data.len() < 4 {
        if let Ok(TermEvent::Data(d)) = rx.recv_timeout(Duration::from_secs(5)) {
            data.extend(d);
        }
    }
    assert_eq!(data, [IAC, DO, 31, b'x']);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refused_connections_are_explained() {
    let l = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = l.local_addr().expect("addr").port();
    drop(l);
    let (sink, rx) = sink();
    let _s = start(port, false, sink);
    let reason = tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)))
        .await
        .expect("join");
    match reason {
        Ok(TermEvent::Closed(CloseReason::Error { message })) => {
            assert!(message.contains("refused"), "{message}")
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_telnetd_runs_a_shell() {
    let Ok(port) = std::env::var("CAIRN_TELNET_PORT") else {
        eprintln!("skipped: set CAIRN_TELNET_PORT after scripts/test-telnetd.sh");
        return;
    };
    let (sink, rx) = sink();
    let session = start(port.parse().expect("port"), false, sink);
    tokio::time::sleep(Duration::from_secs(1)).await;
    session
        .write(b"stty size; echo telnet-$((6*7))\r")
        .expect("write");
    let out = tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Ok(TermEvent::Data(d)) = rx.recv_timeout(Duration::from_millis(200)) {
                out.extend(d);
                if contains(&out, b"telnet-42") {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    })
    .await
    .expect("join");
    assert!(out.contains("telnet-42"), "{out}");
    assert!(out.contains("30 100"), "NAWS size reached the pty: {out}");
    session.close();
}
