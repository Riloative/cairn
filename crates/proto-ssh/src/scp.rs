//! SCP (the classic rcp-style protocol over `scp -f` / `scp -t`) for network devices
//! that have an SCP server but no SFTP (Cisco IOS `ip scp server enable`).

use crate::connect::Connection;
use crate::error::SshError;
use std::path::Path;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::watch;

const CHUNK: usize = 32 * 1024;

/// Quote a remote path for the server's shell only when needed: network OSes such
/// as IOS do not understand quotes (`flash:ios.bin` must stay as is).
pub fn quote(path: &str) -> String {
    let safe = path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_-./:@+=,~".contains(c));
    if safe && !path.is_empty() {
        path.to_owned()
    } else {
        format!("'{}'", path.replace('\'', "'\\''"))
    }
}

/// A `C` header line: `C0644 <size> <name>`.
pub fn parse_header(line: &str) -> Result<(u32, u64, String), SshError> {
    let bad = || SshError::Scp(format!("unexpected reply \"{}\"", line.trim()));
    let rest = line.strip_prefix('C').ok_or_else(bad)?;
    let mut parts = rest.splitn(3, ' ');
    let mode = u32::from_str_radix(parts.next().ok_or_else(bad)?, 8).map_err(|_| bad())?;
    let size = parts.next().ok_or_else(bad)?.parse().map_err(|_| bad())?;
    let name = parts
        .next()
        .ok_or_else(bad)?
        .trim_end_matches('\n')
        .to_owned();
    Ok((mode, size, name))
}

async fn read_line<S: AsyncRead + Unpin>(s: &mut S) -> Result<String, SshError> {
    let mut out = Vec::new();
    loop {
        let mut b = [0u8; 1];
        let n = s
            .read(&mut b)
            .await
            .map_err(|e| SshError::Scp(e.to_string()))?;
        if n == 0 || b[0] == b'\n' {
            break;
        }
        out.push(b[0]);
        if out.len() > 4096 {
            return Err(SshError::Scp("reply line too long".into()));
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Read the one-byte status; 1/2 are followed by an error message.
async fn ack<S: AsyncRead + Unpin>(s: &mut S) -> Result<(), SshError> {
    let mut b = [0u8; 1];
    let n = s
        .read(&mut b)
        .await
        .map_err(|e| SshError::Scp(e.to_string()))?;
    match (n, b[0]) {
        (0, _) => Err(SshError::Scp("the device closed the connection".into())),
        (_, 0) => Ok(()),
        (_, 1 | 2) => {
            let msg = read_line(s).await?;
            Err(SshError::Scp(
                msg.trim().trim_start_matches("scp: ").to_owned(),
            ))
        }
        (_, other) => {
            // Some devices answer with a text line straight away.
            let rest = read_line(s).await.unwrap_or_default();
            Err(SshError::Scp(
                format!("{}{}", char::from(other), rest).trim().to_owned(),
            ))
        }
    }
}

async fn exec(
    conn: &Connection,
    command: String,
) -> Result<russh::ChannelStream<russh::client::Msg>, SshError> {
    let channel = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| SshError::Scp(e.to_string()))?;
    channel
        .exec(true, command)
        .await
        .map_err(|e| SshError::Scp(e.to_string()))?;
    Ok(channel.into_stream())
}

async fn pump<R, W>(
    src: &mut R,
    dst: &mut W,
    len: u64,
    progress: &impl Fn(u64),
    cancel: &watch::Receiver<bool>,
) -> Result<(), SshError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    while done < len {
        if *cancel.borrow() {
            return Err(SshError::Cancelled);
        }
        let want = usize::try_from((len - done).min(CHUNK as u64)).unwrap_or(CHUNK);
        let n = src
            .read(&mut buf[..want])
            .await
            .map_err(|e| SshError::Scp(e.to_string()))?;
        if n == 0 {
            return Err(SshError::Scp("the transfer ended early".into()));
        }
        dst.write_all(&buf[..n])
            .await
            .map_err(|e| SshError::Scp(e.to_string()))?;
        done += n as u64;
        progress(done);
    }
    Ok(())
}

/// Download one remote file into `local`.
pub async fn download(
    conn: &Connection,
    remote: &str,
    local: &Path,
    progress: impl Fn(u64),
    cancel: watch::Receiver<bool>,
) -> Result<u64, SshError> {
    let mut s = exec(conn, format!("scp -f {}", quote(remote))).await?;
    let io = |e: std::io::Error| SshError::Scp(e.to_string());
    s.write_all(&[0]).await.map_err(io)?;
    // Skip a `T` (times) record if the server sends one.
    let header = loop {
        let mut first = [0u8; 1];
        s.read_exact(&mut first).await.map_err(io)?;
        match first[0] {
            b'C' => break format!("C{}", read_line(&mut s).await?),
            b'T' => {
                read_line(&mut s).await?;
                s.write_all(&[0]).await.map_err(io)?;
            }
            1 | 2 => {
                let msg = read_line(&mut s).await?;
                return Err(SshError::Scp(
                    msg.trim().trim_start_matches("scp: ").to_owned(),
                ));
            }
            b'D' => {
                return Err(SshError::Scp(
                    "folders are not supported over SCP; choose a file".into(),
                ))
            }
            other => {
                let rest = read_line(&mut s).await.unwrap_or_default();
                return Err(SshError::Scp(
                    format!("{}{}", char::from(other), rest).trim().to_owned(),
                ));
            }
        }
    };
    let (_, size, _) = parse_header(&header)?;
    s.write_all(&[0]).await.map_err(io)?;
    let part = local.with_file_name(format!(
        ".{}.cairn-part",
        local
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| SshError::Scp(format!("Could not create {} ({e})", part.display())))?;
    let result = async {
        pump(&mut s, &mut file, size, &progress, &cancel).await?;
        ack(&mut s).await?;
        s.write_all(&[0]).await.map_err(io)?;
        file.flush().await.map_err(io)
    }
    .await;
    drop(file);
    match result {
        Ok(()) => {
            tokio::fs::rename(&part, local)
                .await
                .map_err(|e| SshError::Scp(format!("Could not save {} ({e})", local.display())))?;
            Ok(size)
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(e)
        }
    }
}

/// Upload `local` to the remote path (a full file name, e.g. `flash:ios.bin`).
pub async fn upload(
    conn: &Connection,
    local: &Path,
    remote: &str,
    progress: impl Fn(u64),
    cancel: watch::Receiver<bool>,
) -> Result<u64, SshError> {
    let mut file = tokio::fs::File::open(local)
        .await
        .map_err(|e| SshError::Scp(format!("Could not open {} ({e})", local.display())))?;
    let size = file
        .metadata()
        .await
        .map_err(|e| SshError::Scp(e.to_string()))?
        .len();
    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().replace('\n', "_"))
        .unwrap_or_else(|| "file".into());
    let io = |e: std::io::Error| SshError::Scp(e.to_string());
    let mut s = exec(conn, format!("scp -t {}", quote(remote))).await?;
    ack(&mut s).await?;
    s.write_all(format!("C0644 {size} {name}\n").as_bytes())
        .await
        .map_err(io)?;
    ack(&mut s).await?;
    pump(&mut file, &mut s, size, &progress, &cancel).await?;
    s.write_all(&[0]).await.map_err(io)?;
    ack(&mut s).await?;
    let _ = s.shutdown().await;
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_keeps_device_paths_intact() {
        assert_eq!(quote("flash:c2960.bin"), "flash:c2960.bin");
        assert_eq!(quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn parses_headers() {
        assert_eq!(
            parse_header("C0644 1234 running-config").expect("ok"),
            (0o644, 1234, "running-config".into())
        );
        assert!(parse_header("D0755 0 dir").is_err());
        assert!(parse_header("C0644 x name").is_err());
    }

    #[tokio::test]
    async fn ack_reports_device_errors() {
        let mut ok: &[u8] = &[0];
        assert!(ack(&mut ok).await.is_ok());
        let mut fail: &[u8] = b"\x01scp: flash:x: No such file\n";
        match ack(&mut fail).await {
            Err(SshError::Scp(m)) => assert_eq!(m, "flash:x: No such file"),
            other => panic!("{other:?}"),
        }
    }
}
