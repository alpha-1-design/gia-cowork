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

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Suppress the console window Windows would otherwise flash on screen.
///
/// A Tauri build is a GUI-subsystem binary. When a GUI process spawns a
/// console-subsystem child (`powershell.exe`, `taskkill`) with no console of
/// its own, Windows allocates a brand-new console window for that child and
/// paints it on screen for the lifetime of the process. The user sees a black
/// terminal window blink open and closed on every single internal command --
/// which reads as "the app is running scripts in the background".
///
/// CREATE_NO_WINDOW (0x08000000) gives the child a console that is never
/// displayed. Stdout/stderr are already piped, so nothing is lost: this only
/// stops the window from being shown, it does not change what the child can
/// write.
///
/// This is the single most important line for how the app *feels* on Windows.
/// It must be applied to EVERY spawn, including the short-lived helpers in
/// `kill_process_tree` and the fs-info probe, because one un-flagged spawn is
/// one visible flash.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Build a `Command` that will never flash a console window on Windows.
///
/// On non-Windows this is the identity function, so call sites stay
/// platform-agnostic and cannot forget the flag on one branch.
fn quiet_command(program: &str) -> Command {
    // `creation_flags` takes &mut self and returns &mut Command, so it has to be
    // called as a statement and the owned `Command` returned at the end --
    // returning its result directly would be a type error.
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

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
        let _ = quiet_command("taskkill")
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

/// Drain one pipe to EOF on a background thread, returning the captured
/// bytes through the JoinHandle.
///
/// This must run CONCURRENTLY with the child, not after it exits: an OS
/// pipe buffer is only ~64KB, so a child that writes more than that blocks
/// in write() until somebody reads. The old code read stdout/stderr only
/// after try_wait() returned, so any chatty command deadlocked until the
/// timeout killed it -- and then the read still lost whatever exceeded the
/// pipe buffer. This thread is that somebody.
///
/// The thread keeps reading (and discarding) even after `cap` bytes are
/// stored: stopping the drain would re-block the child on a full pipe and
/// hang the very process we are trying to reap. Memory stays bounded
/// because only the first `cap` bytes are kept; the COMBINED
/// MAX_OUTPUT_BYTES cap is enforced later by `combine_capped`.
///
/// The thread always terminates: at process death the pipe write-ends
/// close, read() returns EOF (or an error when kill_process_tree tears
/// the pipe down), and the loop breaks. That is what makes join() after
/// the wait loop safe even on the timeout/kill paths.
fn drain_pipe<R: Read + Send + 'static>(mut pipe: R, cap: usize) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut captured: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => break, // EOF: the child (or its whole tree) is gone.
                Ok(n) => {
                    // Store only what fits; the excess is drained and
                    // dropped so the child can never block on a full pipe.
                    let room = cap.saturating_sub(captured.len());
                    captured.extend_from_slice(&chunk[..n.min(room)]);
                }
                // A read error (pipe torn down mid-flight by
                // kill_process_tree) counts as end-of-stream; whatever was
                // captured so far is kept.
                Err(_) => break,
            }
        }
        captured
    })
}

/// Merge captured stdout and stderr under a combined cap, mirroring the
/// historical on-disk behaviour: stdout first, stderr fills whatever room
/// is left, and a single '\n' separates the two streams.
///
/// Returns the combined text plus whether the captured output met or
/// exceeded the cap (the caller turns that into the "[output truncated]"
/// marker). Pure and cap-parameterized so the unit tests can exercise the
/// boundary logic with a tiny cap instead of 10MB buffers.
fn combine_capped(stdout: &[u8], stderr: &[u8], cap: usize) -> (String, bool) {
    let stdout = &stdout[..stdout.len().min(cap)];
    let stderr = &stderr[..stderr.len().min(cap.saturating_sub(stdout.len()))];
    // "Cap hit" means truncated, even if nothing had to be discarded at
    // exactly the boundary -- matching the old `>=` behaviour so existing
    // frontend expectations about the marker do not change.
    let truncated = stdout.len() + stderr.len() >= cap;
    let mut combined = Vec::with_capacity(stdout.len() + stderr.len() + 1);
    combined.extend_from_slice(stdout);
    if !stderr.is_empty() {
        if !stdout.is_empty() {
            combined.push(b'\n');
        }
        combined.extend_from_slice(stderr);
    }
    // from_utf8_lossy instead of read_to_string: shell output is not
    // guaranteed UTF-8, and the old read_to_string silently DROPPED every
    // byte captured the moment a single invalid byte appeared.
    (String::from_utf8_lossy(&combined).into_owned(), truncated)
}

#[tauri::command]
pub async fn terminal_exec(
    state: tauri::State<'_, Arc<TerminalState>>,
    gate: tauri::State<'_, crate::gate::GateState>,
    command: String,
    workdir: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout: Option<u64>,
) -> Result<ExecResult, String> {
    if command.trim().is_empty() {
        return Err("Command is required".into());
    }
    // Enforcement gate FIRST, before anything is spawned (see gate.rs).
    gate.check(&command)?;
    let timeout_ms = timeout
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);
    let session_id = new_session_id();

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut command_builder = quiet_command("powershell.exe");
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
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // Spawn the drain threads BEFORE the wait loop (see drain_pipe for
    // why). Each stream gets the full MAX_OUTPUT_BYTES as its per-stream
    // storage cap -- the combined cap is enforced once, downstream, so a
    // command that writes everything to stderr is not clipped twice.
    let stdout_reader = stdout.map(|s| drain_pipe(s, MAX_OUTPUT_BYTES));
    let stderr_reader = stderr.map(|s| drain_pipe(s, MAX_OUTPUT_BYTES));
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

    // join() waits for EOF on each pipe; both threads end at process
    // death because the pipe write-ends close (kill_process_tree takes
    // down the whole tree on the timeout and external-kill paths too), so
    // this cannot deadlock even when we killed the child ourselves.
    let stdout_bytes = stdout_reader
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let stderr_bytes = stderr_reader
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let (mut out, output_truncated) =
        combine_capped(&stdout_bytes, &stderr_bytes, MAX_OUTPUT_BYTES);
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
        let output = quiet_command("powershell.exe")
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    // Tiny cap so the boundary tests do not have to allocate 10MB.
    const TEST_CAP: usize = 1024;

    #[test]
    fn combine_keeps_plain_stdout_intact() {
        let (out, truncated) = combine_capped(b"hello", b"", TEST_CAP);
        assert_eq!(out, "hello");
        assert!(!truncated);
    }

    #[test]
    fn combine_joins_streams_with_a_single_newline() {
        let (out, truncated) = combine_capped(b"out", b"err", TEST_CAP);
        assert_eq!(out, "out\nerr");
        assert!(!truncated);
    }

    #[test]
    fn combine_adds_no_separator_when_stdout_is_empty() {
        let (out, truncated) = combine_capped(b"", b"err", TEST_CAP);
        assert_eq!(out, "err");
        assert!(!truncated);
    }

    #[test]
    fn combine_stderr_fills_only_the_remainder_after_stdout() {
        let stdout = vec![b'a'; TEST_CAP - 3];
        let stderr = vec![b'b'; 100];
        let (out, truncated) = combine_capped(&stdout, &stderr, TEST_CAP);
        // Combined output stops exactly at the cap: stdout first, then
        // only the 3 bytes of stderr that still fit.
        assert_eq!(out.len(), TEST_CAP);
        assert!(out.starts_with(&"a".repeat(TEST_CAP - 3)));
        assert!(out.ends_with("bbb"));
        assert!(truncated);
    }

    #[test]
    fn combine_stdout_beyond_cap_leaves_no_room_for_stderr() {
        let stdout = vec![b'x'; TEST_CAP + 50];
        let (out, truncated) = combine_capped(&stdout, b"hidden", TEST_CAP);
        assert_eq!(out.len(), TEST_CAP);
        assert!(!out.contains("hidden"));
        assert!(truncated);
    }

    #[test]
    fn combine_flags_truncation_exactly_at_the_cap() {
        // Hitting the cap exactly counts as truncated, matching the old
        // `>=` semantics.
        let stdout = vec![b'x'; TEST_CAP];
        let (out, truncated) = combine_capped(&stdout, b"", TEST_CAP);
        assert_eq!(out.len(), TEST_CAP);
        assert!(truncated);
    }

    #[test]
    fn drain_pipe_discards_beyond_cap_but_drains_to_eof() {
        // A stream larger than both the cap and the OS pipe buffer: the
        // reader must keep draining past the cap (otherwise the child
        // would block on write and deadlock) while storing only the first
        // `cap` bytes.
        let big = vec![7u8; 4 * TEST_CAP];
        let captured = drain_pipe(Cursor::new(big), TEST_CAP).join().unwrap();
        assert_eq!(captured, vec![7u8; TEST_CAP]);
    }

    #[test]
    fn drain_pipe_handles_empty_stream() {
        let captured = drain_pipe(Cursor::new(Vec::new()), TEST_CAP)
            .join()
            .unwrap();
        assert!(captured.is_empty());
    }
}
