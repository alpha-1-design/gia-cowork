//! Real Linux terminal backend for GIA Desktop.
//!
//! Unlike the Android app -- which has to run a whole proot+Alpine guest
//! because Android gives you no real shell -- desktop Linux already *is*
//! a real shell. There is no rootfs, no sandbox, no proot binary to bundle
//! or extract. We spawn the platform command interpreter directly on the host and stream
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

// process_group(0) puts each spawned shell in its own process group so a
// later kill can signal the whole tree, not just the shell parent.
#[cfg(not(target_os = "windows"))]
use std::os::unix::process::CommandExt;

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_TIMEOUT_MS: u64 = 10 * 60_000;
const MAX_OUTPUT_BYTES: usize = 10 * 1024 * 1024;

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

/// Kill a session's whole process tree, not just the shell parent. Killing
/// only `sh -c "npm run dev"` leaves every grandchild (the dev server, a
/// compiler, a downloaded installer) running as an orphan that still holds
/// ports and files — and `terminal_get_status` keeps counting them.
fn kill_process_tree(child: &mut Child) {
    let pid = child.id();
    let _ = child.kill();
    let _ = child.wait();
    #[cfg(target_os = "windows")]
    {
        // /T = tree (children too), /F = force. taskkill ships with every
        // Windows install; the direct child may already be gone, in which
        // case taskkill just fails harmlessly against the survivors.
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // The shell was spawned with process_group(0), so its pgid equals
        // its pid and `kill -9 -- -PGID` signals the entire group. Routed
        // through sh because kill is a shell builtin on minimal systems
        // (this module already requires sh for exec, so it adds no new
        // platform requirement).
        let _ = Command::new("sh")
            .arg("-c")
            .arg(format!("kill -9 -- '-{pid}' 2>/dev/null"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

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
    if command.trim().is_empty() {
        return Err("Command is required".into());
    }
    let timeout_ms = timeout
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);
    let session_id = new_session_id();

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut command_builder = Command::new("powershell.exe");
        command_builder
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"])
            .arg(&command);
        command_builder
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut command_builder = Command::new("sh");
        command_builder.arg("-c").arg(&command);
        command_builder
    };
    // Own process group on Unix (pgid == child pid) so kill_process_tree can
    // take down the whole tree. Windows handles the tree via `taskkill /T`.
    #[cfg(not(target_os = "windows"))]
    cmd.process_group(0);
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
                        kill_process_tree(&mut entry.child);
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
        let mut limited = s.take(MAX_OUTPUT_BYTES as u64);
        let _ = limited.read_to_string(&mut out);
    }
    let mut err = String::new();
    if let Some(s) = stderr.as_mut() {
        let remaining = MAX_OUTPUT_BYTES.saturating_sub(out.len());
        let mut limited = s.take(remaining as u64);
        let _ = limited.read_to_string(&mut err);
    }
    let output_truncated = out.len() + err.len() >= MAX_OUTPUT_BYTES;
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
    if output_truncated {
        out.push_str(&format!(
            "\n[output truncated] maximum output is {}MB",
            MAX_OUTPUT_BYTES / 1024 / 1024
        ));
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
        kill_process_tree(&mut entry.child);
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
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "(Get-PSDrive -Name (Split-Path $HOME -Qualifier).TrimEnd(':')).Free"])
            .output()
            .map_err(|e| format!("PowerShell disk query failed: {e}"))?;
        let free_bytes = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u64>()
            .unwrap_or(0);
        return Ok(FsInfo {
            total_bytes: 0,
            free_bytes,
            used_bytes: 0,
        });
    }

    // Report disk usage for $HOME, mirroring what the Android plugin reports
    // for the app's terminal data directory. `df` is available on every
    // real Linux desktop (no proot/rootfs to inspect here).
    #[cfg(not(target_os = "windows"))]
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    #[cfg(not(target_os = "windows"))]
    let output = Command::new("df")
        .arg("-B1")
        .arg(&home)
        .output()
        .map_err(|e| format!("df failed: {e}"))?;
    #[cfg(not(target_os = "windows"))]
    let text = String::from_utf8_lossy(&output.stdout);
    #[cfg(not(target_os = "windows"))]
    let line = text.lines().nth(1).ok_or("unexpected df output")?;
    #[cfg(not(target_os = "windows"))]
    let cols: Vec<&str> = line.split_whitespace().collect();
    #[cfg(not(target_os = "windows"))]
    if cols.len() < 4 {
        return Err("unexpected df column count".into());
    }
    #[cfg(not(target_os = "windows"))]
    let total: u64 = cols[1].parse().unwrap_or(0);
    #[cfg(not(target_os = "windows"))]
    let used: u64 = cols[2].parse().unwrap_or(0);
    #[cfg(not(target_os = "windows"))]
    let free: u64 = cols[3].parse().unwrap_or(0);
    #[cfg(not(target_os = "windows"))]
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
