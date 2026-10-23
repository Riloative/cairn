//! A live RDP session: connect, trust the certificate, authenticate, then pump frames,
//! input, resizes and clipboard until either side ends it.

use crate::cert::CertInfo;
use crate::clipboard::{ClipboardEvent, TextClipboard};
use crate::error::RdpError;
use crate::frame::{self, DirtyRegion, Rect};
use crate::input::{self, RdpInput};
use crate::profile::{self, ColorDepth, Security};
use cairn_core::SecretString;
use futures::future::BoxFuture;
use ironrdp::cliprdr::backend::ClipboardMessage;
use ironrdp::cliprdr::pdu::{ClipboardFormat, ClipboardFormatId};
use ironrdp::cliprdr::CliprdrClient;
use ironrdp::connector::connection_activation::ConnectionActivationState;
use ironrdp::connector::sspi::generator::NetworkRequest;
use ironrdp::connector::{
    self, ClientConnector, ConnectionResult, ConnectorResult, Credentials, DesktopSize, ServerName,
};
use ironrdp::core::WriteBuf;
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::graphics::pointer::DecodedPointer;
use ironrdp::input::Database;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::rdp::capability_sets::{client_codecs_capabilities, MajorPlatformType};
use ironrdp::pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{fast_path, ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp_tokio::{split_tokio_framed, FramedWrite, NetworkClient, TokioFramed};
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio::time::Instant;

/// A byte stream to the server: TCP, or a channel through an SSH tunnel.
pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send + Sync + 'static {}
impl<T> Stream for T where T: AsyncRead + AsyncWrite + Unpin + Send + Sync + 'static {}

pub type Transport = Box<dyn Stream>;

/// Opens the transport; resolves to the stream and this side's address.
pub type Dialer = BoxFuture<'static, Result<(Transport, SocketAddr), RdpError>>;

/// Everything needed to connect. Credentials stay in Rust.
#[derive(Debug, Clone)]
pub struct RdpConfig {
    /// Server name for TLS and CredSSP, and for the certificate pin.
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: SecretString,
    pub domain: Option<String>,
    pub security: Security,
    pub color_depth: ColorDepth,
    pub width: u16,
    pub height: u16,
    /// Desktop scale in percent (100–500); 0 leaves it to the server.
    pub scale_factor: u32,
    pub clipboard: bool,
}

/// Connection phases shown while the session starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Connecting,
    Securing,
    Authenticating,
}

/// Lifecycle and side-channel events for the view (frames go through [`RdpInteract::frame`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RdpEvent {
    Progress {
        phase: Phase,
    },
    Connected {
        width: u16,
        height: u16,
    },
    /// The server changed the desktop size (after a resize request or on its own).
    Resized {
        width: u16,
        height: u16,
    },
    /// Show the default arrow / hide the cursor (bitmaps arrive as binary messages).
    PointerDefault,
    PointerHidden,
    /// The server's clipboard changed to this text.
    Clipboard {
        text: String,
    },
    Closed {
        /// True when the server or the user ended the session normally.
        graceful: bool,
        message: String,
    },
}

/// The session's link to the UI.
pub trait RdpInteract: Send + Sync + 'static {
    /// Decide whether to trust the server certificate. Called before any credentials are
    /// sent.
    fn certificate(&self, cert: CertInfo) -> BoxFuture<'static, bool>;
    fn event(&self, event: RdpEvent);
    /// A binary frame or pointer message (see [`crate::frame`]).
    fn frame(&self, message: Vec<u8>);
}

#[derive(Debug)]
enum Command {
    Input(Vec<RdpInput>),
    Resize { width: u32, height: u32, scale: u32 },
    Clipboard(String),
    CtrlAltDel,
    Close,
}

/// Handle to a running session. Dropping it closes the session.
#[derive(Debug)]
pub struct RdpSession {
    tx: mpsc::UnboundedSender<Command>,
}

impl RdpSession {
    /// Start the session on its own thread. IronRDP's connection future is not `Send`
    /// (its network-client trait returns an unbounded `impl Future`), so each session
    /// gets a single-threaded runtime instead of a task on the shared one.
    pub fn start(config: RdpConfig, dialer: Dialer, interact: Arc<dyn RdpInteract>) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let spawned = std::thread::Builder::new()
            .name(format!("rdp {}", config.host))
            .spawn({
                let interact = interact.clone();
                move || {
                    let outcome = match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(rt) => rt.block_on(run(config, dialer, interact.clone(), rx)),
                        Err(e) => Err(RdpError::Protocol(format!("could not start: {e}"))),
                    };
                    let (graceful, message) = match outcome {
                        Ok(reason) => (true, reason),
                        Err(e) => (false, e.to_string()),
                    };
                    interact.event(RdpEvent::Closed { graceful, message });
                }
            });
        if let Err(e) = spawned {
            interact.event(RdpEvent::Closed {
                graceful: false,
                message: format!("Could not start the RDP session: {e}"),
            });
        }
        Self { tx }
    }

    pub fn input(&self, events: Vec<RdpInput>) {
        let _ = self.tx.send(Command::Input(events));
    }

    /// Ask the server to change the desktop size (Display Control). Ignored by servers
    /// without dynamic resize; the view scales instead.
    pub fn resize(&self, width: u32, height: u32, scale: u32) {
        let _ = self.tx.send(Command::Resize {
            width,
            height,
            scale,
        });
    }

    /// Offer this text as the clipboard to the server.
    pub fn clipboard(&self, text: String) {
        let _ = self.tx.send(Command::Clipboard(text));
    }

    pub fn ctrl_alt_del(&self) {
        let _ = self.tx.send(Command::CtrlAltDel);
    }

    pub fn close(&self) {
        let _ = self.tx.send(Command::Close);
    }
}

impl Drop for RdpSession {
    fn drop(&mut self) {
        self.close();
    }
}

/// Kerberos would need this client to reach a KDC; Cairn authenticates with NTLM and
/// makes no network calls of its own.
struct NoNetwork;

impl NetworkClient for NoNetwork {
    async fn send(&mut self, _: &NetworkRequest) -> ConnectorResult<Vec<u8>> {
        Err(connector::general_err!(
            "Kerberos is not supported; sign in with a local or domain account password (NTLM)"
        ))
    }
}

/// How long to wait for the TCP connection and for each server reply while connecting.
const STEP_TIMEOUT: Duration = Duration::from_secs(20);
/// At most one frame flush per this interval (~60 fps).
const FRAME_INTERVAL: Duration = Duration::from_millis(16);
/// A Deactivation-Reactivation (desktop resize) must finish within this, or the session
/// ends rather than looping forever on a server that never reaches Finalized.
const REACTIVATION_TIMEOUT: Duration = Duration::from_secs(30);

fn connector_config(config: &RdpConfig) -> connector::Config {
    let codecs = client_codecs_capabilities(&[]).unwrap_or_default();
    let tls_only = config.security == Security::Tls;
    connector::Config {
        credentials: Credentials::UsernamePassword {
            username: config.username.clone(),
            password: config.password.expose().to_owned(),
        },
        domain: config.domain.clone().filter(|d| !d.is_empty()),
        enable_tls: true,
        enable_credssp: !tls_only,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: DesktopSize {
            width: config.width,
            height: config.height,
        },
        desktop_scale_factor: config.scale_factor,
        bitmap: Some(connector::BitmapConfig {
            lossy_compression: true,
            color_depth: config.color_depth.bits(),
            codecs,
        }),
        client_build: 0,
        client_name: "Cairn".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        platform: if cfg!(target_os = "macos") {
            MajorPlatformType::MACINTOSH
        } else {
            MajorPlatformType::UNIX
        },
        hardware_id: None,
        request_data: None,
        // When TLS is negotiated instead of NLA (requested, or a server without CredSSP
        // such as xrdp), the server shows its own logon screen unless asked to use our
        // credentials.
        autologon: !config.password.is_empty(),
        enable_audio_playback: false,
        performance_flags: PerformanceFlags::default(),
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        compression_type: None,
        enable_server_pointer: true,
        pointer_software_rendering: false,
        multitransport_flags: None,
        alternate_shell: String::new(),
        work_dir: String::new(),
    }
}

async fn step<T>(
    what: &str,
    target: &str,
    fut: impl std::future::Future<Output = Result<T, RdpError>>,
) -> Result<T, RdpError> {
    match tokio::time::timeout(STEP_TIMEOUT, fut).await {
        Ok(result) => result,
        Err(_) => Err(if what == "connect" {
            RdpError::Timeout(target.to_owned())
        } else {
            RdpError::Protocol(format!("the server stopped responding during {what}"))
        }),
    }
}

type Framed = TokioFramed<Transport>;

async fn connect(
    config: &RdpConfig,
    dialer: Dialer,
    interact: &Arc<dyn RdpInteract>,
    clipboard: Option<TextClipboard>,
) -> Result<(ConnectionResult, Framed), RdpError> {
    let target = format!("{}:{}", config.host, config.port);
    interact.event(RdpEvent::Progress {
        phase: Phase::Connecting,
    });
    let (stream, client_addr) = step("connect", &target, dialer).await?;

    let drdynvc =
        DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new())));
    let mut connector =
        ClientConnector::new(connector_config(config), client_addr).with_static_channel(drdynvc);
    if let Some(backend) = clipboard {
        connector.attach_static_channel(CliprdrClient::new(Box::new(backend)));
    }

    let mut framed = TokioFramed::new(stream);
    interact.event(RdpEvent::Progress {
        phase: Phase::Securing,
    });
    let should_upgrade = step("negotiation", &target, async {
        Ok(ironrdp_tokio::connect_begin(&mut framed, &mut connector).await?)
    })
    .await?;
    let (stream, leftover) = framed.into_inner();
    let (tls, cert) = step("the TLS handshake", &target, async {
        ironrdp_tls::upgrade(stream, &config.host)
            .await
            .map_err(|e| RdpError::Tls(e.to_string()))
    })
    .await?;

    // Pin check before any credential leaves this computer.
    let info = CertInfo::from_certificate(&config.host, config.port, &cert)
        .ok_or_else(|| RdpError::Tls("the server certificate could not be read".into()))?;
    if !interact.certificate(info).await {
        return Err(RdpError::CertificateRejected);
    }
    let server_public_key = ironrdp_tls::extract_tls_server_public_key(&cert)
        .ok_or_else(|| RdpError::Tls("the certificate has no usable public key".into()))?
        .to_owned();

    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
    let tls: Transport = Box::new(tls);
    let mut framed = TokioFramed::new_with_leftover(tls, leftover);
    interact.event(RdpEvent::Progress {
        phase: Phase::Authenticating,
    });
    let result = step("sign-in", &target, async {
        Ok(ironrdp_tokio::connect_finalize(
            upgraded,
            connector,
            &mut framed,
            &mut NoNetwork,
            ServerName::new(config.host.clone()),
            server_public_key,
            None,
        )
        .await?)
    })
    .await?;
    Ok((result, framed))
}

/// Session state for the active stage.
struct Active {
    stage: ActiveStage,
    image: DecodedImage,
    input: Database,
    region: DirtyRegion,
    last_flush: Instant,
    /// A resize requested before Display Control was ready.
    pending_resize: Option<(u32, u32, u32)>,
    interact: Arc<dyn RdpInteract>,
}

impl Active {
    fn size(&self) -> (u16, u16) {
        (self.image.width(), self.image.height())
    }

    fn flush(&mut self) {
        if self.region.is_empty() {
            return;
        }
        let (w, h) = self.size();
        let message = frame::encode(&self.region, self.image.data(), self.image.stride(), w, h);
        self.region.clear();
        self.last_flush = Instant::now();
        self.interact.frame(message);
    }

    fn pointer(&self, p: &DecodedPointer) {
        self.interact.frame(frame::encode_pointer(
            p.width,
            p.height,
            p.hotspot_x,
            p.hotspot_y,
            &p.bitmap_data,
        ));
    }

    /// Try to send a pending resize; `None` while Display Control is not connected.
    fn encode_pending_resize(&mut self) -> Result<Option<Vec<u8>>, RdpError> {
        let Some((w, h, scale)) = self.pending_resize else {
            return Ok(None);
        };
        let (w, h) = profile::clamp_size(w, h);
        if (w, h) == self.size() {
            self.pending_resize = None;
            return Ok(None);
        }
        let scale = (100..=500).contains(&scale).then_some(scale);
        match self
            .stage
            .encode_resize(u32::from(w), u32::from(h), scale, None)
        {
            Some(frame) => {
                self.pending_resize = None;
                Ok(Some(frame?))
            }
            None => Ok(None),
        }
    }
}

async fn run(
    config: RdpConfig,
    dialer: Dialer,
    interact: Arc<dyn RdpInteract>,
    mut commands: mpsc::UnboundedReceiver<Command>,
) -> Result<String, RdpError> {
    let (clip_tx, mut clip_rx) = mpsc::unbounded_channel::<ClipboardEvent>();
    let local_clip = Arc::new(Mutex::new(None::<String>));
    let backend = config
        .clipboard
        .then(|| TextClipboard::new(clip_tx.clone(), local_clip.clone()));
    // Keep a sender alive so the receiver never reports closed when clipboard is off.
    let _clip_tx = clip_tx;

    let (result, framed) = connect(&config, dialer, &interact, backend).await?;
    let (mut reader, mut writer) = split_tokio_framed(framed);
    let size = result.desktop_size;
    let activation = result.activation_factory;
    let stage = ActiveStageBuilder {
        static_channels: result.static_channels,
        user_channel_id: result.user_channel_id,
        io_channel_id: result.io_channel_id,
        message_channel_id: result.message_channel_id,
        share_id: result.share_id,
        compression_type: result.compression_type,
        enable_server_pointer: result.enable_server_pointer,
        pointer_software_rendering: result.pointer_software_rendering,
    }
    .build();
    let mut s = Active {
        stage,
        image: DecodedImage::new(PixelFormat::RgbA32, size.width, size.height),
        input: Database::new(),
        region: DirtyRegion::default(),
        last_flush: Instant::now(),
        pending_resize: None,
        interact: interact.clone(),
    };
    interact.event(RdpEvent::Connected {
        width: size.width,
        height: size.height,
    });

    let mut clipboard_timer = tokio::time::interval(Duration::from_secs(5));
    let reason = 'session: loop {
        let flush_at = s.last_flush + FRAME_INTERVAL;
        let outputs: Vec<ActiveStageOutput> = tokio::select! {
            pdu = reader.read_pdu() => {
                let (action, payload) = pdu.map_err(|e| {
                    RdpError::Protocol(format!("the connection was lost ({e})"))
                })?;
                s.stage.process(&mut s.image, action, &payload)?
            }
            command = commands.recv() => match command {
                None | Some(Command::Close) => {
                    let frames = s.stage.graceful_shutdown()?;
                    for f in frames {
                        if let ActiveStageOutput::ResponseFrame(bytes) = f {
                            let _ = writer.write_all(&bytes).await;
                        }
                    }
                    break 'session "The session was closed.".to_owned();
                }
                Some(Command::Input(events)) => {
                    let mut ops = Vec::with_capacity(events.len());
                    let mut fastpath = Vec::new();
                    for e in &events {
                        if *e == RdpInput::ReleaseAll {
                            fastpath.extend(s.input.apply(std::mem::take(&mut ops)));
                            fastpath.extend(s.input.release_all());
                        } else if let Some(op) = e.operation() {
                            ops.push(op);
                        }
                    }
                    fastpath.extend(s.input.apply(ops));
                    if fastpath.is_empty() {
                        Vec::new()
                    } else {
                        s.stage.process_fastpath_input(&mut s.image, &fastpath)?
                    }
                }
                Some(Command::CtrlAltDel) => {
                    let events = s.input.apply(input::ctrl_alt_del());
                    s.stage.process_fastpath_input(&mut s.image, &events)?
                }
                Some(Command::Resize { width, height, scale }) => {
                    s.pending_resize = Some((width, height, scale));
                    match s.encode_pending_resize()? {
                        Some(frame) => vec![ActiveStageOutput::ResponseFrame(frame)],
                        None => Vec::new(),
                    }
                }
                Some(Command::Clipboard(text)) => {
                    if !config.clipboard {
                        Vec::new()
                    } else {
                        if let Ok(mut local) = local_clip.lock() {
                            *local = Some(text);
                        }
                        let formats = [ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)];
                        match s.stage.get_svc_processor_mut::<CliprdrClient>() {
                            Some(cliprdr) => {
                                let messages = cliprdr
                                    .initiate_copy(&formats)
                                    .map_err(|e| RdpError::Protocol(format!("clipboard: {e}")))?;
                                vec![ActiveStageOutput::ResponseFrame(
                                    s.stage.process_svc_processor_messages(messages)?,
                                )]
                            }
                            None => Vec::new(),
                        }
                    }
                }
            },
            Some(event) = clip_rx.recv() => match event {
                ClipboardEvent::RemoteText(text) => {
                    interact.event(RdpEvent::Clipboard { text });
                    Vec::new()
                }
                ClipboardEvent::Send(message) => clipboard_frame(&mut s.stage, message)?,
            },
            _ = clipboard_timer.tick() => {
                match s.stage.get_svc_processor_mut::<CliprdrClient>() {
                    Some(cliprdr) => match cliprdr.drive_timeouts() {
                        Ok(messages) => {
                            let frame = s.stage.process_svc_processor_messages(messages)?;
                            if frame.is_empty() {
                                Vec::new()
                            } else {
                                vec![ActiveStageOutput::ResponseFrame(frame)]
                            }
                        }
                        Err(_) => Vec::new(),
                    },
                    None => Vec::new(),
                }
            }
            _ = tokio::time::sleep_until(flush_at), if !s.region.is_empty() => {
                s.flush();
                Vec::new()
            }
        };

        for out in outputs {
            match out {
                ActiveStageOutput::ResponseFrame(bytes) => {
                    if !bytes.is_empty() {
                        writer.write_all(&bytes).await.map_err(|e| {
                            RdpError::Protocol(format!("the connection was lost ({e})"))
                        })?;
                    }
                }
                ActiveStageOutput::GraphicsUpdate(r) => {
                    let (w, h) = s.size();
                    s.region.add(
                        Rect {
                            x: r.left,
                            y: r.top,
                            w: r.right.saturating_sub(r.left).saturating_add(1),
                            h: r.bottom.saturating_sub(r.top).saturating_add(1),
                        },
                        w,
                        h,
                    );
                }
                ActiveStageOutput::PointerDefault => interact.event(RdpEvent::PointerDefault),
                ActiveStageOutput::PointerHidden => interact.event(RdpEvent::PointerHidden),
                ActiveStageOutput::PointerPosition { .. } => {}
                ActiveStageOutput::PointerBitmap(p) => s.pointer(&p),
                ActiveStageOutput::DeactivateAll => {
                    // Deactivation-Reactivation: the server is applying a new desktop size.
                    let mut sequence = activation.create();
                    let mut buf = WriteBuf::new();
                    let deadline = Instant::now() + REACTIVATION_TIMEOUT;
                    loop {
                        buf.clear();
                        let written = tokio::select! {
                            r = ironrdp_tokio::single_sequence_step_read(
                                &mut reader,
                                &mut sequence,
                                &mut buf,
                            ) => r?,
                            // A Close (or dropped sender) during reactivation ends the
                            // session cleanly instead of blocking on the server.
                            command = commands.recv() => match command {
                                None | Some(Command::Close) => {
                                    let frames = s.stage.graceful_shutdown()?;
                                    for f in frames {
                                        if let ActiveStageOutput::ResponseFrame(bytes) = f {
                                            let _ = writer.write_all(&bytes).await;
                                        }
                                    }
                                    break 'session "The session was closed.".to_owned();
                                }
                                // Input/resize/clipboard are dropped during the brief resize.
                                _ => continue,
                            },
                            _ = tokio::time::sleep_until(deadline) => {
                                return Err(RdpError::Protocol(
                                    "the server did not finish resizing the desktop in time".into(),
                                ));
                            }
                        };
                        if written.size().is_some() {
                            writer.write_all(buf.filled()).await.map_err(|e| {
                                RdpError::Protocol(format!("the connection was lost ({e})"))
                            })?;
                        }
                        if let ConnectionActivationState::Finalized {
                            desktop_size,
                            share_id,
                            enable_server_pointer,
                            pointer_software_rendering,
                        } = sequence.connection_activation_state()
                        {
                            s.image = DecodedImage::new(
                                PixelFormat::RgbA32,
                                desktop_size.width,
                                desktop_size.height,
                            );
                            s.stage.set_fastpath_processor(
                                fast_path::ProcessorBuilder {
                                    io_channel_id: sequence.io_channel_id(),
                                    user_channel_id: sequence.user_channel_id(),
                                    share_id,
                                    enable_server_pointer,
                                    pointer_software_rendering,
                                    bulk_decompressor: None,
                                }
                                .build(),
                            );
                            s.stage.set_share_id(share_id);
                            s.stage.set_enable_server_pointer(enable_server_pointer);
                            s.region.add_all(desktop_size.width, desktop_size.height);
                            interact.event(RdpEvent::Resized {
                                width: desktop_size.width,
                                height: desktop_size.height,
                            });
                            break;
                        }
                    }
                }
                ActiveStageOutput::Terminate(reason) => {
                    s.flush();
                    break 'session capitalize(&reason.description());
                }
                ActiveStageOutput::MultitransportRequest(_) | ActiveStageOutput::AutoDetect(_) => {}
            }
        }

        // Display Control connects shortly after the session starts; retry a resize the
        // view asked for before then.
        if let Some(frame) = s.encode_pending_resize()? {
            writer
                .write_all(&frame)
                .await
                .map_err(|e| RdpError::Protocol(format!("the connection was lost ({e})")))?;
        }
        if !s.region.is_empty() && s.last_flush.elapsed() >= FRAME_INTERVAL {
            s.flush();
        }
    };
    Ok(reason)
}

fn clipboard_frame(
    stage: &mut ActiveStage,
    message: ClipboardMessage,
) -> Result<Vec<ActiveStageOutput>, RdpError> {
    let Some(cliprdr) = stage.get_svc_processor_mut::<CliprdrClient>() else {
        return Ok(Vec::new());
    };
    let err = |e: ironrdp::pdu::PduError| RdpError::Protocol(format!("clipboard: {e}"));
    let messages = match message {
        ClipboardMessage::SendInitiateCopy(formats) => {
            cliprdr.initiate_copy(&formats).map_err(err)?
        }
        ClipboardMessage::SendFormatData(response) => {
            cliprdr.submit_format_data(response).map_err(err)?
        }
        ClipboardMessage::SendInitiatePaste(format) => {
            cliprdr.initiate_paste(format).map_err(err)?
        }
        // Text only: no file transfer through the clipboard.
        _ => return Ok(Vec::new()),
    };
    Ok(vec![ActiveStageOutput::ResponseFrame(
        stage.process_svc_processor_messages(messages)?,
    )])
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => format!(
            "{}{}.",
            first.to_uppercase(),
            chars.as_str().trim_end_matches('.')
        ),
        None => "The session ended.".to_owned(),
    }
}

/// Connect over plain TCP.
pub fn tcp_dialer(host: String, port: u16) -> Dialer {
    Box::pin(async move {
        let target = format!("{host}:{port}");
        let stream = tokio::net::TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|source| RdpError::Connect {
                target: target.clone(),
                source,
            })?;
        let _ = stream.set_nodelay(true);
        let local = stream
            .local_addr()
            .map_err(|source| RdpError::Connect { target, source })?;
        Ok((Box::new(stream) as Transport, local))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(security: Security) -> RdpConfig {
        RdpConfig {
            host: "srv".into(),
            port: 3389,
            username: "admin".into(),
            password: "pw".into(),
            domain: Some(String::new()),
            security,
            color_depth: ColorDepth::Bpp16,
            width: 1280,
            height: 720,
            scale_factor: 0,
            clipboard: true,
        }
    }

    #[test]
    fn builds_connector_config_for_nla_and_tls() {
        let nla = connector_config(&config(Security::Nla));
        assert!(nla.enable_credssp && nla.enable_tls && nla.autologon);
        assert_eq!(nla.domain, None);
        assert_eq!(nla.bitmap.as_ref().map(|b| b.color_depth), Some(16));
        assert_eq!(
            (nla.desktop_size.width, nla.desktop_size.height),
            (1280, 720)
        );
        let tls = connector_config(&config(Security::Tls));
        assert!(!tls.enable_credssp && tls.autologon);
    }

    #[test]
    fn capitalizes_disconnect_reasons() {
        assert_eq!(
            capitalize("server initiated disconnect"),
            "Server initiated disconnect."
        );
        assert_eq!(capitalize(""), "The session ended.");
    }

    #[tokio::test]
    async fn refused_tcp_connection_explains_itself() {
        // Bind then drop to get a port nothing listens on.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .map(|a| a.port())
            .expect("free port");
        let Err(err) = tcp_dialer("127.0.0.1".into(), port).await else {
            panic!("connect should fail");
        };
        assert!(err.to_string().contains("Could not reach 127.0.0.1"));
    }
}
