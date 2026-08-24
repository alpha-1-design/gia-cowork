//! Real Linux terminal backend for GIA Desktop.
//!
//! Unlike the Android app -- which has to run a whole proot+Alpine guest
//! because Android gives you no real shell -- desktop Linux already *is*
//! a real shell. There is no rootfs, no sandbox, no proot binary to bundle
//! or extract. We spawn `sh -c "<command>"` directly on the host and stream
//! it back. This module intentionally mirrors the shape of the Android
//! GIATerminalPlugin's exec/kill/listSessions/getFSInfo/getStatus contract
//! (see TerminalService.ts) so the shared TypeScript frontend needs only a
//! thin platform adapter, not a rewrite.

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize)]
pub struct ExecResult {
    pub output: String,
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

#[derive(Clone, Serialize)]
pub struct SessionInfo {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub command: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    pub running: bool,
}

#[derive(Clone, Serialize)]
pub struct FsInfo {
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "freeBytes")]
    pub free_bytes: u64,
    #[serde(rename = "usedBytes")]
    pub used_bytes: u64,
}

#[derive(Clone, Serialize)]
pub struct StatusInfo {
    pub running: bool,
    #[serde(rename = "sessionCount")]
    pub session_count: usize,
}

#[derive(Clone, Serialize)]
pub struct ReinstallResult {
    pub success: bool,
    pub message: String,
}

struct SessionEntry {
    child: Child,
    command: String,
    created_at: u64,
}

/// Shared session table. Tauri manages this as app state so every command
/// invocation sees the same map.
#[derive(Default)]
pub struct TerminalState(pub Mutex<HashMap<String, SessionEntry>>);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn new_session_id() -> String {
    // No uuid crate needed -- timestamp + a random-ish counter is unique
    // enough for a local, single-user session table.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("sess-{}-{}", now_ms(), n)
}

#[tauri::command]
pub async fn terminal_exec(
    state: tauri::State<'_, Arc<TerminalState>>,
    command: String,
    workdir: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout: Option<u64>,
) -> Result<ExecResult, String> {
    let timeout_ms = timeout.unwrap_or(60_000);
    let session_id = new_session_id();

    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(&command);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());

    if let Some(dir) = &workdir {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }
    if let Some(vars) = &env {
        for (k, v) in vars {
            cmd.env(k, v);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {e}"))?;

    // Take the pipes before the Child moves into shared state, so we can
    // read them from this call while terminal_kill/terminal_list_sessions
    // can concurrently see and act on the same process from another
    // invocation (e.g. the UI's "stop" button while a command is running).
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let created_at = now_ms();

    {
        let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
        sessions.insert(
            session_id.clone(),
            SessionEntry {
                child,
                command: command.clone(),
                created_at,
            },
        );
    }

    let start = Instant::now();
    let exit_code: i32;
    let mut timed_out = false;
    let mut killed_externally = false;

    loop {
        let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
        match sessions.get_mut(&session_id) {
            None => {
                // Removed by a concurrent terminal_kill() call.
                killed_externally = true;
                exit_code = -1;
                break;
            }
            Some(entry) => match entry.child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => {
                    sessions.remove(&session_id);
                    exit_code = status.code().unwrap_or(-1);
                    break;
                }
                None => {
                    if start.elapsed() > Duration::from_millis(timeout_ms) {
                        let _ = entry.child.kill();
                        let _ = entry.child.wait();
                        sessions.remove(&session_id);
                        timed_out = true;
                        exit_code = -1;
                        break;
                    }
                }
            },
        }
        drop(sessions);
        std::thread::sleep(Duration::from_millis(25));
    }

    let mut out = String::new();
    if let Some(s) = stdout.as_mut() {
        let _ = s.read_to_string(&mut out);
    }
    let mut err = String::new();
    if let Some(s) = stderr.as_mut() {
        let _ = s.read_to_string(&mut err);
    }
    if !err.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&err);
    }
    if timed_out {
        out.push_str(&format!(
            "\n[timeout] command exceeded {timeout_ms}ms and was killed"
        ));
    }
    if killed_externally {
        out.push_str("\n[killed] session was terminated");
    }

    Ok(ExecResult {
        output: out,
        exit_code,
        session_id,
    })
}

#[tauri::command]
pub fn terminal_kill(
    state: tauri::State<'_, Arc<TerminalState>>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut entry) = sessions.remove(&session_id) {
        entry.child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_list_sessions(
    state: tauri::State<'_, Arc<TerminalState>>,
) -> Result<Vec<SessionInfo>, String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (id, entry) in sessions.iter_mut() {
        let running = matches!(entry.child.try_wait(), Ok(None));
        out.push(SessionInfo {
            session_id: id.clone(),
            command: entry.command.clone(),
            created_at: entry.created_at,
            running,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn terminal_get_fs_info() -> Result<FsInfo, String> {
    // Report disk usage for $HOME, mirroring what the Android plugin reports
    // for the app's terminal data directory. `df` is available on every
    // real Linux desktop (no proot/rootfs to inspect here).
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let output = Command::new("df")
        .arg("-B1")
        .arg(&home)
        .output()
        .map_err(|e| format!("df failed: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().nth(1).ok_or("unexpected df output")?;
    let cols: Vec<&str> = line.split_whitespace().collect();
    if cols.len() < 4 {
        return Err("unexpected df column count".into());
    }
    let total: u64 = cols[1].parse().unwrap_or(0);
    let used: u64 = cols[2].parse().unwrap_or(0);
    let free: u64 = cols[3].parse().unwrap_or(0);
    Ok(FsInfo {
        total_bytes: total,
        free_bytes: free,
        used_bytes: used,
    })
}

#[tauri::command]
pub fn terminal_get_status(
    state: tauri::State<'_, Arc<TerminalState>>,
) -> Result<StatusInfo, String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    let mut count = 0;
    for (_, e) in sessions.iter_mut() {
        if matches!(e.child.try_wait(), Ok(None)) {
            count += 1;
        }
    }
    Ok(StatusInfo {
        running: true,
        session_count: count,
    })
}

#[tauri::command]
pub fn terminal_reinstall_rootfs() -> Result<ReinstallResult, String> {
    // There is no rootfs on desktop -- GIA Desktop runs commands directly
    // against the host shell. This exists only so the shared TypeScript
    // TerminalService interface doesn't need a desktop-specific branch for
    // a button that makes no sense here.
    Ok(ReinstallResult {
        success: true,
        message: "GIA Desktop runs directly on your Linux shell -- no sandbox to reinstall.".into(),
    })
}
