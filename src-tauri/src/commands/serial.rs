//! Serial console commands: port discovery with hotplug, sessions, line controls and
//! X/Ymodem transfers.

use super::session::{audited_output, require_unlocked};
use crate::error::{CommandError, CommandResult};
use crate::sessions::{
    autologin, Extra, SerialControl, SessionId, SessionManager, SessionMessage, TransferStatus,
};
use crate::state::AppState;
use cairn_core::audit::AuditEvent;
use cairn_core::login::LoginPlan;
use cairn_core::terminal::TerminalSession;
use cairn_proto_serial::ports::{self, PortInfo};
use cairn_proto_serial::xmodem::{OutgoingFile, Progress, Variant};
use cairn_proto_serial::{SerialError, SerialOptions, SerialSession};
use parking_lot::Mutex;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

/// Largest file accepted for sending (console uploads are configs and small images).
const MAX_SEND_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SEND_FILES: usize = 32;
const HOTPLUG_POLL: Duration = Duration::from_secs(1);

/// Hotplug update: the full list plus what changed since the previous one.
#[derive(Debug, Clone, Serialize)]
pub struct PortsChanged {
    pub ports: Vec<PortInfo>,
    pub added: Vec<PortInfo>,
    pub removed: Vec<PortInfo>,
}

#[derive(Default)]
struct WatchState {
    channel: Option<Channel<PortsChanged>>,
    last: Vec<PortInfo>,
    running: bool,
}

/// Polls the port list while a connect dialog is watching it.
#[derive(Default)]
pub struct PortWatcher {
    state: Arc<Mutex<WatchState>>,
}

impl std::fmt::Debug for PortWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PortWatcher")
            .field("watching", &self.state.lock().channel.is_some())
            .finish()
    }
}

impl PortWatcher {
    fn watch(&self, channel: Channel<PortsChanged>, current: Vec<PortInfo>) {
        let mut st = self.state.lock();
        st.channel = Some(channel);
        st.last = current;
        if st.running {
            return;
        }
        st.running = true;
        let state = self.state.clone();
        let spawned = std::thread::Builder::new()
            .name("cairn-serial-hotplug".into())
            .spawn(move || poll(&state));
        if spawned.is_err() {
            // No hotplug updates; the list still refreshes when the dialog reopens.
            st.running = false;
        }
    }

    fn unwatch(&self) {
        self.state.lock().channel = None;
    }
}

fn poll(state: &Mutex<WatchState>) {
    loop {
        std::thread::sleep(HOTPLUG_POLL);
        if state.lock().channel.is_none() {
            break;
        }
        let now = ports::list();
        let mut st = state.lock();
        let Some(channel) = st.channel.clone() else {
            break;
        };
        if now == st.last {
            continue;
        }
        let (added, removed) = ports::diff(&st.last, &now);
        st.last = now.clone();
        if channel
            .send(PortsChanged {
                ports: now,
                added,
                removed,
            })
            .is_err()
        {
            st.channel = None;
            break;
        }
    }
    state.lock().running = false;
}

async fn list_ports() -> CommandResult<Vec<PortInfo>> {
    tauri::async_runtime::spawn_blocking(ports::list)
        .await
        .map_err(|e| CommandError::internal(format!("listing serial ports failed: {e}")))
}

/// Serial ports on this machine, USB adapters first.
#[tauri::command]
pub async fn serial_ports() -> CommandResult<Vec<PortInfo>> {
    list_ports().await
}

/// Current ports; changes follow on `on_change` until `serial_ports_unwatch`.
#[tauri::command]
pub async fn serial_ports_watch(
    watcher: State<'_, PortWatcher>,
    on_change: Channel<PortsChanged>,
) -> CommandResult<Vec<PortInfo>> {
    let current = list_ports().await?;
    watcher.watch(on_change, current.clone());
    Ok(current)
}

#[tauri::command]
pub fn serial_ports_unwatch(watcher: State<'_, PortWatcher>) {
    watcher.unwatch();
}

fn validate(opts: &SerialOptions) -> CommandResult<()> {
    if opts.path.trim().is_empty() || opts.path.len() > 512 {
        return Err(cairn_core::CoreError::Validation("Choose a serial port.".into()).into());
    }
    opts.settings
        .validate()
        .map_err(|e| CommandError::from(SerialError::from(e)))
}

/// Open a serial console.
#[tauri::command]
pub async fn serial_open(
    state: State<'_, AppState>,
    sessions: State<'_, Arc<SessionManager>>,
    options: SerialOptions,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionMessage>,
) -> CommandResult<SessionId> {
    require_unlocked(&state)?;
    start(
        &state,
        &sessions,
        options,
        None,
        LoginPlan::default(),
        on_data,
        on_event,
    )
}

/// Open a serial session (also used for inventory devices).
pub(crate) fn start(
    state: &AppState,
    sessions: &Arc<SessionManager>,
    options: SerialOptions,
    device: Option<String>,
    login: LoginPlan,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionMessage>,
) -> CommandResult<SessionId> {
    validate(&options)?;
    let target = format!("{} {}", options.path, options.settings.summary());
    let id = sessions.allocate_id();
    let output = audited_output(state, &id, "serial", &target, on_data, on_event);
    let output = autologin::wrap(output, login, sessions, &id);
    let mut control = None;
    let id = sessions.open_with_id::<CommandError>(id, output, |sink| {
        let s = SerialSession::open(&options, sink)?;
        control = Some(s.clone());
        Ok(s as Arc<dyn TerminalSession>)
    })?;
    if let Some(session) = control {
        sessions.set_extra(
            &id,
            Extra::Serial(Arc::new(SerialControl {
                session,
                cancel: Default::default(),
            })),
        );
    }
    state.audit.record(
        &state.vault,
        AuditEvent::SessionStarted {
            session_id: id.clone(),
            protocol: "serial".into(),
            target,
            username: None,
            device,
            host_key_fingerprint: None,
        },
    );
    Ok(id)
}

fn serial(sessions: &SessionManager, id: &str) -> CommandResult<Arc<SerialControl>> {
    match sessions.extra(id) {
        Some(Extra::Serial(c)) => Ok(c),
        _ => Err(cairn_core::terminal::TerminalError::Closed.into()),
    }
}

/// Set the DTR and/or RTS modem lines.
#[tauri::command]
pub fn serial_set_lines(
    sessions: State<'_, Arc<SessionManager>>,
    id: SessionId,
    dtr: Option<bool>,
    rts: Option<bool>,
) -> CommandResult<()> {
    let c = serial(&sessions, &id)?;
    if let Some(on) = dtr {
        c.session.set_dtr(on)?;
    }
    if let Some(on) = rts {
        c.session.set_rts(on)?;
    }
    Ok(())
}

fn record_transfer(
    state: &AppState,
    id: &str,
    direction: &str,
    file: String,
    bytes: u64,
    error: Option<String>,
) {
    state.audit.record(
        &state.vault,
        AuditEvent::FileTransferred {
            session_id: id.to_owned(),
            protocol: "serial".into(),
            direction: direction.into(),
            file,
            bytes,
            ok: error.is_none(),
            error,
        },
    );
}

fn progress_reporter(channel: Channel<TransferStatus>) -> impl FnMut(Progress) {
    let mut last = std::time::Instant::now() - Duration::from_secs(1);
    move |p| {
        // Throttle: the UI needs ~10 updates a second, not one per block.
        let done = p.total.is_some_and(|t| p.bytes >= t);
        if done || last.elapsed() >= Duration::from_millis(100) {
            last = std::time::Instant::now();
            let _ = channel.send(TransferStatus::Running {
                bytes: p.bytes,
                total: p.total,
            });
        }
    }
}

fn read_outgoing(paths: &[String]) -> CommandResult<Vec<OutgoingFile>> {
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        let p = Path::new(path);
        let meta = std::fs::metadata(p).map_err(|e| {
            CommandError::from(SerialError::Transfer(format!("cannot read {path}: {e}")))
        })?;
        if !meta.is_file() {
            return Err(SerialError::Transfer(format!("{path} is not a file")).into());
        }
        if meta.len() > MAX_SEND_BYTES {
            return Err(SerialError::Transfer(format!(
                "{path} is larger than {} MiB",
                MAX_SEND_BYTES / 1024 / 1024
            ))
            .into());
        }
        let data = std::fs::read(p).map_err(|e| {
            CommandError::from(SerialError::Transfer(format!("cannot read {path}: {e}")))
        })?;
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file.bin".into());
        files.push(OutgoingFile { name, data });
    }
    Ok(files)
}

/// Send files with X/Ymodem. Progress goes to `on_progress`; returns when done.
#[tauri::command]
pub async fn serial_send_files(
    state: State<'_, AppState>,
    sessions: State<'_, Arc<SessionManager>>,
    id: SessionId,
    variant: Variant,
    paths: Vec<String>,
    on_progress: Channel<TransferStatus>,
) -> CommandResult<TransferStatus> {
    require_unlocked(&state)?;
    if paths.is_empty() || paths.len() > MAX_SEND_FILES {
        return Err(cairn_core::CoreError::Validation("Choose files to send.".into()).into());
    }
    if variant != Variant::Ymodem && paths.len() > 1 {
        return Err(cairn_core::CoreError::Validation(
            "Xmodem sends one file at a time; use Ymodem for several.".into(),
        )
        .into());
    }
    let control = serial(&sessions, &id)?;
    let files = read_outgoing(&paths)?;
    let names: Vec<String> = files.iter().map(|f| f.name.clone()).collect();
    let total: u64 = files.iter().map(|f| f.data.len() as u64).sum();
    control.cancel.store(false, Ordering::SeqCst);
    let c = control.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut report = progress_reporter(on_progress);
        c.session
            .send_files(variant, &files, &mut report, &c.cancel)
    })
    .await
    .map_err(|e| CommandError::internal(format!("transfer thread failed: {e}")))?;
    let joined = names.join(", ");
    match result {
        Ok(()) => {
            record_transfer(&state, &id, "upload", joined, total, None);
            Ok(TransferStatus::Done {
                files: names,
                bytes: total,
            })
        }
        Err(e) => {
            record_transfer(&state, &id, "upload", joined, 0, Some(e.to_string()));
            Err(e.into())
        }
    }
}

/// A path in `dir` for `name` that does not exist yet ("name (2).ext", …).
fn create_unique(dir: &Path, name: &str) -> std::io::Result<(PathBuf, std::fs::File)> {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_owned(), format!(".{e}")),
        _ => (name.to_owned(), String::new()),
    };
    for n in 1..1000 {
        let candidate = if n == 1 {
            dir.join(name)
        } else {
            dir.join(format!("{stem} ({n}){ext}"))
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(f) => return Ok((candidate, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "too many files with this name",
    ))
}

/// Receive files with X/Ymodem into `dir`. Returns the saved paths.
#[tauri::command]
pub async fn serial_receive_files(
    state: State<'_, AppState>,
    sessions: State<'_, Arc<SessionManager>>,
    id: SessionId,
    variant: Variant,
    dir: String,
    on_progress: Channel<TransferStatus>,
) -> CommandResult<Vec<String>> {
    require_unlocked(&state)?;
    let dir = PathBuf::from(dir);
    if !dir.is_dir() {
        return Err(
            cairn_core::CoreError::Validation("Choose a folder to save into.".into()).into(),
        );
    }
    let control = serial(&sessions, &id)?;
    control.cancel.store(false, Ordering::SeqCst);
    let c = control.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut report = progress_reporter(on_progress);
        c.session.receive_files(variant, &mut report, &c.cancel)
    })
    .await
    .map_err(|e| CommandError::internal(format!("transfer thread failed: {e}")))?;
    let received = match result {
        Ok(r) => r,
        Err(e) => {
            record_transfer(
                &state,
                &id,
                "download",
                String::new(),
                0,
                Some(e.to_string()),
            );
            return Err(e.into());
        }
    };
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut saved = Vec::with_capacity(received.len());
    for file in received {
        // Names from the remote side are already reduced to a bare file name.
        let name = file
            .name
            .clone()
            .unwrap_or_else(|| format!("xmodem-{stamp}.bin"));
        let written = create_unique(&dir, &name).and_then(|(path, mut f)| {
            f.write_all(&file.data)?;
            f.sync_all()?;
            Ok(path)
        });
        match written {
            Ok(path) => {
                let shown = path.to_string_lossy().into_owned();
                record_transfer(
                    &state,
                    &id,
                    "download",
                    shown.clone(),
                    file.data.len() as u64,
                    None,
                );
                saved.push(shown);
            }
            Err(e) => {
                let msg = format!("could not save {name}: {e}");
                record_transfer(&state, &id, "download", name, 0, Some(msg.clone()));
                return Err(SerialError::Transfer(msg).into());
            }
        }
    }
    Ok(saved)
}

/// Cancel the running transfer on a serial session (no-op if none is running).
#[tauri::command]
pub fn serial_transfer_cancel(sessions: State<'_, Arc<SessionManager>>, id: SessionId) {
    if let Ok(c) = serial(&sessions, &id) {
        c.cancel.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_names_never_overwrite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (a, _) = create_unique(dir.path(), "cfg.txt").expect("a");
        let (b, _) = create_unique(dir.path(), "cfg.txt").expect("b");
        let (c, _) = create_unique(dir.path(), "noext").expect("c");
        let (d, _) = create_unique(dir.path(), "noext").expect("d");
        assert_eq!(a.file_name().expect("name"), "cfg.txt");
        assert_eq!(b.file_name().expect("name"), "cfg (2).txt");
        assert_eq!(c.file_name().expect("name"), "noext");
        assert_eq!(d.file_name().expect("name"), "noext (2)");
    }

    #[test]
    fn outgoing_files_are_checked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let f = dir.path().join("a.bin");
        std::fs::write(&f, b"hello").expect("write");
        let got = read_outgoing(&[f.to_string_lossy().into_owned()]).expect("read");
        assert_eq!(got[0].name, "a.bin");
        assert_eq!(got[0].data, b"hello");
        assert!(read_outgoing(&[dir.path().to_string_lossy().into_owned()]).is_err());
        assert!(read_outgoing(&["/nonexistent/x".into()]).is_err());
    }
}
