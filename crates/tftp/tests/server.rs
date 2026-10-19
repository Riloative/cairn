//! The TFTP server against a minimal client over loopback UDP.

use cairn_tftp::packet::Options;
use cairn_tftp::{ErrorCode, Mode, Packet, ServerConfig, ServerEvent, TftpServer};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::UdpSocket;

struct Harness {
    server: TftpServer,
    events: Arc<Mutex<Vec<ServerEvent>>>,
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
}

async fn start(read: bool, write: bool, overwrite: bool) -> Harness {
    let dir = tempfile::tempdir().expect("tmp");
    let root = dir.path().join("srv");
    std::fs::create_dir_all(root.join("images")).expect("mkdir");
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let server = TftpServer::start(
        ServerConfig {
            root: root.clone(),
            bind: "127.0.0.1:0".parse().expect("addr"),
            allow_read: read,
            allow_write: write,
            overwrite,
        },
        Arc::new(move |e| sink.lock().expect("lock").push(e)),
    )
    .await
    .expect("start");
    Harness {
        server,
        events,
        _dir: dir,
        root,
    }
}

const T: Duration = Duration::from_secs(5);

async fn recv(sock: &UdpSocket) -> (Packet, SocketAddr) {
    let mut buf = vec![0u8; 70_000];
    let (n, from) = tokio::time::timeout(T, sock.recv_from(&mut buf))
        .await
        .expect("timely reply")
        .expect("recv");
    (Packet::decode(&buf[..n]).expect("decode"), from)
}

/// Download `name`; returns the bytes or the server's error.
async fn get(
    server: SocketAddr,
    name: &str,
    mode: Mode,
    options: Options,
) -> Result<Vec<u8>, (ErrorCode, String)> {
    let sock = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
    let rrq = Packet::ReadRequest {
        filename: name.into(),
        mode,
        options: options.clone(),
    };
    sock.send_to(&rrq.encode(), server).await.expect("send");
    let mut blksize = 512;
    let mut out = Vec::new();
    let mut expect: u16 = 1;
    loop {
        let (p, tid) = recv(&sock).await;
        match p {
            Packet::OptionAck { options } => {
                if let Some((_, v)) = options.iter().find(|(n, _)| n == "blksize") {
                    blksize = v.parse().expect("blksize");
                }
                sock.send_to(&Packet::Ack { block: 0 }.encode(), tid)
                    .await
                    .expect("ack");
            }
            Packet::Data { block, data } => {
                assert_eq!(block, expect, "blocks in order");
                out.extend_from_slice(&data);
                sock.send_to(&Packet::Ack { block }.encode(), tid)
                    .await
                    .expect("ack");
                if data.len() < blksize {
                    return Ok(out);
                }
                expect = expect.wrapping_add(1);
            }
            Packet::Error { code, message } => return Err((code, message)),
            other => panic!("unexpected {other:?}"),
        }
    }
}

/// Upload `data` as `name`.
async fn put(
    server: SocketAddr,
    name: &str,
    data: &[u8],
    blksize: usize,
) -> Result<(), (ErrorCode, String)> {
    let sock = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
    let options = if blksize == 512 {
        vec![]
    } else {
        vec![("blksize".to_owned(), blksize.to_string())]
    };
    let wrq = Packet::WriteRequest {
        filename: name.into(),
        mode: Mode::Octet,
        options,
    };
    sock.send_to(&wrq.encode(), server).await.expect("send");
    let (first, tid) = recv(&sock).await;
    match first {
        Packet::Ack { block: 0 } | Packet::OptionAck { .. } => {}
        Packet::Error { code, message } => return Err((code, message)),
        other => panic!("unexpected {other:?}"),
    }
    let mut block: u16 = 1;
    let mut chunks: Vec<&[u8]> = data.chunks(blksize).collect();
    if data.len().is_multiple_of(blksize) {
        chunks.push(&[]);
    }
    for chunk in chunks {
        let pkt = Packet::Data {
            block,
            data: chunk.to_vec(),
        };
        sock.send_to(&pkt.encode(), tid).await.expect("data");
        match recv(&sock).await.0 {
            Packet::Ack { block: b } => assert_eq!(b, block),
            Packet::Error { code, message } => return Err((code, message)),
            other => panic!("unexpected {other:?}"),
        }
        block = block.wrapping_add(1);
    }
    Ok(())
}

fn write(root: &Path, name: &str, data: &[u8]) {
    std::fs::write(root.join(name), data).expect("write");
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(50)).await;
}

#[tokio::test]
async fn serves_files_with_and_without_options() {
    let h = start(true, false, false).await;
    let image: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
    write(&h.root.join("images"), "ios.bin", &image);
    let addr = h.server.local_addr();

    assert_eq!(
        get(addr, "images/ios.bin", Mode::Octet, vec![])
            .await
            .expect("get"),
        image
    );
    let opts = vec![
        ("blksize".into(), "1468".into()),
        ("tsize".into(), "0".into()),
    ];
    assert_eq!(
        get(addr, "/images/ios.bin", Mode::Octet, opts)
            .await
            .expect("get"),
        image
    );
    // Exactly a multiple of the block size ends with an empty block.
    write(&h.root, "even.bin", &[7u8; 1024]);
    assert_eq!(
        get(addr, "even.bin", Mode::Octet, vec![])
            .await
            .expect("get")
            .len(),
        1024
    );
    settle().await;
    let events = h.events.lock().expect("lock").clone();
    let finished = events
        .iter()
        .filter(|e| matches!(e, ServerEvent::Finished { ok: true, .. }))
        .count();
    assert_eq!(finished, 3);
    assert!(events.iter().any(|e| matches!(
        e,
        ServerEvent::Started { file, size: Some(5000), .. } if file == "images/ios.bin"
    )));
    h.server.stop();
}

#[tokio::test]
async fn refuses_what_is_not_allowed() {
    let h = start(true, false, false).await;
    let addr = h.server.local_addr();
    write(&h.root, "a.cfg", b"x");
    let (code, _) = get(addr, "../secret", Mode::Octet, vec![])
        .await
        .expect_err("jail");
    assert_eq!(code, ErrorCode::AccessViolation);
    let (code, _) = get(addr, "missing.bin", Mode::Octet, vec![])
        .await
        .expect_err("missing");
    assert_eq!(code, ErrorCode::FileNotFound);
    let (code, msg) = put(addr, "new.cfg", b"hostname sw1\n", 512)
        .await
        .expect_err("read only");
    assert_eq!(code, ErrorCode::AccessViolation);
    assert!(msg.contains("Uploads are disabled"));
    settle().await;
    let refused = h
        .events
        .lock()
        .expect("lock")
        .iter()
        .filter(|e| matches!(e, ServerEvent::Refused { .. }))
        .count();
    assert_eq!(refused, 3);
    assert!(!h.root.join("new.cfg").exists());
}

#[tokio::test]
async fn receives_uploads_atomically_and_respects_overwrite() {
    let h = start(false, true, false).await;
    let addr = h.server.local_addr();
    let config = b"hostname sw1\n!\nend\n".repeat(100);
    put(addr, "sw1-confg", &config, 512).await.expect("put");
    settle().await;
    assert_eq!(
        std::fs::read(h.root.join("sw1-confg")).expect("read"),
        config
    );
    let (code, _) = put(addr, "sw1-confg", b"other", 512)
        .await
        .expect_err("exists");
    assert_eq!(code, ErrorCode::FileExists);
    let (code, _) = get(addr, "sw1-confg", Mode::Octet, vec![])
        .await
        .expect_err("write only");
    assert_eq!(code, ErrorCode::AccessViolation);
    // No temporary files are left behind.
    let names: Vec<_> = std::fs::read_dir(&h.root)
        .expect("ls")
        .map(|e| e.expect("entry").file_name())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}"); // images/ and sw1-confg

    let h2 = start(true, true, true).await;
    write(&h2.root, "x.cfg", b"old");
    put(h2.server.local_addr(), "x.cfg", b"new contents", 1024)
        .await
        .expect("overwrite");
    settle().await;
    assert_eq!(
        std::fs::read(h2.root.join("x.cfg")).expect("read"),
        b"new contents"
    );
}

#[tokio::test]
async fn netascii_converts_line_endings() {
    let h = start(true, false, false).await;
    write(&h.root, "a.txt", b"line1\nline2\n");
    let wire = get(h.server.local_addr(), "a.txt", Mode::NetAscii, vec![])
        .await
        .expect("get");
    assert_eq!(wire, b"line1\r\nline2\r\n");
}

#[tokio::test]
async fn block_numbers_roll_over() {
    let h = start(true, false, false).await;
    // 8-byte blocks: 70000 blocks wrap the 16-bit counter.
    let data: Vec<u8> = (0..70_000u32 * 8).map(|i| (i % 253) as u8).collect();
    write(&h.root, "big.bin", &data);
    let opts = vec![("blksize".into(), "8".into())];
    let got = get(h.server.local_addr(), "big.bin", Mode::Octet, opts)
        .await
        .expect("get");
    assert_eq!(got.len(), data.len());
    assert_eq!(got, data);
}

#[tokio::test]
async fn resends_when_an_ack_is_lost() {
    let h = start(true, false, false).await;
    write(&h.root, "r.bin", &[1u8; 600]);
    let sock = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
    let rrq = Packet::ReadRequest {
        filename: "r.bin".into(),
        mode: Mode::Octet,
        options: vec![("timeout".into(), "1".into())],
    };
    sock.send_to(&rrq.encode(), h.server.local_addr())
        .await
        .expect("send");
    let (oack, tid) = recv(&sock).await;
    assert!(matches!(oack, Packet::OptionAck { .. }));
    sock.send_to(&Packet::Ack { block: 0 }.encode(), tid)
        .await
        .expect("ack0");
    let (first, _) = recv(&sock).await;
    // Do not ack block 1: the server sends it again after the 1 s timeout.
    let (again, _) = recv(&sock).await;
    assert_eq!(first, again);
    h.server.stop();
}

#[tokio::test]
async fn bind_errors_are_explained() {
    let h = start(true, false, false).await;
    let taken = h.server.local_addr();
    let err = TftpServer::start(
        ServerConfig {
            root: h.root.clone(),
            bind: taken,
            allow_read: true,
            allow_write: false,
            overwrite: false,
        },
        Arc::new(|_| {}),
    )
    .await
    .expect_err("in use");
    assert!(matches!(err, cairn_tftp::TftpError::BindInUse { .. }));
    let err = TftpServer::start(
        ServerConfig {
            root: h.root.join("nope"),
            bind: "127.0.0.1:0".parse().expect("addr"),
            allow_read: true,
            allow_write: false,
            overwrite: false,
        },
        Arc::new(|_| {}),
    )
    .await
    .expect_err("root");
    assert!(matches!(err, cairn_tftp::TftpError::Root { .. }));
}
