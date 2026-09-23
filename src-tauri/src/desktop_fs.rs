//! Real host filesystem for GIA Desktop.
//!
//! The Android build reaches the filesystem through the Capacitor Filesystem
//! plugin, which is sandboxed to the app's private directory (that's why the
//! shared `tools/filesystem.ts` talks in terms of "Documents", "Downloads",
//! and proot rootfs paths). A desktop app has no such sandbox -- it can
//! already touch every file the user owns. These commands give the frontend
//! (and via `tools/filesystem.ts`, the agent) a real `fs_read` / `fs_write` /
//! `fs_list` path using ordinary `std::fs`, with no emulated filesystem layers.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

/// Max text size we are willing to hand back in one read -- matches
/// MAX_FILE_SIZE (10MB) in the shared frontend helpers.
const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct EntryInfo {
    pub name: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    pub size: u64,
    #[serde(rename = "modifiedMs")]
    pub modified_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
pub struct ReadResult {
    pub content: String,
    pub size: usize,
}

#[derive(Clone, Serialize)]
pub struct WriteResult {
    pub size: usize,
}

#[derive(Clone, Serialize)]
pub struct ListResult {
    #[serde(rename = "currentDir")]
    pub current_dir: String,
    pub entries: Vec<EntryInfo>,
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .or_else(|| {
            std::env::var_os("HOMEDRIVE")
                .zip(std::env::var_os("HOMEPATH"))
                .map(|(drive, path)| {
                    let mut home = PathBuf::from(drive);
                    home.push(path);
                    home.into_os_string()
                })
        })
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().map_err(|e| format!("Could not determine the user home directory: {e}")))
}

fn workspace_root() -> Result<PathBuf, String> {
    let configured = std::env::var_os("GIA_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or(home_dir()?);
    let root = if configured.is_absolute() {
        configured
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Could not resolve workspace: {e}"))?
            .join(configured)
    };
    if !root.exists() {
        fs::create_dir_all(&root)
            .map_err(|e| format!("Could not create workspace {}: {e}", root.display()))?;
    }
    fs::canonicalize(&root)
        .map_err(|e| format!("Workspace {} is not accessible: {e}", root.display()))
}

fn ensure_in_workspace(path: &PathBuf, for_write: bool) -> Result<PathBuf, String> {
    let root = workspace_root()?;
    let canonical = if path.exists() {
        fs::canonicalize(path)
            .map_err(|e| format!("Cannot resolve {}: {e}", path.display()))?
    } else if for_write {
        let parent = path
            .parent()
            .ok_or_else(|| format!("Cannot resolve parent of {}", path.display()))?;
        let canonical_parent = fs::canonicalize(parent)
            .map_err(|e| format!("Cannot resolve parent {}: {e}", parent.display()))?;
        canonical_parent.join(
            path.file_name()
                .ok_or_else(|| format!("Invalid path {}", path.display()))?,
        )
    } else {
        return Err(format!("Path does not exist: {}", path.display()));
    };

    if canonical == root || canonical.starts_with(&root) {
        Ok(canonical)
    } else {
        Err(format!(
            "Path {} is outside the configured GIA workspace {}",
            path.display(),
            root.display()
        ))
    }
}

/// Resolve a user-supplied path: expand `~`, and make relative paths
/// absolute against the process working directory.
fn resolve_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("Path is required".into());
    }
    if raw.contains('\0') {
        return Err("Path contains a NUL byte".into());
    }
    let trimmed = raw.trim();
    let mut p = if trimmed == "~" {
        home_dir()?
    } else if trimmed.starts_with("~/") {
        home_dir()?.join(&trimmed[2..])
    } else {
        PathBuf::from(trimmed)
    };
    if !p.is_absolute() {
        p = std::env::current_dir()
            .map_err(|e| format!("Could not resolve working directory: {e}"))?
            .join(p);
    }
    Ok(p)
}

/// Read a text file from the host filesystem.
#[tauri::command]
pub async fn fs_read(path: String) -> Result<ReadResult, String> {
    let p = ensure_in_workspace(&resolve_path(&path)?, false)?;
    let meta = fs::metadata(&p).map_err(|e| format!("Cannot read {}: {e}", p.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a directory, not a file", p.display()));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "File exceeds {}MB limit",
            MAX_READ_BYTES / 1024 / 1024
        ));
    }
    let content = fs::read_to_string(&p)
        .map_err(|e| format!("Cannot read {} as UTF-8 text: {e}", p.display()))?;
    Ok(ReadResult {
        size: content.len(),
        content,
    })
}

/// Write (create or overwrite) a text file on the host filesystem.
#[tauri::command]
pub async fn fs_write(path: String, content: String) -> Result<WriteResult, String> {
    let p = ensure_in_workspace(&resolve_path(&path)?, true)?;
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create directory {}: {e}", parent.display()))?;
        }
    }
    fs::write(&p, content.as_bytes())
        .map_err(|e| format!("Cannot write {}: {e}", p.display()))?;
    let size = fs::metadata(&p).map(|m| m.len() as usize).unwrap_or(content.len());
    Ok(WriteResult { size })
}

/// Append (or create) raw binary bytes on the host filesystem.
///
/// The download companion to `fs_write`, for binary artifacts (AppImage, deb,
/// rpm). The frontend streams a remote file and POSTs base64 chunks, so a
/// large installer never needs to sit whole in webview memory. When `append`
/// is false (the first chunk) the file is (re)created from scratch;
/// subsequent chunks append.
#[tauri::command]
pub async fn fs_write_bytes(
    path: String,
    chunk_b64: String,
    append: Option<bool>,
) -> Result<WriteResult, String> {
    use base64::Engine;
    let p = ensure_in_workspace(&resolve_path(&path)?, true)?;
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create directory {}: {e}", parent.display()))?;
        }
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(chunk_b64.trim())
        .map_err(|e| format!("Invalid base64 chunk: {e}"))?;

    use std::io::Write;
    let mut opts = fs::OpenOptions::new();
    opts.create(true).write(true);
    if append.unwrap_or(false) {
        opts.append(true);
    } else {
        opts.truncate(true);
    }
    let mut f = opts
        .open(&p)
        .map_err(|e| format!("Cannot open {}: {e}", p.display()))?;
    f.write_all(&bytes)
        .map_err(|e| format!("Cannot write {}: {e}", p.display()))?;
    let size = fs::metadata(&p).map(|m| m.len() as usize).unwrap_or(bytes.len());
    Ok(WriteResult { size })
}

/// List the entries of a directory on the host filesystem.
#[tauri::command]
pub async fn fs_list(path: Option<String>) -> Result<ListResult, String> {
    let p = match path {
        Some(p) if !p.trim().is_empty() => ensure_in_workspace(&resolve_path(&p)?, false)?,
        _ => workspace_root()?,
    };
    let entries_rd = fs::read_dir(&p).map_err(|e| format!("Cannot list {}: {e}", p.display()))?;

    let mut entries = Vec::new();
    for entry in entries_rd {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().ok();
        let modified = meta.as_ref().and_then(|m| m.modified().ok());
        entries.push(EntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            modified_ms: modified.map(|t| {
                t.duration_since(SystemTime::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            }),
        });
    }

    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(ListResult {
        current_dir: p.display().to_string(),
        entries,
    })
}