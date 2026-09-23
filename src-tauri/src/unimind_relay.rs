//! Embedded Unimind relay — the cross-device wire baked into the desktop app.
//!
//! A Rust port of `relay/index.js` so a native GIA Cowork install can run the
//! Unimind relay with NO Node.js dependency. The Tauri app auto-starts it on
//! boot (see `lib.rs` setup), so pairing a phone is just "open GIA on the
//! phone, point Unimind at this machine's LAN URL, paste the pairing id".
//!
//! It is a router, not a database: it stores nothing and buffers nothing, and
//! it only routes between connections that register the same `unimindId`.
//!
//! Wire protocol (JSON text frames — identical to `relay/index.js`):
//!   C->R  { "type": "hello", "identity": { unimindId, device, deviceId }, "name": "..." }
//!   R->C  { "type": "welcome", "peerCount", "peers": [ { device, deviceId, name, connectedAt } ] }
//!   R->C  { "type": "peers", "peers": [...] }              // on peer-set changes
//!   C->R  { "type": "message", "message": <UnimindMessage>, "targetDevice"? }
//!   R->C  { "type": "message", "message": <UnimindMessage> }  // forwarded to room peers
//!   C->R  { "type": "ping" }  ->  R->C  { "type": "pong", "t": <epoch ms> }
//!
//! Plain HTTP `GET /` returns "unimind-relay up" (health check, as in JS).
//!
//! Environment overrides:
//!   UNIMIND_RELAY_PORT   (default 8787)
//!   UNIMIND_RELAY_SECRET  required when LAN mode is enabled
//!   UNIMIND_RELAY_LAN    set to "1" to expose the relay beyond localhost

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, WebSocketStream};

const MAX_CONNECTIONS: usize = 64;
const MAX_FRAME_BYTES: usize = 1024 * 1024;
/// A connection that sends nothing for this long is a zombie (dead phone,
/// dropped network) — close it so the room stays clean.
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(45);

static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug)]
struct Identity {
    unimind_id: String,
    device: String,
    device_id: String,
}

#[derive(Clone)]
struct ConnMeta {
    id: u64,
    addr: SocketAddr,
    identity: Option<Identity>,
    name: String,
    connected_at: u64,
    /// Room the connection currently belongs to (its unimindId after hello).
    room: Option<String>,
}

struct RelayShared {
    rooms: Mutex<HashMap<String, HashSet<u64>>>,
    clients: Mutex<HashMap<u64, ConnMeta>>,
    sinks: Mutex<HashMap<u64, mpsc::Sender<Message>>>,
    live: AtomicU64,
    next_id: AtomicU64,
    secret: String,
}

impl Default for RelayShared {
    fn default() -> Self {
        Self {
            rooms: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            sinks: Mutex::new(HashMap::new()),
            live: AtomicU64::new(0),
            next_id: AtomicU64::new(1),
            secret: String::new(),
        }
    }
}

type RelayState = Arc<RelayShared>;

pub fn relay_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

pub fn relay_port() -> u16 {
    std::env::var("UNIMIND_RELAY_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787)
}

fn lan_enabled() -> bool {
    matches!(
        std::env::var("UNIMIND_RELAY_LAN").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

pub fn relay_lan_enabled() -> bool {
    lan_enabled()
}

/// Best-effort primary LAN IPv4 (via the classic UDP "connect" trick — no
/// packets are ever sent). Used to build the URL a phone on the same Wi-Fi
/// should use to reach this machine's embedded relay.
pub fn local_lan_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket
        .local_addr()
        .ok()
        .map(|a| a.ip().to_string())
        .filter(|ip| !ip.starts_with("127.") && !ip.starts_with("0.") && !ip.is_empty())
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Run the relay for the rest of the process lifetime. Safe to call on any
/// platform; if the port can't be bound it logs and returns immediately, so
/// the app still boots. Call via `tauri::async_runtime::spawn`.
pub async fn run_relay() {
    let port = relay_port();
    let host = if lan_enabled() { "0.0.0.0" } else { "127.0.0.1" };
    let secret = std::env::var("UNIMIND_RELAY_SECRET").unwrap_or_default();
    if lan_enabled() && secret.trim().len() < 32 {
        eprintln!("[unimind-relay] refusing LAN mode: UNIMIND_RELAY_SECRET must be at least 32 characters");
        return;
    }
    let listener = match TcpListener::bind((host, port)).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("[unimind-relay] could not bind {host}:{port} — {e}. Pairing unavailable.");
            return;
        }
    };

    let state: RelayState = Arc::new(RelayShared {
        secret,
        ..RelayShared::default()
    });
    RUNNING.store(true, Ordering::SeqCst);
    eprintln!(
        "[unimind-relay] listening on {host}:{port} (ws://<host>:{port}/unimind){}",
        if state.secret.is_empty() { " — local-only" } else { " — shared secret required" }
    );

    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                if state.live.load(Ordering::Relaxed) as usize >= MAX_CONNECTIONS {
                    drop(stream);
                    continue;
                }
                state.live.fetch_add(1, Ordering::Relaxed);
                let state = state.clone();
                tokio::spawn(async move {
                    handle_conn(state.clone(), stream, addr).await;
                    state.live.fetch_sub(1, Ordering::Relaxed);
                });
            }
            Err(_) => continue,
        }
    }
}

async fn handle_conn(state: RelayState, stream: TcpStream, addr: SocketAddr) {
    // Peek the request head (does not consume) to route: any path other than
    // /unimind is treated as a plain-HTTP health check.
    let mut peek = [0u8; 2048];
    let head = match stream.peek(&mut peek).await {
        Ok(n) => String::from_utf8_lossy(&peek[..n]).to_string(),
        Err(_) => return,
    };
    let path = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");

    if path != "/unimind" {
        let payload = b"unimind-relay up\n";
        let mut socket = stream;
        let header = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            payload.len()
        );
        let _ = socket.write_all(header.as_bytes()).await;
        let _ = socket.write_all(payload).await;
        let _ = socket.shutdown().await;
        return;
    }

    let ws = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[unimind-relay] handshake from {addr} failed: {e}");
            return;
        }
    };

    run_client(state, ws, addr).await;
}

async fn run_client(state: RelayState, ws: WebSocketStream<TcpStream>, addr: SocketAddr) {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = ws.split();
    let (sender, mut inbox) = mpsc::channel::<Message>(64);

    state.clients.lock().await.insert(
        id,
        ConnMeta {
            id,
            addr,
            identity: None,
            name: String::new(),
            connected_at: epoch_ms(),
            room: None,
        },
    );
    state.sinks.lock().await.insert(id, sender);

    // Forwarder: drains the outbox channel into the websocket sink. It ends
    // when the channel closes (i.e. when this connection is cleaned up).
    let forwarder = tokio::spawn(async move {
        while let Some(message) = inbox.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    loop {
        tokio::select! {
            frame = stream.next() => {
                match frame {
                    None => break,
                    Some(Err(_)) => break,
                    Some(Ok(Message::Text(text))) => {
                        let text = text.to_string();
                        if text.len() > MAX_FRAME_BYTES {
                            eprintln!("[unimind-relay] conn {id} sent an oversized frame");
                            break;
                        }
                        if let Err(e) = handle_frame(state.clone(), id, &text).await {
                            eprintln!("[unimind-relay] conn {id} closed: {e}");
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let message = Message::Pong(payload);
                        send_to_id(&state, id, message).await;
                    }
                    Some(Ok(_)) => { /* ignore binary / close / pong frames */ }
                }
            }
            _ = tokio::time::sleep(CONNECTION_TIMEOUT) => {
                // Silence resets the timer every frame, so this fires only for
                // connections that produced nothing for a full window.
                break;
            }
        }
    }

    // Cleanup: drop the connection from its room, then from the registries.
    remove_from_room(&state, id).await;
    state.sinks.lock().await.remove(&id);
    state.clients.lock().await.remove(&id);
    forwarder.abort();
}

async fn handle_frame(state: RelayState, id: u64, text: &str) -> Result<(), String> {
    let msg: Value = serde_json::from_str(text).map_err(|e| format!("bad frame: {e}"))?;
    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match msg_type {
        "hello" => {
            let identity = &msg["identity"];
            let unimind_id = identity
                .get("unimindId")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().take(128).collect::<String>());
            let Some(unimind_id) = unimind_id else {
                return Err("missing unimindId".to_string());
            };
            if !state.secret.is_empty() && msg.get("secret").and_then(|v| v.as_str()) != Some(state.secret.as_str()) {
                return Err("bad secret".to_string());
            }
            let device = identity
                .get("device")
                .and_then(|v| v.as_str())
                .map(|d| if d == "mobile" { "mobile" } else { "desktop" })
                .unwrap_or("desktop")
                .to_string();
            let device_id = identity
                .get("deviceId")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().take(128).collect::<String>())
                .unwrap_or_else(|| "unknown".to_string());
            let name = msg
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().take(64).collect::<String>())
                .unwrap_or_default();

            // Move this connection out of any previous room (re-hello), then
            // stamp its identity. Locks are taken one at a time, never nested.
            remove_from_room(&state, id).await;
            {
                let mut clients = state.clients.lock().await;
                if let Some(meta) = clients.get_mut(&id) {
                    meta.identity = Some(Identity {
                        unimind_id: unimind_id.clone(),
                        device,
                        device_id,
                    });
                    meta.name = name;
                    meta.connected_at = epoch_ms();
                    meta.room = Some(unimind_id.clone());
                }
            }

            // Join (or create) the room and answer with the current peer set.
            let ids: Vec<u64> = {
                let mut rooms = state.rooms.lock().await;
                let room = rooms.entry(unimind_id.clone()).or_default();
                room.insert(id);
                room.iter().copied().collect()
            };
            let peers = peer_list(&state, &ids).await;
            let welcome = json!({ "type": "welcome", "peerCount": ids.len(), "peers": peers });
            send_to_id(&state, id, Message::text(welcome.to_string())).await;
            broadcast_peers(&state, &unimind_id).await;
        }
        "message" => {
            // Route only inside the SENDER's room (as relay/index.js does).
            let room_name = match room_of(&state, id).await {
                Some(room) => room,
                None => return Ok(()), // not registered yet — drop
            };
            let enveloped_device_id = msg["message"]["envelope"]
                .get("deviceId")
                .and_then(|v| v.as_str());
            let target_device = msg.get("targetDevice").and_then(|v| v.as_str());

            let recipients: Vec<u64> = {
                let rooms = state.rooms.lock().await;
                let ids: Vec<u64> = rooms
                    .get(&room_name)
                    .map(|room| room.iter().copied().collect())
                    .unwrap_or_default();
                drop(rooms);
                let clients = state.clients.lock().await;
                ids.into_iter()
                    .filter(|peer_id| {
                        if *peer_id == id {
                            return false; // never echo back to the sender
                        }
                        let Some(meta) = clients.get(peer_id) else { return false; };
                        let Some(their_id) = meta.identity.as_ref() else { return false; };
                        if let Some(target) = target_device {
                            if their_id.device_id != target {
                                return false;
                            }
                        }
                        if let Some(env_id) = enveloped_device_id {
                            if env_id == their_id.device_id {
                                return false; // don't loop back to the origin
                            }
                        }
                        true
                    })
                    .collect()
            };
            broadcast_to(&state, &recipients, Message::text(text.to_string())).await;
        }
        "ping" => {
            send_to_id(&state, id, Message::text(json!({ "type": "pong", "t": epoch_ms() }).to_string()))
                .await;
        }
        _ => { /* ignore unknown frame types */ }
    }
    Ok(())
}

// ── Broadcast helpers ─────────────────────────────────────────────────

/// Gather the JSON peer descriptors for a set of connection ids.
async fn peer_list(state: &RelayState, ids: &[u64]) -> Vec<Value> {
    let clients = state.clients.lock().await;
    ids.iter()
        .filter_map(|id| clients.get(id))
        .filter(|meta| meta.identity.is_some())
        .map(peer_json)
        .collect()
}

fn peer_json(meta: &ConnMeta) -> Value {
    let identity = meta.identity.as_ref().expect("identity is set");
    json!({
        "device": identity.device,
        "deviceId": identity.device_id,
        "name": meta.name,
        "connectedAt": meta.connected_at,
    })
}

/// Send a frame to one connection via its outbox (drops when full — slow
/// clients should not stall the relay).
async fn send_to_id(state: &RelayState, id: u64, message: Message) {
    if let Some(tx) = state.sinks.lock().await.get(&id) {
        let _ = tx.clone().try_send(message);
    }
}

/// Send a frame to a list of connection ids.
async fn broadcast_to(state: &RelayState, ids: &[u64], message: Message) {
    let sinks = state.sinks.lock().await;
    for id in ids {
        if let Some(tx) = sinks.get(id) {
            let _ = tx.clone().try_send(message.clone());
        }
    }
}

/// Distribute a fresh peer list to everyone in a room (peer-set changed).
async fn broadcast_peers(state: &RelayState, unimind_id: &str) {
    let ids: Vec<u64> = {
        let rooms = state.rooms.lock().await;
        rooms
            .get(unimind_id)
            .map(|room| room.iter().copied().collect())
            .unwrap_or_default()
    };
    let peers = peer_list(state, &ids).await;
    let frame = Message::text(json!({ "type": "peers", "peers": peers }).to_string());
    broadcast_to(state, &ids, frame).await;
}

async fn room_of(state: &RelayState, id: u64) -> Option<String> {
    state.clients.lock().await.get(&id).and_then(|meta| meta.room.clone())
}

/// Take a connection out of its current room and tell the room about it.
async fn remove_from_room(state: &RelayState, id: u64) {
    let room_name = room_of(state, id).await;
    let Some(room_name) = room_name else { return };
    let (room_empty, was_registered) = {
        let mut rooms = state.rooms.lock().await;
        let removed = match rooms.get_mut(&room_name) {
            Some(room) => {
                let removed = room.remove(&id);
                if room.is_empty() {
                    rooms.remove(&room_name);
                }
                removed
            }
            None => false,
        };
        let empty = !rooms.contains_key(&room_name);
        (empty, removed)
    };
    {
        let mut clients = state.clients.lock().await;
        if let Some(meta) = clients.get_mut(&id) {
            meta.room = None;
        }
    }
    if was_registered && !room_empty {
        broadcast_peers(state, &room_name).await;
    }
}