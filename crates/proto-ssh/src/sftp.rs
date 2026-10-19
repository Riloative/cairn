//! SFTP over an established connection: browse, rename, delete, mkdir, chmod and
//! streamed transfers with progress and cancellation.

use crate::connect::Connection;
use crate::error::SshError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;
use serde::Serialize;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

const CHUNK: usize = 64 * 1024;
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
    Link,
    Other,
}

/// One directory entry for the file panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Modification time (Unix seconds).
    pub modified: Option<u32>,
    /// Permission bits (e.g. 0o644), without the file type.
    pub mode: u32,
    pub owner: Option<String>,
}

/// Join POSIX-style remote paths.
pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "." {
        name.to_owned()
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// The parent of a remote path ("/" stays "/").
pub fn parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() && path.starts_with('/') {
        return "/".into();
    }
    match trimmed.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => trimmed[..i].to_owned(),
        None => ".".into(),
    }
}

fn err(e: russh_sftp::client::error::Error) -> SshError {
    SshError::Sftp(e.to_string())
}

fn kind(attrs: &FileAttributes) -> EntryKind {
    if attrs.is_dir() {
        EntryKind::Dir
    } else if attrs.is_symlink() {
        EntryKind::Link
    } else if attrs.is_regular() {
        EntryKind::File
    } else {
        EntryKind::Other
    }
}

/// An SFTP session on its own channel of the connection.
pub struct Sftp {
    session: SftpSession,
}

impl std::fmt::Debug for Sftp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Sftp").finish_non_exhaustive()
    }
}

impl Sftp {
    pub async fn open(conn: &Connection) -> Result<Self, SshError> {
        let open = async {
            let channel = conn
                .handle
                .channel_open_session()
                .await
                .map_err(|e| SshError::SftpUnavailable(e.to_string()))?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| SshError::SftpUnavailable(e.to_string()))?;
            SftpSession::new(channel.into_stream())
                .await
                .map_err(|e| SshError::SftpUnavailable(e.to_string()))
        };
        let session = tokio::time::timeout(OPEN_TIMEOUT, open)
            .await
            .map_err(|_| SshError::SftpUnavailable("the server did not answer".into()))??;
        Ok(Self { session })
    }

    /// The login directory.
    pub async fn home(&self) -> Result<String, SshError> {
        self.session.canonicalize(".").await.map_err(err)
    }

    /// Entries of `dir`, folders first, then by name; "." and ".." are left out.
    pub async fn list(&self, dir: &str) -> Result<Vec<RemoteEntry>, SshError> {
        let entries = self.session.read_dir(dir).await.map_err(err)?;
        let mut out: Vec<RemoteEntry> = entries
            .filter(|e| e.file_name() != "." && e.file_name() != "..")
            .map(|e| {
                let attrs = e.metadata();
                RemoteEntry {
                    path: join(dir, &e.file_name()),
                    name: e.file_name(),
                    kind: kind(&attrs),
                    size: attrs.size.unwrap_or(0),
                    modified: attrs.mtime,
                    mode: attrs.permissions.unwrap_or(0) & 0o7777,
                    owner: attrs
                        .user
                        .clone()
                        .or_else(|| attrs.uid.map(|u| u.to_string())),
                }
            })
            .collect();
        out.sort_by(|a, b| {
            (a.kind != EntryKind::Dir)
                .cmp(&(b.kind != EntryKind::Dir))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), SshError> {
        self.session.create_dir(path).await.map_err(err)
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), SshError> {
        self.session.rename(from, to).await.map_err(err)
    }

    /// Change permission bits (e.g. 0o755).
    pub async fn chmod(&self, path: &str, mode: u32) -> Result<(), SshError> {
        let attrs = FileAttributes {
            permissions: Some(mode & 0o7777),
            ..FileAttributes::empty()
        };
        self.session.set_metadata(path, attrs).await.map_err(err)
    }

    /// Delete a file, or a folder with everything in it.
    pub async fn remove(&self, path: &str) -> Result<(), SshError> {
        let meta = self.session.symlink_metadata(path).await.map_err(err)?;
        if !meta.is_dir() {
            return self.session.remove_file(path).await.map_err(err);
        }
        // Depth-first without recursion (async recursion needs boxing).
        let mut stack = vec![(path.to_owned(), false)];
        while let Some((dir, visited)) = stack.pop() {
            if visited {
                self.session.remove_dir(&dir).await.map_err(err)?;
                continue;
            }
            stack.push((dir.clone(), true));
            for e in self.list(&dir).await? {
                if e.kind == EntryKind::Dir {
                    stack.push((e.path, false));
                } else {
                    self.session.remove_file(&e.path).await.map_err(err)?;
                }
            }
        }
        Ok(())
    }

    pub async fn size(&self, path: &str) -> Result<u64, SshError> {
        Ok(self
            .session
            .metadata(path)
            .await
            .map_err(err)?
            .size
            .unwrap_or(0))
    }

    /// Download to `local` (written to a temporary file, then renamed).
    pub async fn download(
        &self,
        remote: &str,
        local: &Path,
        progress: impl Fn(u64),
        cancel: watch::Receiver<bool>,
    ) -> Result<u64, SshError> {
        let mut src = self.session.open(remote).await.map_err(err)?;
        let part = part_path(local);
        let mut dst = tokio::fs::File::create(&part)
            .await
            .map_err(|e| SshError::Sftp(format!("Could not create {} ({e})", part.display())))?;
        let copied = copy(&mut src, &mut dst, progress, cancel).await;
        drop(dst);
        match copied {
            Ok(n) => {
                tokio::fs::rename(&part, local).await.map_err(|e| {
                    SshError::Sftp(format!("Could not save {} ({e})", local.display()))
                })?;
                Ok(n)
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&part).await;
                Err(e)
            }
        }
    }

    /// Upload `local` to `remote`; a cancelled upload removes the partial file.
    pub async fn upload(
        &self,
        local: &Path,
        remote: &str,
        progress: impl Fn(u64),
        cancel: watch::Receiver<bool>,
    ) -> Result<u64, SshError> {
        let mut src = tokio::fs::File::open(local)
            .await
            .map_err(|e| SshError::Sftp(format!("Could not open {} ({e})", local.display())))?;
        let mut dst = self.session.create(remote).await.map_err(err)?;
        let copied = copy(&mut src, &mut dst, progress, cancel).await;
        let closed = dst.shutdown().await;
        match (copied, closed) {
            (Ok(n), Ok(())) => Ok(n),
            (Err(e), _) => {
                let _ = self.session.remove_file(remote).await;
                Err(e)
            }
            (Ok(_), Err(e)) => Err(SshError::Sftp(format!("Could not finish {remote} ({e})"))),
        }
    }
}

fn part_path(local: &Path) -> std::path::PathBuf {
    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    local.with_file_name(format!(".{name}.cairn-part"))
}

async fn copy<R, W>(
    src: &mut R,
    dst: &mut W,
    progress: impl Fn(u64),
    cancel: watch::Receiver<bool>,
) -> Result<u64, SshError>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0u64;
    loop {
        if *cancel.borrow() {
            return Err(SshError::Cancelled);
        }
        let n = src
            .read(&mut buf)
            .await
            .map_err(|e| SshError::Sftp(format!("Read failed ({e})")))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])
            .await
            .map_err(|e| SshError::Sftp(format!("Write failed ({e})")))?;
        total += n as u64;
        progress(total);
    }
    dst.flush()
        .await
        .map_err(|e| SshError::Sftp(format!("Write failed ({e})")))?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(join("/home/admin", "a.txt"), "/home/admin/a.txt");
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join(".", "x"), "x");
        assert_eq!(parent("/home/admin/"), "/home");
        assert_eq!(parent("/home"), "/");
        assert_eq!(parent("/"), "/");
        assert_eq!(parent("rel"), ".");
    }
}
