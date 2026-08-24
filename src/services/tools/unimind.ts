import { z } from 'zod';
import { defineTool } from './defineTool';
import { unimindClient } from '../unimindClient';

// ── Unimind tools — the cross-device spine ────────────────────────────
//
// GIA Cowork pairs with the GIA phone app through the Unimind relay.
// These tools let GIA itself drive the pairing: point at a relay, check
// who's online, message the phone, and — the big one — run real actions
// on the phone from the desktop (send SMS, take a photo, play media,
// anything the mobile toolset can do), awaiting the result.

const unimindStatusTool = defineTool({
  id: 'unimind_status',
  name: 'unimind_status',
  description:
    'Show the cross-device (Unimind) state: relay URL, pairing id, connected or not, and which other devices are online with their presence.',
  execute: async () => {
    const s = unimindClient.getStatus();
    const lines = [
      `**Unimind** — ${s.connected ? '🟢 connected' : '🔴 disconnected'}`,
      `Relay: ${s.relayUrl || '(not configured)'}`,
      `Pairing id: \`${s.unimindId}\``,
      `This device: \`${s.deviceId}\``,
    ];
    if (s.peers.length === 0) {
      lines.push('No other devices online. Pair the phone: same relay URL + same pairing id.');
    } else {
      lines.push('**Online devices:**');
      for (const p of s.peers) {
        lines.push(`- ${p.name || p.device} (\`${p.deviceId}\`) — ${p.presence}, seen ${new Date(p.lastSeen).toLocaleTimeString()}`);
      }
    }
    lines.push(`Follow-lock: ${s.followLock ? 'on' : 'off'}`);
    return { success: true, content: lines.join('\n') };
  },
});

const unimindRelayTool = defineTool({
  id: 'unimind_connect',
  name: 'unimind_connect',
  description:
    'Set the Unimind relay URL and connect. Both devices must use the same relay AND the same pairing id (see unimind_status) to see each other. Examples: ws://192.168.1.50:8787/unimind (local), wss://relay.example.com/unimind (remote).',
  input: z.object({
    url: z.string().url().describe('Relay URL, e.g. ws://host:8787/unimind or wss://host/unimind'),
  }),
  execute: async ({ url }) => {
    const ok = await unimindClient.connect(url);
    return ok
      ? { success: true, content: `Connected to relay ${url}. Run unimind_status to see paired devices.` }
      : { success: false, content: '', error: `Could not connect to ${url} — is the relay running and reachable?` };
  },
});

const unimindSendTool = defineTool({
  id: 'unimind_send',
  name: 'unimind_send',
  description: 'Send a chat message to the paired phone (surfaces as a notification / chat message on GIA mobile).',
  input: z.object({
    text: z.string().min(1).describe('Message to send to the phone'),
  }),
  execute: async ({ text }) => {
    const sent = unimindClient.sendChat(text);
    return sent
      ? { success: true, content: `Sent to phone: ${text}` }
      : { success: false, content: '', error: 'Not connected to Unimind relay — use unimind_connect first.' };
  },
});

const unimindRunTool = defineTool({
  id: 'unimind_run',
  name: 'unimind_run',
  description:
    'Run a real action on the paired mobile device and wait for the result. capability is a tool id on the phone (e.g. send_sms, make_phone_call, send_whatsapp, media_play, take_photo, clipboard_write, send_email, device_info). The phone executes it natively and replies with the outcome. Use unimind_status to find the phone\'s deviceId.',
  input: z.object({
    capability: z.string().min(1).describe('Tool id to run on the phone'),
    params: z.record(z.string(), z.unknown()).optional().describe('Arguments for that tool'),
    targetDevice: z.string().optional().describe('The phone\'s deviceId (required if more than one mobile device is paired)'),
  }),
  execute: async ({ capability, params, targetDevice }) => {
    const s = unimindClient.getStatus();
    if (!s.connected) return { success: false, content: '', error: 'Not connected to Unimind relay — use unimind_connect first.' };
    const mobiles = s.peers.filter((p) => p.device === 'mobile');
    if (mobiles.length === 0) return { success: false, content: '', error: 'No mobile device online. Pair the phone first (same relay + pairing id).' };
    const target = targetDevice || mobiles[0].deviceId;
    try {
      const res = await unimindClient.requestAction(target, capability, params || {});
      return {
        success: res.success,
        content: res.success ? `✅ ${capability} on phone: ${res.content || 'done'}` : '',
        error: res.success ? undefined : res.error,
      };
    } catch (e) {
      return { success: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const unimindTools = [unimindStatusTool, unimindRelayTool, unimindSendTool, unimindRunTool];
