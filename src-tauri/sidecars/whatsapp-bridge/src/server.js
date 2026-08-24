// GIA Cowork -- WhatsApp bridge sidecar
//
// Runs as a long-lived Node.js process, spawned and supervised by the
// Tauri Rust backend (see src-tauri/src/whatsapp_bridge.rs). Holds the
// actual Baileys WebSocket connection to WhatsApp (something the Tauri
// webview/Rust side can't do directly) and exposes a small localhost-only
// HTTP API for the rest of the app to call.
//
// IMPORTANT -- read before pairing a real number:
// This uses Baileys, which authenticates as an unofficial second WhatsApp
// Web client on whatever account you scan the QR code with. It is not
// Meta's Business API. Per Baileys' own README: "The maintainers of
// Baileys do not in any way condone the use of this application in
// practices that violate the Terms of Service of WhatsApp." Automating a
// personal account this way risks that account being restricted or banned
// by WhatsApp. Use a dedicated/secondary number, not your primary one.
//
// Call placing (initiateCall / baileys-caller) is additionally
// experimental with no tagged release upstream -- expect it to need
// maintenance as WhatsApp's protocol changes.

import express from 'express';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { VoipClient } from 'baileys-caller';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = process.env.GIA_WA_AUTH_DIR || path.join(__dirname, '..', 'auth');
const PORT = Number(process.env.GIA_WA_BRIDGE_PORT || 8765);
// Shared secret set by the Tauri side when it spawns this process, so an
// arbitrary local process/webpage can't hit this HTTP server and send
// messages or place calls as you.
const TOKEN = process.env.GIA_WA_BRIDGE_TOKEN || '';

const logger = pino({ level: process.env.GIA_WA_LOG_LEVEL || 'warn' });

fs.mkdirSync(AUTH_DIR, { recursive: true });

/** @type {import('@whiskeysockets/baileys').WASocket | null} */
let sock = null;
let connected = false;
let selfJid = null;
let lastQr = null;

/** messageId -> { status: 'sent'|'delivered'|'read', to, sentAt } */
const messageStatus = new Map();
/** Pending escalation timers keyed by the message id that triggered them. */
const pendingEscalations = new Map();
/** Incoming (person -> GIA) text messages, oldest first, for GET /messages. */
const incomingMessages = [];
const MAX_INCOMING = 200;

function normalizeJid(to) {
  if (to.includes('@')) return to;
  const digits = to.replace(/[^\d]/g, '');
  if (!digits) throw new Error(`Not a usable phone number: ${to}`);
  return `${digits}@s.whatsapp.net`;
}

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state, logger, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      lastQr = qr;
      console.log('\n[whatsapp-bridge] Scan this QR with WhatsApp > Linked Devices on the account you want GIA to use:\n');
      qrcodeTerminal.generate(qr, { small: true });
    }
    if (connection === 'open') {
      connected = true;
      selfJid = sock.user?.id || null;
      lastQr = null;
      logger.warn(`[whatsapp-bridge] connected as ${selfJid}`);
    }
    if (connection === 'close') {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn(`[whatsapp-bridge] connection closed (code ${statusCode}), reconnect=${shouldReconnect}`);
      if (shouldReconnect) setTimeout(connectWhatsApp, 3000);
      else logger.error('[whatsapp-bridge] logged out -- delete auth dir and re-pair to reconnect');
    }
  });

  // Capture incoming messages so GIA can answer them (OpenClaw-style
  // two-way channel). Only private-chat text messages from other people;
  // our own sends are filtered by key.fromMe, and groups are skipped for
  // now (they need their own mention-aware handling pass).
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      const key = msg?.key;
      if (!key || key.fromMe) continue;
      if (key.remoteJid && key.remoteJid.endsWith('@g.us')) continue;
      const text = msg?.message?.conversation || msg?.message?.extendedTextMessage?.text;
      if (!text || !text.trim()) continue;
      const entry = {
        id: key.id,
        from: key.remoteJid || 'unknown',
        fromName: null,
        text: text.slice(0, 4000),
        ts: Date.now(),
      };
      incomingMessages.push(entry);
      if (incomingMessages.length > MAX_INCOMING) incomingMessages.shift();
      logger.warn(`[whatsapp-bridge] incoming from ${entry.from}: ${text.slice(0, 60)}`);
    }
  });

  // Track delivery/read status so the escalation logic in POST /notify
  // knows whether to actually place a call, or stand down because the
  // message was already read.
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      const id = u.key?.id;
      if (!id || !messageStatus.has(id)) continue;
      const entry = messageStatus.get(id);
      // Baileys status: 1=PENDING 2=SERVER_ACK 3=DELIVERY_ACK 4=READ 5=PLAYED
      if (u.update?.status >= 4) {
        entry.status = 'read';
        const pending = pendingEscalations.get(id);
        if (pending) {
          clearTimeout(pending);
          pendingEscalations.delete(id);
          logger.warn(`[whatsapp-bridge] message ${id} read before escalation timer fired -- call cancelled`);
        }
      } else if (u.update?.status === 3 && entry.status === 'sent') {
        entry.status = 'delivered';
      }
    }
  });

  return sock;
}

async function sendText(to, text) {
  if (!connected || !sock) throw new Error('WhatsApp not connected');
  const jid = normalizeJid(to);
  const result = await sock.sendMessage(jid, { text });
  const id = result?.key?.id;
  if (id) messageStatus.set(id, { status: 'sent', to: jid, sentAt: Date.now() });
  return { messageId: id, jid };
}

async function sendVoiceNote(to, audioPath) {
  if (!connected || !sock) throw new Error('WhatsApp not connected');
  const jid = normalizeJid(to);
  const result = await sock.sendMessage(jid, {
    audio: { url: audioPath },
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
  });
  return { messageId: result?.key?.id, jid };
}

async function placeCall(to, audioPath) {
  if (!connected) throw new Error('WhatsApp not connected');
  const jid = normalizeJid(to);
  const client = new VoipClient({ authDir: AUTH_DIR });
  await client.connect();
  const call = await client.call(jid.split('@')[0], { audioSource: audioPath });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Call timed out waiting for answer')), 45000);
    call.on('connected', () => {
      clearTimeout(timeout);
      resolve({ status: 'connected', jid });
    });
    call.on('ringing', () => logger.warn(`[whatsapp-bridge] call to ${jid} ringing`));
    call.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

/**
 * The actual "call and text -- calls if I don't reply in time" behavior:
 * send a text immediately, and if it hasn't been read within `afterMs`,
 * place a real call playing `audioPath` (a pre-synthesized TTS clip of
 * the same message). Cancelled automatically the moment a read receipt
 * comes in (see messages.update above), so replying to the text is
 * always enough to stand the call down.
 */
async function notifyWithEscalation(to, text, escalate) {
  const { messageId, jid } = await sendText(to, text);
  if (!escalate || !messageId) return { messageId, escalated: false };

  const timer = setTimeout(async () => {
    pendingEscalations.delete(messageId);
    const entry = messageStatus.get(messageId);
    if (entry?.status === 'read') return; // race guard
    try {
      logger.warn(`[whatsapp-bridge] ${jid} hasn't read message ${messageId} after ${escalate.afterMs}ms -- escalating to a call`);
      await placeCall(to, escalate.audioPath);
    } catch (e) {
      logger.error(`[whatsapp-bridge] escalation call failed: ${e.message}`);
    }
  }, escalate.afterMs);
  pendingEscalations.set(messageId, timer);

  return { messageId, escalated: true, escalatesAt: Date.now() + escalate.afterMs };
}

// --- HTTP control API (localhost only) ---------------------------------

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (!TOKEN) return next(); // no token configured -- dev mode only
  if (req.headers['x-gia-token'] !== TOKEN) {
    return res.status(401).json({ error: 'missing or invalid X-GIA-Token' });
  }
  next();
});

app.get('/status', (_req, res) => {
  res.json({ connected, jid: selfJid, pairing: !!lastQr, qr: lastQr });
});

// Incoming messages newer than ?since=<epoch_ms>. The client keeps its own
// cursor (last seen ts) so nothing is missed or delivered twice.
app.get('/messages', (req, res) => {
  const since = Number(req.query.since || 0);
  const messages = incomingMessages.filter((m) => m.ts > since);
  res.json({ messages, now: Date.now() });
});

app.post('/send', async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'to and text are required' });
    res.json(await sendText(to, text));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/send-voice', async (req, res) => {
  try {
    const { to, audioPath } = req.body;
    if (!to || !audioPath) return res.status(400).json({ error: 'to and audioPath are required' });
    res.json(await sendVoiceNote(to, audioPath));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/call', async (req, res) => {
  try {
    const { to, audioPath } = req.body;
    if (!to || !audioPath) return res.status(400).json({ error: 'to and audioPath are required' });
    res.json(await placeCall(to, audioPath));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/notify', async (req, res) => {
  try {
    const { to, text, escalateAfterMs, escalateAudioPath } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'to and text are required' });
    const escalate = escalateAfterMs && escalateAudioPath
      ? { afterMs: escalateAfterMs, audioPath: escalateAudioPath }
      : null;
    res.json(await notifyWithEscalation(to, text, escalate));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  logger.warn(`[whatsapp-bridge] control API listening on 127.0.0.1:${PORT}`);
});

connectWhatsApp().catch((e) => {
  logger.error(`[whatsapp-bridge] failed to connect: ${e.message}`);
  process.exit(1);
});
