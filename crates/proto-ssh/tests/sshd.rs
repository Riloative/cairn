//! Integration tests against real OpenSSH servers started by `scripts/test-sshd.sh`.
//! Skipped unless `CAIRN_SSH_TESTS=1` (CI sets it on Linux after starting the servers).

use cairn_core::terminal::{CloseReason, EventSink, TermEvent, TerminalSession};
use cairn_core::SecretString;
use cairn_proto_ssh::connect::{connect, AuthMethod, ConnectOptions, Hop};
use cairn_proto_ssh::{
    AlgorithmPolicy, HostKeyInfo, HostKeyVerdict, Interact, Progress, Prompt, SshError, SshSession,
};
use futures::future::BoxFuture;
use std::collections::VecDeque;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

fn enabled() -> bool {
    std::env::var("CAIRN_SSH_TESTS").as_deref() == Ok("1")
}

macro_rules! require_sshd {
    () => {
        if !enabled() {
            eprintln!("skipped: set CAIRN_SSH_TESTS=1 after scripts/test-sshd.sh");
            return;
        }
    };
}

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| panic!("{k} not set; source the test-sshd env file"))
}

fn port(k: &str) -> u16 {
    env(k).parse().expect("port")
}

#[derive(Default)]
struct TestInteract {
    reject_host_keys: bool,
    /// Simulates a user taking their time on the host key dialog.
    host_key_delay: Duration,
    answers: Mutex<VecDeque<Vec<String>>>,
    prompts: Mutex<Vec<Prompt>>,
    host_keys: Mutex<Vec<HostKeyInfo>>,
    connected: Mutex<bool>,
}

impl TestInteract {
    fn with_answers(answers: &[&[&str]]) -> Arc<Self> {
        Arc::new(Self {
            answers: Mutex::new(
                answers
                    .iter()
                    .map(|a| a.iter().map(|s| (*s).to_owned()).collect())
                    .collect(),
            ),
            ..Default::default()
        })
    }
}

impl Interact for TestInteract {
    fn host_key(&self, info: HostKeyInfo) -> BoxFuture<'static, HostKeyVerdict> {
        self.host_keys.lock().expect("lock").push(info);
        let v = if self.reject_host_keys {
            HostKeyVerdict::Reject
        } else {
            HostKeyVerdict::Accept
        };
        let delay = self.host_key_delay;
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            v
        })
    }
    fn prompt(&self, prompt: Prompt) -> BoxFuture<'static, Option<Vec<SecretString>>> {
        self.prompts.lock().expect("lock").push(prompt);
        let a = self
            .answers
            .lock()
            .expect("lock")
            .pop_front()
            .map(|v| v.into_iter().map(SecretString::from).collect());
        Box::pin(async move { a })
    }
    fn banner(&self, _: String) {}
    fn progress(&self, p: Progress) {
        if matches!(p, Progress::Connected { .. }) {
            *self.connected.lock().expect("lock") = true;
        }
    }
}

fn hop(port_var: &str, auth: Vec<AuthMethod>, legacy: bool) -> Hop {
    Hop {
        host: env("CAIRN_SSH_HOST"),
        port: port(port_var),
        username: env("CAIRN_SSH_USER"),
        auth,
        algorithms: if legacy {
            AlgorithmPolicy::all_legacy()
        } else {
            AlgorithmPolicy::default()
        },
    }
}

fn opts(hops: Vec<Hop>) -> ConnectOptions {
    ConnectOptions {
        hops,
        proxy: None,
        keepalive_secs: 10,
        keepalive_max: 3,
        connect_timeout_secs: 10,
        agent_forwarding: false,
    }
}

fn password() -> AuthMethod {
    AuthMethod::Password {
        password: Some(SecretString::from(env("CAIRN_SSH_PASSWORD"))),
    }
}

fn key(var: &str) -> AuthMethod {
    AuthMethod::KeyFile {
        path: env(var).into(),
        passphrase: None,
    }
}

/// Run `script` in a remote shell; return output and close reason.
async fn shell(
    o: ConnectOptions,
    interact: Arc<dyn Interact>,
    script: &str,
) -> (String, CloseReason) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let sink: EventSink = Arc::new(move |e| {
        let _ = tx.lock().expect("lock").send(e);
    });
    let s = SshSession::start(
        &tokio::runtime::Handle::current(),
        o,
        100,
        30,
        interact,
        sink,
    );
    s.write(format!("{script}\n").as_bytes()).expect("write");
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(30)) {
                Ok(TermEvent::Data(d)) => out.extend(d),
                Ok(TermEvent::Closed(r)) => {
                    drop(s);
                    return (String::from_utf8_lossy(&out).into_owned(), r);
                }
                Err(e) => panic!(
                    "timeout: {e}; output so far: {}",
                    String::from_utf8_lossy(&out)
                ),
            }
        }
    })
    .await
    .expect("join")
}

#[tokio::test]
async fn password_auth_runs_a_shell_and_reports_exit_code() {
    require_sshd!();
    let i = Arc::new(TestInteract::default());
    let (out, reason) = shell(
        opts(vec![hop("CAIRN_SSH_PORT", vec![password()], false)]),
        i.clone(),
        "echo cairn-$((40+2)); exit 7",
    )
    .await;
    assert!(out.contains("cairn-42"), "{out}");
    assert_eq!(reason, CloseReason::Exited { code: Some(7) });
    assert!(*i.connected.lock().expect("lock"));
    let keys = i.host_keys.lock().expect("lock");
    assert_eq!(keys.len(), 1);
    assert!(keys[0].fingerprint.starts_with("SHA256:"));
}

#[tokio::test]
async fn host_key_matches_the_server_key_file() {
    require_sshd!();
    let i = Arc::new(TestInteract::default());
    let conn = connect(
        &opts(vec![hop("CAIRN_SSH_PORT", vec![password()], false)]),
        i.clone(),
    )
    .await
    .expect("connect");
    let pubfile = std::fs::read_to_string(env("CAIRN_SSH_HOST_ED25519_PUB")).expect("pub");
    let expected: Vec<&str> = pubfile.split_whitespace().take(2).collect();
    let got = conn.host_key.expect("host key").public_key;
    assert_eq!(got, expected.join(" "));
}

#[tokio::test]
async fn ed25519_and_ecdsa_keys() {
    require_sshd!();
    for var in ["CAIRN_SSH_KEY_ED25519", "CAIRN_SSH_KEY_ECDSA"] {
        let (out, reason) = shell(
            opts(vec![hop("CAIRN_SSH_PORT", vec![key(var)], false)]),
            Arc::new(TestInteract::default()),
            "echo key-ok; exit 0",
        )
        .await;
        assert!(out.contains("key-ok"), "{var}: {out}");
        assert_eq!(reason, CloseReason::Exited { code: Some(0) });
    }
}

#[tokio::test]
async fn encrypted_rsa_key_asks_for_the_passphrase() {
    require_sshd!();
    let pass = env("CAIRN_SSH_KEY_PASSPHRASE");
    let i = TestInteract::with_answers(&[&[pass.as_str()]]);
    let (out, _) = shell(
        opts(vec![hop(
            "CAIRN_SSH_PORT",
            vec![key("CAIRN_SSH_KEY_RSA_ENC")],
            false,
        )]),
        i.clone(),
        "echo rsa-ok; exit",
    )
    .await;
    assert!(out.contains("rsa-ok"), "{out}");
    assert!(matches!(
        i.prompts.lock().expect("lock")[0],
        Prompt::Passphrase { .. }
    ));
}

#[tokio::test]
async fn keyboard_interactive_answers_server_prompts() {
    require_sshd!();
    let pw = env("CAIRN_SSH_PASSWORD");
    let i = TestInteract::with_answers(&[&[pw.as_str()]]);
    let (out, _) = shell(
        opts(vec![hop(
            "CAIRN_SSH_PORT",
            vec![AuthMethod::KeyboardInteractive],
            false,
        )]),
        i.clone(),
        "echo kbd-ok; exit",
    )
    .await;
    assert!(out.contains("kbd-ok"), "{out}");
    let first = i.prompts.lock().expect("lock")[0].clone();
    match first {
        Prompt::KeyboardInteractive { prompts, .. } => {
            assert!(prompts[0].text.to_lowercase().contains("password"));
            assert!(!prompts[0].echo);
        }
        other => panic!("unexpected prompt {other:?}"),
    }
}

#[tokio::test]
async fn password_prompt_when_not_stored() {
    require_sshd!();
    let pw = env("CAIRN_SSH_PASSWORD");
    let i = TestInteract::with_answers(&[&[pw.as_str()]]);
    let (out, _) = shell(
        opts(vec![hop(
            "CAIRN_SSH_PORT",
            vec![AuthMethod::Password { password: None }],
            false,
        )]),
        i.clone(),
        "echo prompted-ok; exit",
    )
    .await;
    assert!(out.contains("prompted-ok"), "{out}");
}

#[tokio::test]
async fn wrong_password_reports_remaining_methods() {
    require_sshd!();
    let err = connect(
        &opts(vec![hop(
            "CAIRN_SSH_PORT",
            vec![AuthMethod::Password {
                password: Some("nope".into()),
            }],
            false,
        )]),
        Arc::new(TestInteract::default()),
    )
    .await
    .expect_err("auth must fail");
    match err {
        SshError::AuthFailed { remaining, .. } => {
            assert!(remaining.iter().any(|m| m == "publickey"), "{remaining:?}")
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn cancelled_prompt_cancels_auth() {
    require_sshd!();
    let err = connect(
        &opts(vec![hop(
            "CAIRN_SSH_PORT",
            vec![AuthMethod::Password { password: None }],
            false,
        )]),
        Arc::new(TestInteract::default()),
    )
    .await
    .expect_err("cancelled");
    assert!(matches!(err, SshError::AuthCancelled));
}

#[tokio::test]
async fn slow_user_decisions_do_not_trip_the_connect_timeout() {
    require_sshd!();
    let i = Arc::new(TestInteract {
        host_key_delay: Duration::from_millis(2500),
        ..Default::default()
    });
    let mut o = opts(vec![hop("CAIRN_SSH_PORT", vec![password()], false)]);
    o.connect_timeout_secs = 1;
    connect(&o, i).await.expect("prompt time must not count");
}

#[tokio::test]
async fn rejected_host_key_aborts() {
    require_sshd!();
    let i = Arc::new(TestInteract {
        reject_host_keys: true,
        ..Default::default()
    });
    let err = connect(
        &opts(vec![hop("CAIRN_SSH_PORT", vec![password()], false)]),
        i,
    )
    .await
    .expect_err("rejected");
    assert!(matches!(err, SshError::HostKeyRejected { .. }), "{err:?}");
}

#[tokio::test]
async fn legacy_server_needs_legacy_algorithms() {
    require_sshd!();
    let err = connect(
        &opts(vec![hop("CAIRN_SSH_LEGACY_PORT", vec![password()], false)]),
        Arc::new(TestInteract::default()),
    )
    .await
    .expect_err("modern-only must fail");
    assert!(matches!(err, SshError::NoCommonAlgorithm { .. }), "{err:?}");

    let i = Arc::new(TestInteract::default());
    let (out, reason) = shell(
        opts(vec![hop("CAIRN_SSH_LEGACY_PORT", vec![password()], true)]),
        i.clone(),
        "echo legacy-ok; exit 0",
    )
    .await;
    assert!(out.contains("legacy-ok"), "{out}");
    assert_eq!(reason, CloseReason::Exited { code: Some(0) });
    assert_eq!(i.host_keys.lock().expect("lock")[0].key_type, "ssh-rsa");
}

#[tokio::test]
async fn legacy_server_accepts_rsa_key_with_sha1_signature() {
    require_sshd!();
    let pass = env("CAIRN_SSH_KEY_PASSPHRASE");
    let i = TestInteract::with_answers(&[&[pass.as_str()]]);
    let (out, _) = shell(
        opts(vec![hop(
            "CAIRN_SSH_LEGACY_PORT",
            vec![key("CAIRN_SSH_KEY_RSA_ENC")],
            true,
        )]),
        i,
        "echo legacy-rsa-ok; exit",
    )
    .await;
    assert!(out.contains("legacy-rsa-ok"), "{out}");
}

#[tokio::test]
async fn jump_host_chain() {
    require_sshd!();
    let i = Arc::new(TestInteract::default());
    let o = opts(vec![
        hop("CAIRN_SSH_PORT", vec![key("CAIRN_SSH_KEY_ED25519")], false),
        hop("CAIRN_SSH_LEGACY_PORT", vec![password()], true),
    ]);
    let (out, _) = shell(o, i.clone(), "echo via-jump-ok; exit").await;
    assert!(out.contains("via-jump-ok"), "{out}");
    let keys = i.host_keys.lock().expect("lock");
    assert_eq!(keys.len(), 2, "one host key check per hop");
    assert_eq!(keys[1].port, port("CAIRN_SSH_LEGACY_PORT"));
}

#[tokio::test]
async fn resize_reaches_the_remote_pty() {
    require_sshd!();
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let sink: EventSink = Arc::new(move |e| {
        let _ = tx.lock().expect("lock").send(e);
    });
    let s = SshSession::start(
        &tokio::runtime::Handle::current(),
        opts(vec![hop("CAIRN_SSH_PORT", vec![password()], false)]),
        80,
        24,
        Arc::new(TestInteract::default()),
        sink,
    );
    s.resize(132, 43).expect("resize");
    s.write(b"sleep 0.3; stty size; exit\n").expect("write");
    let out = tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        while let Ok(e) = rx.recv_timeout(Duration::from_secs(30)) {
            match e {
                TermEvent::Data(d) => out.extend(d),
                TermEvent::Closed(_) => break,
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    })
    .await
    .expect("join");
    assert!(out.contains("43 132"), "{out}");
}

#[tokio::test]
async fn close_while_connecting_reports_closed() {
    require_sshd!();
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let sink: EventSink = Arc::new(move |e| {
        let _ = tx.lock().expect("lock").send(e);
    });
    // Unanswered password prompt keeps the session in "connecting".
    struct Hang;
    impl Interact for Hang {
        fn host_key(&self, _: HostKeyInfo) -> BoxFuture<'static, HostKeyVerdict> {
            Box::pin(async { HostKeyVerdict::Accept })
        }
        fn prompt(&self, _: Prompt) -> BoxFuture<'static, Option<Vec<SecretString>>> {
            Box::pin(futures::future::pending())
        }
        fn banner(&self, _: String) {}
        fn progress(&self, _: Progress) {}
    }
    let s = SshSession::start(
        &tokio::runtime::Handle::current(),
        opts(vec![hop(
            "CAIRN_SSH_PORT",
            vec![AuthMethod::Password { password: None }],
            false,
        )]),
        80,
        24,
        Arc::new(Hang),
        sink,
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    s.close();
    let reason =
        tokio::task::spawn_blocking(move || match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(TermEvent::Closed(r)) => r,
            other => panic!("unexpected {other:?}"),
        })
        .await
        .expect("join");
    assert_eq!(reason, CloseReason::Closed);
}

/// Start a private ssh-agent with the ed25519 key loaded; returns (socket, pid).
fn start_agent() -> (String, String) {
    let out = std::process::Command::new("ssh-agent")
        .arg("-s")
        .output()
        .expect("ssh-agent");
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let grab = |k: &str| {
        text.split(';')
            .find_map(|p| p.trim().strip_prefix(&format!("{k}=")).map(str::to_owned))
            .expect("agent var")
    };
    let (sock, pid) = (grab("SSH_AUTH_SOCK"), grab("SSH_AGENT_PID"));
    // ssh-add refuses group/world-readable keys; the fixture keys are 0644 so the test
    // user can read them, so add a private 0600 copy.
    let dir = tempfile::tempdir().expect("tempdir");
    let private = dir.path().join("id");
    std::fs::copy(env("CAIRN_SSH_KEY_ED25519"), &private).expect("copy key");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o600)).expect("chmod");
    }
    let status = std::process::Command::new("ssh-add")
        .arg(&private)
        .env("SSH_AUTH_SOCK", &sock)
        .output()
        .expect("ssh-add");
    assert!(
        status.status.success(),
        "ssh-add failed: {}",
        String::from_utf8_lossy(&status.stderr)
    );
    (sock, pid)
}

/// Agent auth and agent forwarding share one test: both need SSH_AUTH_SOCK, which is
/// process-global.
#[tokio::test]
async fn agent_auth_and_forwarding() {
    require_sshd!();
    let (sock, pid) = start_agent();
    std::env::set_var("SSH_AUTH_SOCK", &sock);

    let (out, _) = shell(
        opts(vec![hop("CAIRN_SSH_PORT", vec![AuthMethod::Agent], false)]),
        Arc::new(TestInteract::default()),
        "echo agent-ok; exit",
    )
    .await;
    assert!(out.contains("agent-ok"), "{out}");

    // Forwarding off (default): the remote side sees no agent.
    let (out, _) = shell(
        opts(vec![hop("CAIRN_SSH_PORT", vec![AuthMethod::Agent], false)]),
        Arc::new(TestInteract::default()),
        "ssh-add -l; exit",
    )
    .await;
    assert!(!out.contains("cairn-ed25519"), "{out}");

    // Forwarding on: the remote `ssh-add -l` lists our key.
    let mut o = opts(vec![hop("CAIRN_SSH_PORT", vec![AuthMethod::Agent], false)]);
    o.agent_forwarding = true;
    let (out, _) = shell(o, Arc::new(TestInteract::default()), "ssh-add -l; exit").await;
    assert!(out.contains("cairn-ed25519"), "{out}");

    let _ = std::process::Command::new("kill").arg(pid).status();
}
