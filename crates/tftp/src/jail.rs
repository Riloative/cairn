//! Mapping requested file names into the served folder, never outside it.

use std::path::{Component, Path, PathBuf};

/// Why a requested name was refused (sent to the client as an access violation).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JailError {
    /// `..`, a drive prefix, or an empty name.
    Invalid,
    /// Resolves (e.g. through a symlink) outside the root.
    Outside,
    NotFound,
}

/// The relative path inside the root for a requested name. Leading `/` and `\`, and
/// `\` separators (Windows-style clients), are accepted; `..` is not.
pub fn relative(name: &str) -> Result<PathBuf, JailError> {
    let normalized = name.replace('\\', "/");
    let trimmed = normalized.trim_start_matches('/');
    let mut out = PathBuf::new();
    for c in Path::new(trimmed).components() {
        match c {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err(JailError::Invalid),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(JailError::Invalid);
    }
    Ok(out)
}

/// An existing file to read, resolved inside `root` (symlinks may not escape it).
pub fn resolve_read(root: &Path, name: &str) -> Result<PathBuf, JailError> {
    let rel = relative(name)?;
    let root = root.canonicalize().map_err(|_| JailError::NotFound)?;
    let path = root
        .join(rel)
        .canonicalize()
        .map_err(|_| JailError::NotFound)?;
    if !path.starts_with(&root) {
        return Err(JailError::Outside);
    }
    if !path.is_file() {
        return Err(JailError::NotFound);
    }
    Ok(path)
}

/// Where to write a new file: its folder must exist inside `root`.
pub fn resolve_write(root: &Path, name: &str) -> Result<PathBuf, JailError> {
    let rel = relative(name)?;
    let root = root.canonicalize().map_err(|_| JailError::NotFound)?;
    let file_name = rel.file_name().ok_or(JailError::Invalid)?.to_owned();
    let parent = root
        .join(rel.parent().unwrap_or(Path::new("")))
        .canonicalize()
        .map_err(|_| JailError::NotFound)?;
    if !parent.starts_with(&root) || !parent.is_dir() {
        return Err(JailError::Outside);
    }
    let path = parent.join(file_name);
    // An existing symlink at the target could point outside the root.
    if path.is_symlink() {
        return Err(JailError::Outside);
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_names() {
        assert_eq!(
            relative("/cfg/sw1-confg"),
            Ok(PathBuf::from("cfg/sw1-confg"))
        );
        assert_eq!(
            relative("\\\\images\\ios.bin"),
            Ok(PathBuf::from("images/ios.bin"))
        );
        assert_eq!(relative("./a"), Ok(PathBuf::from("a")));
        assert_eq!(relative("../etc/passwd"), Err(JailError::Invalid));
        assert_eq!(relative("a/../../b"), Err(JailError::Invalid));
        assert_eq!(relative("/"), Err(JailError::Invalid));
    }

    #[test]
    fn stays_inside_the_root() {
        let dir = tempfile::tempdir().expect("tmp");
        let root = dir.path().join("root");
        std::fs::create_dir_all(root.join("sub")).expect("mkdir");
        std::fs::write(root.join("sub/a.bin"), b"x").expect("write");
        std::fs::write(dir.path().join("secret"), b"s").expect("write");
        assert!(resolve_read(&root, "sub/a.bin").is_ok());
        assert_eq!(resolve_read(&root, "missing"), Err(JailError::NotFound));
        assert_eq!(resolve_read(&root, "sub"), Err(JailError::NotFound));
        assert!(resolve_write(&root, "sub/new.cfg").is_ok());
        assert_eq!(
            resolve_write(&root, "nodir/new.cfg"),
            Err(JailError::NotFound)
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("secret"), root.join("link"))
                .expect("symlink");
            std::os::unix::fs::symlink(dir.path(), root.join("out")).expect("symlink");
            assert_eq!(resolve_read(&root, "link"), Err(JailError::Outside));
            assert_eq!(resolve_write(&root, "out/x"), Err(JailError::Outside));
            assert_eq!(resolve_write(&root, "link"), Err(JailError::Outside));
        }
    }
}
