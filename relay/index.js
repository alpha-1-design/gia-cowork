/**
 * Unimind relay — the wire between GIA devices.
 *
 * GIA Cowork (desktop) and GIA (mobile) speak the same UnimindMessage
 * protocol (src/unimind/types.ts). This tiny server just connects the
 * dots: any two connections that share a `unimindId` can exchange
 * messages through it. It stores nothing, buffers nothing — it's a
 * router, not a database, so it can run on the desktop itself, a $5 VPS,
 * or anywhere else that's reachable by both devices.
 *
 * Wire protocol (all JSON text frames):
 *   C->R  { "type": "hello", "identity": { unimindId, device, deviceId }, "name": "..." }
 *   R->C  { "type": "welcome", "peerCount", "peers": [ { device, deviceId, name, connectedAt } ] }
 *   R->C  { "type": "peers", "peers": [...] }            // whenever the peer set changes
 *   C->R  { "type": "message", "message": <UnimindMessage> }
 *   R->C  { "type": "message", "message": <UnimindMessage> }  // forwarded to peers of same unimindId
 *
 * Run:  npm install && npm start   (PORT env, default 8787)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
// Optional shared secret: if set, clients must send it in the hello frame.
const RELAY_SECRET = process.env.RELAY_SECRET || '';
// Hard cap on simultaneous connections (cheap DoS guard).
const MAX_CONNECTIONS = 64;

/** Map<unimindId, Set<connection>> */
const rooms = new Map();
/** Set of all live connections (for the cap). */
const live = new Set();

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('unimind-relay up\n');
});

const wss = new WebSocketServer({ server, path: '/unimind' });

function broadcastTo(conn, obj) {
  if (conn.readyState === WebSocket.OPEN) {
    conn.send(JSON.stringify(obj));
  }
}

function peerList(room) {
  const peers = [];
  for (const c of room) {
    if (c.identity) peers.push({ ...c.identity, name: c.name || '', connectedAt: c.connectedAt });
  }
  return peers;
}

function broadcastPeers(unimindId) {
  const room = rooms.get(unimindId);
  if (!room) return;
  const peers = peerList(room);
  for (const c of room) broadcastTo(c, { type: 'peers', peers });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (live.size >= MAX_CONNECTIONS) {
    ws.close(1013, 'relay full');
    return;
  }
  live.add(ws);
  ws.identity = null;
  ws.name = '';
  ws.connectedAt = Date.now();

  const removeFromRoom = () => {
    if (!ws.identity) return;
    const room = rooms.get(ws.identity.unimindId);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) rooms.delete(ws.identity.unimindId);
    else broadcastPeers(ws.identity.unimindId);
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }

    // ── Hello: register the connection into its room ──────────────
    if (msg.type === 'hello') {
      const identity = msg.identity;
      if (!identity || typeof identity.unimindId !== 'string' || !identity.unimindId) {
        ws.close(1008, 'missing unimindId');
        return;
      }
      if (RELAY_SECRET && msg.secret !== RELAY_SECRET) {
        ws.close(1008, 'bad secret');
        return;
      }
      if (ws.identity) removeFromRoom(); // re-hello: move rooms
      ws.identity = {
        unimindId: identity.unimindId.slice(0, 128),
        device: identity.device === 'mobile' ? 'mobile' : 'desktop',
        deviceId: String(identity.deviceId || 'unknown').slice(0, 128),
      };
      ws.name = String(msg.name || '').slice(0, 64);

      let room = rooms.get(ws.identity.unimindId);
      if (!room) {
        room = new Set();
        rooms.set(ws.identity.unimindId, room);
      }
      room.add(ws);
      broadcastTo(ws, { type: 'welcome', peerCount: room.size, peers: peerList(room) });
      broadcastPeers(ws.identity.unimindId);
      return;
    }

    // ── Message: forward to peers of the same unimindId ───────────
    if (msg.type === 'message' && ws.identity) {
      const room = rooms.get(ws.identity.unimindId);
      if (!room) return;
      const envelope = msg.message?.envelope;
      for (const c of room) {
        if (c === ws) continue;
        if (msg.targetDevice && c.identity?.deviceId !== msg.targetDevice) continue;
        if (envelope && envelope.deviceId === c.identity?.deviceId) continue; // don't loop back
        broadcastTo(c, { type: 'message', message: msg.message });
      }
      return;
    }

    if (msg.type === 'ping') {
      broadcastTo(ws, { type: 'pong', t: Date.now() });
    }
  });

  ws.on('close', () => {
    live.delete(ws);
    removeFromRoom();
  });

  ws.on('error', () => {
    try { ws.close(); } catch { /* already closed */ }
  });
});

// Heartbeat: drop connections that stop responding (dead phones, zombies).
setInterval(() => {
  for (const ws of live) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { /* ignore */ }
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`[unimind-relay] listening on ${HOST}:${PORT} (ws://<host>:${PORT}/unimind)`);
  if (RELAY_SECRET) console.log('[unimind-relay] shared secret required');
});
