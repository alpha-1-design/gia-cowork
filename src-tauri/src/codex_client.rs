//! Codex app-server client: spawns `codex app-server` as a child process and
//! speaks JSON-RPC to it over stdio, so GIA Cowork can act as a thin frontend
//! for the Codex engine (merge plan Option A) while keeping its own UI,
//! sessions and transports.
//!
//! Why a child process instead of a crate dependency: codex-rs is a 136-crate
//! workspace with no crates.io publications, so depending on it means a
//! vendored git graph. Spawning the binary costs one PATH env var and keeps
//! GIA's build untouched. The engine owns sandboxing and approvals; this
//! module owns only framing, request routing and event forwarding.
//!
//! Transport fact (verified first-hand in the codex clone,
//! `codex-rs/app-server-transport/src/transport/stdio.rs`): the app-server
//! stdio transport is NEWLINE-DELIMITED JSON -- one JSON object per line.
//! The server's own reader does `for line in std::io::stdin().lock().lines()`
//! and its writer does `json.push('\n')` before `write_all`. No
//! Content-Length headers, no length prefixes. This module therefore writes
//! one `serde_json::Value` per `\n`-terminated line and parses stdout the
//! same way.
//!
//! Protocol surface used (method names verified in
//! `codex-rs/app-server-protocol/src/protocol/common.rs`: ThreadStart at
//! `"thread/start"`, TurnStart at `"turn/start"`, TurnInterrupt at
//! `"turn/interrupt"`, server requests at lines ~1911-1924):
//! - client -> server: `initialize`, `thread/start`, `turn/start`,
//!   `turn/interrupt`
//! - server -> client requests we must ANSWER (JSON-RPC requires a response
//!   frame or the server waits forever): `item/commandExecution/requestApproval`,
//!   `item/fileChange/requestApproval`, `item/tool/requestUserInput`. These
//!   are surfaced to the webview as `codex://approval-request` events and
//!   answered by `codex_approval_respond`. Any other server request gets a
//!   `-32601` error response so the engine never deadlocks on a method GIA
//!   does not implement (mcpServer/elicitation, item/tool/call, ...).
//! - server -> client notifications are forwarded verbatim as Tauri events
//!   `codex://<method>` (e.g. `codex://item/agentMessage/delta`) so the
//!   frontend subscribes with the standard Tauri wildcard-style listener.
//!
//! Approval decisions sent back are plain `"accept"` / `"decline"` values of
//! `CommandExecutionApprovalDecision` / `FileChangeApprovalDecision`
//! (verified in `codex-rs/app-server-protocol/src/protocol/v2/item.rs`).
//! `item/tool/requestUserInput` does not take a decision enum: its response
//! is an answers map keyed by question id, so an "accept" picks the first
//! declared option of the first question and a "decline" sends an empty map
//! (the tool decides what an unanswered prompt means).
//!
//! Initialize declares the `experimentalApi` + `requiredHumanApproval`
//! capabilities because the app-server README states that only clients
//! declaring them receive the managed human-command approval checkpoints
//! (`codex-rs/app-server/README.md`).

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::oneshot;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Same rationale as terminal.rs: a GUI-subsystem Tauri process spawning a
/// console child makes Windows paint a console window for the whole life of
/// the app-server, which could be the whole life of the app.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How long `codex_thread_start` waits for the `initialize` response before
/// giving up. Generous because the engine may run first-time setup on start.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to wait for the `thread/start` response.
const THREAD_START_TIMEOUT: Duration = Duration::from_secs(30);

const POISONED: &str = "codex client state mutex poisoned";

/// Server -> client methods GIA must answer (the approval/user-input family
/// the TrustGate UI handles). Everything else gets `-32601`.
const APPROVAL_METHODS: [&str; 3] = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
];

fn is_approval_method(method: &str) -> bool {
    APPROVAL_METHODS.contains(&method)
}

// === Managed state ========================================================

/// Tauri-managed state for the codex app-server child.
///
/// The live child lives behind `child`; the shared channels the reader thread
/// needs are held as `Arc`s so the pump can be handed off without keeping the
/// state mutex locked across thread lifetimes.
pub struct CodexClientState {
    child: Mutex<Option<CodexChild>>,
    /// Client request-id counter (JSON-RPC `"id"`). Never reset: ids must not
    /// repeat within a connection, and a stop/start cycle creates a new child
    /// process with its own connection.
    next_request_id: AtomicU64,
    /// Set once the server answers our `initialize` request.
    initialized: Arc<AtomicBool>,
    /// Set when the reader thread sees stdout EOF (engine exited).
    engine_dead: Arc<AtomicBool>,
    /// Client requests awaiting their response, keyed by our numeric id.
    pending_responses: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    /// Server approval requests awaiting the webview's decision, keyed by the
    /// server's request id. The oneshot carries the boolean decision to the
    /// writer task that builds and sends the response frame. Keys double as
    /// the pending list for `codex_status`; the writer task keeps its own
    /// copy of the method/params, so nothing else is stored per request.
    pending_approvals: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    /// Last thread/turn ids harvested from responses and notifications, used
    /// by `codex_interrupt` (which takes no arguments on purpose: interrupting
    /// "the current thing" is the only thing the UI wants).
    thread_id: Arc<Mutex<Option<String>>>,
    turn_id: Arc<Mutex<Option<String>>>,
}

struct CodexChild {
    child: Child,
    /// Shared with the reader thread's writer tasks. Locking is only held for
    /// single `write_all` calls, never across an await.
    stdin: Arc<Mutex<ChildStdin>>,
}

impl Drop for CodexChild {
    fn drop(&mut self) {
        // Don't leave an orphaned codex engine running after GIA closes,
        // mirroring the WhatsApp bridge handle.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Everything the reader thread needs from the managed state.
#[derive(Clone)]
struct SharedPumps {
    initialize_id: u64,
    initialized: Arc<AtomicBool>,
    engine_dead: Arc<AtomicBool>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending_responses: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    pending_approvals: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    thread_id: Arc<Mutex<Option<String>>>,
    turn_id: Arc<Mutex<Option<String>>>,
}

impl Default for CodexClientState {
    fn default() -> Self {
        CodexClientState {
            child: Mutex::new(None),
            next_request_id: AtomicU64::new(0),
            initialized: Arc::new(AtomicBool::new(false)),
            engine_dead: Arc::new(AtomicBool::new(false)),
            pending_responses: Arc::new(Mutex::new(HashMap::new())),
            pending_approvals: Arc::new(Mutex::new(HashMap::new())),
            thread_id: Arc::new(Mutex::new(None)),
            turn_id: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Serialize)]
pub struct CodexStatus {
    pub running: bool,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub pending_approvals: Vec<String>,
}

// === JSON-RPC line framing ================================================
// One JSON object per line, `\n`-terminated (see the transport note at the
// top of this file). All frames produced here therefore end in exactly one
// newline and contain no interior newlines.

/// Build a client -> server request line. The trailing `\n` is part of the
/// frame, so callers can pass the result straight to `send_frame`.
fn jsonrpc_request(id: u64, method: &str, params: Value) -> String {
    let mut frame = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    // Omit `params` entirely when empty: several app-server methods use
    // `deny_unknown_fields`-style strictness and an empty object is always
    // safe to omit.
    if params == json!({}) {
        if let Some(obj) = frame.as_object_mut() {
            obj.remove("params");
        }
    }
    let mut line = frame.to_string();
    line.push('\n');
    line
}

/// Build the result half of a response to a SERVER request.
fn jsonrpc_result_response(id: &Value, result: Value) -> String {
    let mut line = json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string();
    line.push('\n');
    line
}

/// Build an error response to a SERVER request we cannot handle.
fn jsonrpc_error_response(id: &Value, code: i64, message: &str) -> String {
    let mut line =
        json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}).to_string();
    line.push('\n');
    line
}

/// The JSON-RPC id of a server request, usable as a map key. Server ids are
/// strings in practice, but the protocol allows numbers, so both are handled.
fn request_id_key(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// An incoming line, classified the way the reader thread needs it.
/// JSON-RPC 2.0 rules: method + id = server request, method without id =
/// notification, id without method = response to one of ours.
enum Incoming {
    Response {
        id: Value,
        /// The full frame, so callers can distinguish `result` from `error`.
        frame: Value,
    },
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

fn parse_incoming(line: &str) -> Option<Incoming> {
    let v: Value = serde_json::from_str(line).ok()?;
    let method = v.get("method").and_then(Value::as_str);
    let has_id = v.get("id").map(|i| !i.is_null()).unwrap_or(false);
    match (method, has_id) {
        (Some(method), true) => Some(Incoming::ServerRequest {
            id: v["id"].clone(),
            method: method.to_string(),
            params: v.get("params").cloned().unwrap_or(Value::Null),
        }),
        (Some(method), false) => Some(Incoming::Notification {
            method: method.to_string(),
            params: v.get("params").cloned().unwrap_or(Value::Null),
        }),
        (None, true) => Some(Incoming::Response {
            id: v["id"].clone(),
            frame: v,
        }),
        _ => None,
    }
}

/// Walk an object path and return a string leaf, e.g.
/// `dig_str(&frame, &["result", "thread", "id"])`.
fn dig_str<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(key)?;
    }
    current.as_str()
}

/// Build the `config` override map for `thread/start`.
///
/// Verified format: thread-level `config` overrides flow into the same
/// dotted-key mechanism as `-c` CLI overrides
/// (`codex-rs/app-server/src/config_manager.rs` `load_with_overrides` ->
/// `ConfigBuilder::cli_overrides`, and `codex-rs/config/src/overrides.rs`
/// `apply_toml_override` splits each key on `.`). Custom provider entries
/// therefore use `model_providers.<id>.<field>` keys, matching the key-path
/// format the app-server itself writes
/// (`codex-rs/app-server/src/config_manager_service.rs`: `model_providers.{id}.{key}`).
///
/// Built-in providers (openai, ollama, lmstudio, bedrock, gcp) need no entry;
/// a custom provider needs at least `base_url`, which GIA reads from env vars
/// so the Tauri command surface stays minimal.
fn build_config_overrides(
    provider_id: Option<&str>,
    base_url: Option<String>,
    env_key: Option<String>,
) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(id) = provider_id {
        if let Some(url) = base_url {
            out.insert(format!("model_providers.{id}.base_url"), json!(url));
        }
        if let Some(key) = env_key {
            out.insert(format!("model_providers.{id}.env_key"), json!(key));
        }
    }
    out
}

/// The `result` payload for an approval response frame.
///
/// `decision` mapping (verified decision enums in
/// `codex-rs/app-server-protocol/src/protocol/v2/item.rs`):
/// - true  -> `accept` (user approved; the turn continues)
/// - false -> `decline` (user denied; the turn continues without the action).
///   `cancel` would also interrupt the turn, which is not what a boolean
///   "no" means.
fn approval_result(method: &str, params: &Value, decision: bool) -> Value {
    match method {
        "item/tool/requestUserInput" => {
            // Response shape verified in v2/item.rs:
            // `ToolRequestUserInputResponse { answers: HashMap<question_id,
            // ToolRequestUserInputAnswer { answers: Vec<String> }> }`. A
            // boolean cannot express free-text input; "accept" picks the
            // first option of the first question, "decline" answers nothing
            // and lets the tool treat that as an empty response.
            if decision {
                let question = params.pointer("/questions/0");
                let question_id = question
                    .and_then(|q| q.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let option_id = question
                    .and_then(|q| q.get("options"))
                    .and_then(|o| o.get(0))
                    .and_then(|o| o.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                // Built with an explicit Map because the question id is a
                // runtime value, not a literal key.
                let mut answers = Map::new();
                answers.insert(question_id.to_string(), json!({"answers": [option_id]}));
                json!({"answers": answers})
            } else {
                json!({"answers": {}})
            }
        }
        _ => json!({"decision": if decision { "accept" } else { "decline" }}),
    }
}

/// Build a `Command` that never flashes a console window on Windows (same
/// pattern as terminal.rs / whatsapp_bridge.rs: `creation_flags` takes &mut
/// and returns &mut Command, so it is called as a statement).
fn quiet_command(program: &str) -> Command {
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Write one already-framed line to the app-server's stdin.
fn send_frame(stdin: &Arc<Mutex<ChildStdin>>, line: &str) -> Result<(), String> {
    let mut writer = stdin.lock().map_err(|_| POISONED.to_string())?;
    writer
        .write_all(line.as_bytes())
        .and_then(|()| writer.flush())
        .map_err(|e| format!("codex app-server stdin write failed: {e}"))
}

// === State methods ========================================================

impl CodexClientState {
    fn next_id(&self) -> u64 {
        self.next_request_id.fetch_add(1, Ordering::SeqCst)
    }

    fn status(&self) -> CodexStatus {
        let running = self.child.lock().map(|g| g.is_some()).unwrap_or(false)
            && !self.engine_dead.load(Ordering::SeqCst);
        CodexStatus {
            running,
            thread_id: self.thread_id.lock().ok().and_then(|g| g.clone()),
            turn_id: self.turn_id.lock().ok().and_then(|g| g.clone()),
            pending_approvals: self
                .pending_approvals
                .lock()
                .map(|g| g.keys().cloned().collect())
                .unwrap_or_default(),
        }
    }

    /// Spawn the app-server if it is not already running. Idempotent.
    ///
    /// The child lock is held across the spawn on purpose: it makes
    /// start/stop/status race-free without a separate spawn lock, and the
    /// reader thread only ever touches the `Arc` channels, never this mutex.
    fn ensure_running(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let mut guard = self.child.lock().map_err(|_| POISONED.to_string())?;
        if guard.is_some() {
            return Ok(());
        }

        let bin = std::env::var("GIA_CODEX_BIN").map_err(|_| {
            "GIA_CODEX_BIN is not set -- point it at the codex CLI binary that supports \
             `codex app-server` (e.g. the `codex` executable from openai/codex), so GIA \
             can embed the Codex engine"
                .to_string()
        })?;

        let mut child = quiet_command(&bin)
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!("failed to spawn `{bin} app-server` (from GIA_CODEX_BIN): {e}")
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "codex app-server has no stdin".to_string())?;
        let stdin = Arc::new(Mutex::new(stdin));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "codex app-server has no stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "codex app-server has no stderr".to_string())?;

        // Fresh server, fresh handshake. Reset before the reader thread can
        // observe anything.
        self.initialized.store(false, Ordering::SeqCst);
        self.engine_dead.store(false, Ordering::SeqCst);

        let initialize_id = self.next_id();
        let shared = SharedPumps {
            initialize_id,
            initialized: self.initialized.clone(),
            engine_dead: self.engine_dead.clone(),
            stdin: stdin.clone(),
            pending_responses: self.pending_responses.clone(),
            pending_approvals: self.pending_approvals.clone(),
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
        };

        // Drain stderr or the engine blocks once its stderr pipe fills. The
        // engine logs its own diagnostics there; mirror them with a prefix.
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                eprintln!("[codex app-server] {line}");
            }
        });

        // Reader/pump thread: runs until stdout EOF (engine exit or stop).
        let app_for_reader = app.clone();
        std::thread::spawn(move || pump_reader(app_for_reader, stdout, shared));

        // Handshake: the FIRST message on a new connection must be
        // `initialize` (the server answers with its capabilities). The
        // response line is logged by the reader thread.
        let frame = jsonrpc_request(
            initialize_id,
            "initialize",
            json!({
                "clientInfo": {
                    "name": "gia-cowork",
                    "title": "GIA Cowork",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {
                    "experimentalApi": true,
                    "requiredHumanApproval": true,
                },
            }),
        );
        send_frame(&stdin, &frame)?;

        *guard = Some(CodexChild { child, stdin });
        Ok(())
    }

    /// Send a request and await its response frame. The child lock is only
    /// held to clone the stdin handle, never across the await.
    async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let stdin = {
            let guard = self.child.lock().map_err(|_| POISONED.to_string())?;
            guard
                .as_ref()
                .map(|c| c.stdin.clone())
                .ok_or_else(|| "codex app-server is not running -- call codex_start first".to_string())?
        };
        let id = self.next_id();
        let (tx, rx) = oneshot::channel();
        self.pending_responses
            .lock()
            .map_err(|_| POISONED.to_string())?
            .insert(id, tx);
        if let Err(e) = send_frame(&stdin, &jsonrpc_request(id, method, params)) {
            self.pending_responses
                .lock()
                .map_err(|_| POISONED.to_string())?
                .remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(frame)) => match frame.get("error") {
                Some(err) => Err(format!("codex {method} failed: {err}")),
                None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
            },
            // Sender dropped: the reader thread cleared the map (engine
            // exited) without a response ever arriving.
            Ok(Err(_)) => Err(format!(
                "codex app-server dropped the {method} response (engine exited?)"
            )),
            Err(_) => {
                self.pending_responses
                    .lock()
                    .map_err(|_| POISONED.to_string())?
                    .remove(&id);
                Err(format!(
                    "timed out after {timeout:?} waiting for codex {method} response"
                ))
            }
        }
    }

    /// Send a request without waiting for its response; the reader thread
    /// logs whatever comes back. Used for fire-and-forget calls.
    fn fire(&self, method: &str, params: Value) -> Result<(), String> {
        let guard = self.child.lock().map_err(|_| POISONED.to_string())?;
        let stdin = guard
            .as_ref()
            .map(|c| c.stdin.clone())
            .ok_or_else(|| "codex app-server is not running -- call codex_start first".to_string())?;
        let id = self.next_id();
        send_frame(&stdin, &jsonrpc_request(id, method, params))
    }

    fn stop(&self) {
        // Dropping the handle kills (and reaps) the child. The reader thread
        // hits stdout EOF right after and emits `codex://closed`.
        if let Ok(mut guard) = self.child.lock() {
            *guard = None;
        }
        // Drop every pending answer: awaiting webview promises fail cleanly
        // instead of hanging, and the approval writer tasks answer `decline`
        // when their oneshot sender vanishes, so the server never waits on a
        // dead client.
        if let Ok(mut guard) = self.pending_approvals.lock() {
            guard.clear();
        }
        if let Ok(mut guard) = self.pending_responses.lock() {
            guard.clear();
        }
        self.initialized.store(false, Ordering::SeqCst);
        // The turn is gone with the process. The thread id is deliberately
        // kept: durable threads survive restarts and can be resumed later
        // with `thread/resume` (not implemented yet -- noted for follow-up).
        if let Ok(mut guard) = self.turn_id.lock() {
            *guard = None;
        }
    }
}

// === Reader thread ========================================================

fn wait_initialized(flag: &AtomicBool, timeout: Duration) -> bool {
    // Small poll loop instead of a Condvar: the flag only flips once per
    // process start, and this blocks for at most INITIALIZE_TIMEOUT.
    let start = Instant::now();
    while !flag.load(Ordering::SeqCst) {
        if start.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

fn pump_reader(app: tauri::AppHandle, stdout: ChildStdout, shared: SharedPumps) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let Some(incoming) = parse_incoming(line) else {
            eprintln!("[codex] unparsable line from app-server: {line}");
            continue;
        };
        match incoming {
            Incoming::Response { id, frame } => {
                if id.as_u64() == Some(shared.initialize_id) {
                    shared.initialized.store(true, Ordering::SeqCst);
                }
                // Plain nested ifs, not let-chains: this crate is edition
                // 2021 and let-chains only stabilize in edition 2024.
                if let Some(n) = id.as_u64() {
                    if let Ok(mut pending) = shared.pending_responses.lock() {
                        if let Some(tx) = pending.remove(&n) {
                            let _ = tx.send(frame.clone());
                        }
                    }
                }
                // Harvest ids so codex_interrupt can work without arguments.
                if let Ok(mut guard) = shared.thread_id.lock() {
                    if let Some(tid) = dig_str(&frame, &["result", "thread", "id"])
                        .or_else(|| dig_str(&frame, &["result", "threadId"]))
                    {
                        *guard = Some(tid.to_string());
                    }
                }
                if let Ok(mut guard) = shared.turn_id.lock() {
                    if let Some(tid) = dig_str(&frame, &["result", "turn", "id"])
                        .or_else(|| dig_str(&frame, &["result", "turnId"]))
                    {
                        *guard = Some(tid.to_string());
                    }
                }
                // Full response line, as the handshake log of record.
                eprintln!("[codex] response id={id}: {line}");
            }
            Incoming::ServerRequest { id, method, params } => {
                handle_server_request(&app, &shared, id, method, params);
            }
            Incoming::Notification { method, params } => {
                // turn/started carries the live turn id
                // (`TurnStartedNotification { thread_id, turn: Turn }`,
                // verified in v2/turn.rs).
                if method.starts_with("turn/") {
                    if let Ok(mut guard) = shared.turn_id.lock() {
                        if let Some(tid) = dig_str(&params, &["turn", "id"])
                            .or_else(|| dig_str(&params, &["turnId"]))
                        {
                            *guard = Some(tid.to_string());
                        }
                    }
                }
                // Forward verbatim; the webview subscribes to codex://<method>.
                let _ = app.emit(&format!("codex://{method}"), &params);
            }
        }
    }
    shared.engine_dead.store(true, Ordering::SeqCst);
    let _ = app.emit("codex://closed", json!({"reason": "app-server stdout closed"}));
}

fn handle_server_request(
    app: &tauri::AppHandle,
    shared: &SharedPumps,
    id: Value,
    method: String,
    params: Value,
) {
    if is_approval_method(&method) {
        let key = request_id_key(&id);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut pending) = shared.pending_approvals.lock() {
            pending.insert(key, tx);
        }
        // Full server request as the event payload, so the TrustGate UI sees
        // the id it must echo back plus whatever the card needs to display
        // (command text, cwd, reason, questions, ...).
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id.clone(),
            "method": method.clone(),
            "params": params.clone(),
        });
        let _ = app.emit("codex://approval-request", &payload);

        // The writer task turns the webview's boolean into the response
        // frame. It is spawned now (not at respond time) so the oneshot is
        // the ONLY handoff: `codex_approval_respond` just sends the decision.
        let app = app.clone();
        let stdin = shared.stdin.clone();
        tauri::async_runtime::spawn(async move {
            // If the sender is dropped without a decision (codex_stop cleared
            // the map, engine died), answer `decline`: leaving the server
            // waiting on an approval nobody can give wedges the turn forever.
            let decision = rx.await.unwrap_or(false);
            let frame = jsonrpc_result_response(&id, approval_result(&method, &params, decision));
            if let Err(e) = send_frame(&stdin, &frame) {
                eprintln!("[codex] failed to send approval response for {method}: {e}");
            }
            let _ = app.emit(
                "codex://approval-resolved",
                json!({"requestId": request_id_key(&id), "decision": decision}),
            );
        });
    } else {
        // Unhandled server request (mcpServer/elicitation, item/tool/call,
        // token refresh, ...). JSON-RPC demands a response: an error beats a
        // wedged server, and the log says exactly what GIA ignored.
        let frame = jsonrpc_error_response(
            &id,
            -32601,
            &format!("method not handled by GIA cowork: {method}"),
        );
        if let Err(e) = send_frame(&shared.stdin, &frame) {
            eprintln!("[codex] failed to answer server request {method}: {e}");
        }
        eprintln!("[codex] ignored server request {method} (answered -32601)");
    }
}

// === Tauri commands =======================================================

/// Spawn the codex app-server (or report the running one).
#[tauri::command]
pub fn codex_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, CodexClientState>,
) -> Result<CodexStatus, String> {
    state.ensure_running(&app)?;
    Ok(state.status())
}

/// Kill the app-server and clear all pending approvals/responses.
#[tauri::command]
pub fn codex_stop(state: tauri::State<'_, CodexClientState>) -> Result<(), String> {
    state.stop();
    Ok(())
}

/// Liveness + what is currently pending.
#[tauri::command]
pub fn codex_status(state: tauri::State<'_, CodexClientState>) -> Result<CodexStatus, String> {
    Ok(state.status())
}

/// Start a fresh codex thread and immediately run one turn with `prompt`.
///
/// Composes `thread/start` (waits for the response to harvest the thread id)
/// + `turn/start` (fire-and-forget; turn progress arrives as
/// `codex://turn/*` and `codex://item/*` notifications). Returns the thread
/// id, which the frontend can use for later `turn/steer` / resume flows.
///
/// `model_provider` is the provider id (built-ins like `ollama`, or a custom
/// id configured through `GIA_CODEX_PROVIDER_BASE_URL` /
/// `GIA_CODEX_PROVIDER_ENV_KEY`, which this turns into
/// `model_providers.<id>.base_url` / `.env_key` dotted-key config overrides).
#[tauri::command]
pub async fn codex_thread_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, CodexClientState>,
    model: Option<String>,
    model_provider: Option<String>,
    prompt: String,
) -> Result<String, String> {
    state.ensure_running(&app)?;
    if !wait_initialized(&state.initialized, INITIALIZE_TIMEOUT) {
        return Err(
            "codex app-server did not answer initialize in time -- check GIA_CODEX_BIN \
             points at a working codex CLI (stderr has the engine's own logs)"
                .to_string(),
        );
    }

    let mut params = json!({});
    if let Some(model) = &model {
        params["model"] = json!(model);
    }
    if let Some(provider) = &model_provider {
        params["modelProvider"] = json!(provider);
    }
    let overrides = build_config_overrides(
        model_provider.as_deref(),
        std::env::var("GIA_CODEX_PROVIDER_BASE_URL").ok(),
        std::env::var("GIA_CODEX_PROVIDER_ENV_KEY").ok(),
    );
    if !overrides.is_empty() {
        params["config"] = Value::Object(overrides);
    }

    let result = state
        .call("thread/start", params, THREAD_START_TIMEOUT)
        .await?;
    let thread_id = dig_str(&result, &["thread", "id"])
        .or_else(|| dig_str(&result, &["threadId"]))
        .ok_or_else(|| format!("thread/start response missing thread id: {result}"))?
        .to_string();
    if let Ok(mut guard) = state.thread_id.lock() {
        *guard = Some(thread_id.clone());
    }

    // Fire-and-forget on purpose: a turn runs for minutes, and its lifecycle
    // arrives as notifications, not as this response.
    state.fire(
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [{"type": "text", "text": prompt}],
        }),
    )?;
    Ok(thread_id)
}

/// Answer a pending approval request the webview received via
/// `codex://approval-request`. `decision` true = accept, false = decline.
#[tauri::command]
pub fn codex_approval_respond(
    state: tauri::State<'_, CodexClientState>,
    request_id: String,
    decision: bool,
) -> Result<(), String> {
    let tx = state
        .pending_approvals
        .lock()
        .map_err(|_| POISONED.to_string())?
        .remove(&request_id)
        .ok_or_else(|| format!("no pending codex approval with id {request_id:?}"))?;
    // The reader thread's writer task builds and sends the JSON-RPC response
    // frame from this decision.
    tx.send(decision)
        .map_err(|_| "codex engine exited before the approval could be answered".to_string())
}

/// Interrupt the current turn (last seen via turn/start / turn/started).
#[tauri::command]
pub fn codex_interrupt(state: tauri::State<'_, CodexClientState>) -> Result<(), String> {
    let thread_id = state
        .thread_id
        .lock()
        .map_err(|_| POISONED.to_string())?
        .clone()
        .ok_or_else(|| "no active codex thread".to_string())?;
    let turn_id = state
        .turn_id
        .lock()
        .map_err(|_| POISONED.to_string())?
        .clone()
        .ok_or_else(|| "no active codex turn to interrupt".to_string())?;
    // TurnInterruptParams { thread_id, turn_id } -- verified in v2/turn.rs.
    state.fire("turn/interrupt", json!({"threadId": thread_id, "turnId": turn_id}))
}

// === Tests ================================================================
// Everything testable without the codex binary: id sequencing, line framing,
// frame classification, approval response construction, config overrides.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_sequence_without_repeats() {
        let state = CodexClientState::default();
        let first = state.next_id();
        let second = state.next_id();
        assert_eq!(first, 0);
        assert_eq!(second, 1);
    }

    #[test]
    fn jsonrpc_request_is_a_single_newline_terminated_line() {
        let line = jsonrpc_request(7, "thread/start", json!({"model": "gpt-5.1"}));
        assert!(line.ends_with('\n'), "frame must end with a newline");
        assert_eq!(line.matches('\n').count(), 1, "one object per line");
        let frame: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(frame["jsonrpc"], "2.0");
        assert_eq!(frame["id"], 7);
        assert_eq!(frame["method"], "thread/start");
        assert_eq!(frame["params"]["model"], "gpt-5.1");
    }

    #[test]
    fn jsonrpc_request_omits_empty_params() {
        let line = jsonrpc_request(1, "turn/interrupt", json!({}));
        let frame: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert!(frame.get("params").is_none());
    }

    #[test]
    fn jsonrpc_result_response_carries_id_and_result() {
        let line = jsonrpc_result_response(&json!("abc"), json!({"decision": "accept"}));
        assert!(line.ends_with('\n'));
        let frame: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(frame["jsonrpc"], "2.0");
        assert_eq!(frame["id"], "abc");
        assert_eq!(frame["result"]["decision"], "accept");
        assert!(frame.get("error").is_none());
    }

    #[test]
    fn jsonrpc_error_response_shape() {
        let line = jsonrpc_error_response(&json!(42), -32601, "nope");
        let frame: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(frame["id"], 42);
        assert_eq!(frame["error"]["code"], -32601);
        assert_eq!(frame["error"]["message"], "nope");
        assert!(frame.get("result").is_none());
    }

    #[test]
    fn parse_incoming_classifies_frames() {
        // Server request: method + id.
        let incoming = parse_incoming(
            r#"{"jsonrpc":"2.0","id":"9","method":"item/commandExecution/requestApproval","params":{"threadId":"t1"}}"#,
        )
        .unwrap();
        match incoming {
            Incoming::ServerRequest { id, method, params } => {
                assert_eq!(id, json!("9"));
                assert_eq!(method, "item/commandExecution/requestApproval");
                assert_eq!(params["threadId"], "t1");
            }
            _ => panic!("expected ServerRequest"),
        }

        // Notification: method, no id.
        let incoming = parse_incoming(
            r#"{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"text":"hi"}}"#,
        )
        .unwrap();
        match incoming {
            Incoming::Notification { method, params } => {
                assert_eq!(method, "item/agentMessage/delta");
                assert_eq!(params["text"], "hi");
            }
            _ => panic!("expected Notification"),
        }

        // Response: id, no method.
        let incoming =
            parse_incoming(r#"{"jsonrpc":"2.0","id":3,"result":{"thread":{"id":"th1"}}}"#).unwrap();
        match incoming {
            Incoming::Response { id, frame } => {
                assert_eq!(id, json!(3));
                assert_eq!(frame["result"]["thread"]["id"], "th1");
            }
            _ => panic!("expected Response"),
        }

        // A null id does not count as a response id (JSON-RPC forbids it).
        assert!(parse_incoming(r#"{"jsonrpc":"2.0","id":null,"result":{}}"#).is_none());
        // Garbage is dropped, not fatal.
        assert!(parse_incoming("not json at all").is_none());
    }

    #[test]
    fn request_id_key_accepts_strings_and_numbers() {
        assert_eq!(request_id_key(&json!("req-9")), "req-9");
        assert_eq!(request_id_key(&json!(12)), "12");
    }

    #[test]
    fn approval_methods_are_exactly_the_documented_set() {
        for method in APPROVAL_METHODS {
            assert!(is_approval_method(method));
        }
        assert!(!is_approval_method("mcpServer/elicitation/request"));
        assert!(!is_approval_method("item/tool/call"));
        assert!(!is_approval_method("turn/started"));
    }

    #[test]
    fn approval_result_maps_bool_to_accept_decline() {
        let empty = json!({});
        let accept = approval_result("item/commandExecution/requestApproval", &empty, true);
        assert_eq!(accept["decision"], "accept");
        let decline = approval_result("item/fileChange/requestApproval", &empty, false);
        assert_eq!(decline["decision"], "decline");
    }

    #[test]
    fn approval_result_for_user_input_uses_answers_map() {
        let params = json!({
            "questions": [
                {"id": "q1", "header": "H", "question": "?",
                 "options": [{"id": "opt-a", "label": "A"}, {"id": "opt-b", "label": "B"}]}
            ]
        });
        let accept = approval_result("item/tool/requestUserInput", &params, true);
        assert_eq!(accept["answers"]["q1"]["answers"], json!(["opt-a"]));
        let decline = approval_result("item/tool/requestUserInput", &params, false);
        assert_eq!(decline["answers"], json!({}));
    }

    #[test]
    fn approval_response_frame_is_a_complete_jsonrpc_response() {
        let params = json!({});
        let line = jsonrpc_result_response(
            &json!("approval-77"),
            approval_result("item/commandExecution/requestApproval", &params, true),
        );
        assert!(line.ends_with('\n'));
        let frame: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(frame["id"], "approval-77");
        assert_eq!(frame["result"]["decision"], "accept");
    }

    #[test]
    fn build_config_overrides_uses_dotted_provider_paths() {
        let overrides = build_config_overrides(
            Some("custom-llm"),
            Some("http://127.0.0.1:11434/v1".to_string()),
            Some("CUSTOM_LLM_API_KEY".to_string()),
        );
        assert_eq!(
            overrides.get("model_providers.custom-llm.base_url"),
            Some(&json!("http://127.0.0.1:11434/v1"))
        );
        assert_eq!(
            overrides.get("model_providers.custom-llm.env_key"),
            Some(&json!("CUSTOM_LLM_API_KEY"))
        );
        // No provider -> no overrides, so `config` is omitted from the frame.
        assert!(build_config_overrides(None, Some("x".into()), Some("y".into())).is_empty());
        // Provider without credentials still produces no empty entries.
        assert!(build_config_overrides(Some("ollama"), None, None).is_empty());
    }

    #[test]
    fn dig_str_harvests_thread_and_turn_ids() {
        let thread_response = json!({"result": {"thread": {"id": "th-42"}}});
        assert_eq!(
            dig_str(&thread_response, &["result", "thread", "id"]),
            Some("th-42")
        );
        let flat_response = json!({"result": {"threadId": "th-43"}});
        assert_eq!(dig_str(&flat_response, &["result", "threadId"]), Some("th-43"));
        let turn_notification = json!({"threadId": "th-42", "turn": {"id": "turn-7"}});
        assert_eq!(dig_str(&turn_notification, &["turn", "id"]), Some("turn-7"));
        assert_eq!(dig_str(&thread_response, &["result", "turn", "id"]), None);
    }
}
