//! Runs [`cairn_core::tools::grab::Grabber`] on a separate shell channel of an open
//! connection, so the user's terminal is not disturbed.

use crate::connect::Connection;
use crate::error::SshError;
use cairn_core::tools::grab::{GrabPlan, Grabber, Step};
use cairn_core::SecretString;
use russh::ChannelMsg;
use std::time::{Duration, Instant};

/// Output is considered complete after this much silence (prompts lack a newline).
const IDLE: Duration = Duration::from_millis(900);
/// Large configurations over slow links can take a while.
const DEADLINE: Duration = Duration::from_secs(300);

/// Grab the configuration; returns it cleaned of echo, prompts and pager output.
pub async fn grab(
    conn: &Connection,
    plan: GrabPlan,
    enable: Option<SecretString>,
) -> Result<String, SshError> {
    let mut channel = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| SshError::Grab(format!("the device refused a second session ({e})")))?;
    // Wide lines keep long config lines unwrapped; paging is turned off separately.
    channel
        .request_pty(false, "vt100", 511, 200, 0, 0, &[])
        .await
        .map_err(|e| SshError::Grab(e.to_string()))?;
    channel
        .request_shell(false)
        .await
        .map_err(|e| SshError::Grab(e.to_string()))?;

    let mut grabber = Grabber::new(plan, enable);
    let started = Instant::now();
    let result = loop {
        if started.elapsed() > DEADLINE {
            break Err(SshError::Grab(
                "the device did not finish within 5 minutes".into(),
            ));
        }
        let steps = match tokio::time::timeout(IDLE, channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => grabber.feed(&data),
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => grabber.feed(&data),
            Ok(Some(ChannelMsg::Eof | ChannelMsg::Close)) | Ok(None) => {
                break Err(SshError::Grab("the device closed the session".into()))
            }
            Ok(Some(_)) => continue,
            Err(_) => grabber.idle(),
        };
        let mut outcome = None;
        for step in steps {
            match step {
                Step::Send(bytes) => {
                    if let Err(e) = channel.data(&bytes[..]).await {
                        outcome = Some(Err(SshError::Grab(e.to_string())));
                        break;
                    }
                }
                Step::Done(config) => outcome = Some(Ok(config)),
                Step::Fail(msg) => outcome = Some(Err(SshError::Grab(msg))),
            }
        }
        if let Some(o) = outcome {
            break o;
        }
    };
    let _ = channel.close().await;
    result
}
