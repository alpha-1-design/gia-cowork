//! Supervises the Node.js WhatsApp bridge sidecar (see
//! src-tauri/sidecars/whatsapp-bridge) and proxies commands to it over its
//! localhost HTTP control API.
//!
//! Rust doesn't hold the WhatsApp connection itself -- Baileys (the
//! unofficial WhatsApp Web client library this depends on) is a Node.js
//! library with no mature Rust equivalent, so the actual session lives in
//! a child process. This module's job is just: start it, generate a
//! shared secret so nothing else on the machine can call it, keep the
//! child handle around so it dies when GIA Cowork does, and forward
//! requests.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const BRIDGE_PORT: u16 = 8765;

pub struct WhatsAppBridgeState(pub Mutex<Option<BridgeHandle>>);

pub struct BridgeHandle {
    child: Child,
    token: String,
}

impl Default for WhatsAppBridgeState {
    fn default() -> Self {
        WhatsAppBridgeState(Mutex::new(None))
    }
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        // Don't leave an orphaned WhatsApp session process running after
        // the app closes -- kill it along with GIA Cowork.
        let _ = self.child.kill();
    }
}

fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}{:x}", nanos, std::process::id())
}

#[derive(Serialize)]
pub struct BridgeStartResult {
    pub started: bool,
    pub already_running: bool,
}

#[tauri::command]
pub fn whatsapp_bridge_start(
    state: tauri::State<'_, WhatsAppBridgeState>,
    app_handle: tauri::AppHandle,
) -> Result<BridgeStartResult, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(BridgeStartResult { started: false, already_running: true });
    }

    let sidecar_dir = app_handle
        .path()
        .resolve("sidecars/whatsapp-bridge", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("could not resolve sidecar path: {e}"))?;

    let token = random_token();
    let mut child = Command::new("node")
        .arg("src/server.js")
        .current_dir(&sidecar_dir)
        .env("GIA_WA_BRIDGE_PORT", BRIDGE_PORT.to_string())
        .env("GIA_WA_BRIDGE_TOKEN", &token)
        .env("GIA_WA_AUTH_DIR", sidecar_dir.join("auth"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!(
            "Failed to start WhatsApp bridge: {e}. Make sure Node.js is installed and `npm install` was run in src-tauri/sidecars/whatsapp-bridge."
        ))?;

    // Push channel: the sidecar writes `[gia-event] {json}` lines to its
    // stdout whenever something happens (incoming message, connection
    // state change). Read that stream here and re-emit each event to the
    // frontend as `whatsapp://<type>`. This is what makes two-way
    // WhatsApp event-driven -- the UI never polls, so there's no battery
    // or CPU cost when idle. The thread ends when the child exits (pipe
    // closes).
    if let Some(stdout) = child.stdout.take() {
        let app = app_handle.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let Some(json) = line.strip_prefix("[gia-event] ") else { continue };
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(json) {
                    let event_type = payload
                        .get("type")
                        .and_then(|t| t.as_str())
                        .unwrap_or("event");
                    let _ = app.emit(&format!("whatsapp://{event_type}"), &payload);
                }
            }
        });
    }

    *guard = Some(BridgeHandle { child, token });
    Ok(BridgeStartResult { started: true, already_running: false })
}

#[tauri::command]
pub fn whatsapp_bridge_stop(state: tauri::State<'_, WhatsAppBridgeState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None; // Drop kills the child process.
    Ok(())
}

#[derive(Deserialize)]
pub struct NotifyArgs {
    pub to: String,
    pub text: String,
    #[serde(rename = "escalateAfterMs")]
    pub escalate_after_ms: Option<u64>,
    #[serde(rename = "escalateAudioPath")]
    pub escalate_audio_path: Option<String>,
}

fn bridge_token(state: &tauri::State<'_, WhatsAppBridgeState>) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    guard
        .as_ref()
        .map(|h| h.token.clone())
        .ok_or_else(|| "WhatsApp bridge is not running -- call whatsapp_bridge_start first".to_string())
}

/// Text now, real WhatsApp call if unread after `escalateAfterMs` -- the
/// "call and text, calls if I don't reply in time" behavior. Requires
/// escalateAudioPath to be a pre-synthesized TTS clip of the message
/// (GIA Cowork's TTS pipeline generates this before calling this command).
#[tauri::command]
pub async fn whatsapp_notify(
    state: tauri::State<'_, WhatsAppBridgeState>,
    args: NotifyArgs,
) -> Result<serde_json::Value, String> {
    let token = bridge_token(&state)?;
    let client = reqwest_blocking_json(
        "POST",
        &format!("http://127.0.0.1:{BRIDGE_PORT}/notify"),
        &token,
        serde_json::json!({
            "to": args.to,
            "text": args.text,
            "escalateAfterMs": args.escalate_after_ms,
            "escalateAudioPath": args.escalate_audio_path,
        }),
    )?;
    Ok(client)
}

#[tauri::command]
pub async fn whatsapp_status(state: tauri::State<'_, WhatsAppBridgeState>) -> Result<serde_json::Value, String> {
    let token = bridge_token(&state)?;
    reqwest_blocking_get(&format!("http://127.0.0.1:{BRIDGE_PORT}/status"), &token)
}

/// Fetch known contact names (jid -> display name) so the frontend can
/// label chats.
#[tauri::command]
pub async fn whatsapp_contacts(
    state: tauri::State<'_, WhatsAppBridgeState>,
) -> Result<serde_json::Value, String> {
    let token = bridge_token(&state)?;
    reqwest_blocking_get(&format!("http://127.0.0.1:{BRIDGE_PORT}/contacts"), &token)
}

/// Fetch incoming (person -> GIA) WhatsApp messages newer than `since`
/// (epoch ms). Used once on startup to catch up on anything that arrived
/// while the app was closed; live delivery is via the `whatsapp://incoming`
/// push events, not polling.
#[tauri::command]
pub async fn whatsapp_messages(
    state: tauri::State<'_, WhatsAppBridgeState>,
    since: Option<u64>,
) -> Result<serde_json::Value, String> {
    let token = bridge_token(&state)?;
    reqwest_blocking_get(
        &format!(
            "http://127.0.0.1:{BRIDGE_PORT}/messages?since={}",
            since.unwrap_or(0)
        ),
        &token,
    )
}

// Minimal blocking HTTP helpers using std -- avoids pulling in a full
// async HTTP client dependency just for a handful of localhost calls to
// the sidecar. Fine here since these are local loopback requests.
fn reqwest_blocking_json(
    method: &str,
    url: &str,
    token: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    ureq_like_request(method, url, token, Some(body))
}

fn reqwest_blocking_get(url: &str, token: &str) -> Result<serde_json::Value, String> {
    ureq_like_request("GET", url, token, None)
}

fn ureq_like_request(
    method: &str,
    url: &str,
    token: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let agent = ureq::AgentBuilder::new().build();
    let mut req = match method {
        "GET" => agent.get(url),
        "POST" => agent.post(url),
        _ => return Err(format!("unsupported method {method}")),
    };
    req = req.set("X-GIA-Token", token);
    let resp = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match resp {
        Ok(r) => r.into_json::<serde_json::Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(_, r)) => {
            let text = r.into_string().unwrap_or_default();
            Err(format!("bridge returned an error: {text}"))
        }
        Err(e) => Err(format!("could not reach WhatsApp bridge sidecar: {e}")),
    }
}
