import type { Tool } from './types';
import { whatsAppBridgeService } from '../WhatsAppBridgeService';

// ── WhatsApp bridge tools (GIA Cowork desktop only) ─────────────────────
//
// These wrap the Rust whatsapp_bridge commands (src-tauri/src/whatsapp_bridge.rs),
// which supervise a Node.js sidecar holding a real WhatsApp connection via
// Baileys. This is the "text me, call me if I don't reply in time" channel:
// send a message immediately, and if it goes unread past a deadline, place a
// real WhatsApp voice call playing a TTS clip of the same message. The call
// is automatically cancelled the moment the text gets read.
//
// Everything is desktop-only: the service returns null / unavailable on
// non-Tauri builds, and these tools surface that gracefully.

const bridgeUnavailable = (): ToolResult => ({
  success: false,
  content: '',
  error: 'WhatsApp bridge is only available in the GIA Cowork desktop app.',
});

interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
}

const whatsappBridgeStartTool: Tool = {
  id: 'whatsapp_bridge_start',
  name: 'whatsapp_bridge_start',
  description:
    'Start the local WhatsApp bridge. On first run this shows a QR code to pair a real WhatsApp account (Baileys sidecar), enabling true two-way messaging with GIA. Use whatsapp_bridge_status to see pairing progress.',
  schema: { type: 'object', properties: {} },
  execute: async () => {
    if (!whatsAppBridgeService.available()) return bridgeUnavailable();
    try {
      const res = await whatsAppBridgeService.start();
      if (!res) return { success: false, content: '', error: 'WhatsApp bridge did not respond.' };
      if (res.alreadyRunning) return { success: true, content: 'WhatsApp bridge is already running — check whatsapp_bridge_status for pairing state.' };
      return { success: true, content: 'WhatsApp bridge started. Run whatsapp_bridge_status to see the pairing QR and connection state.' };
    } catch (e) {
      return { success: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
};

const whatsappBridgeStatusTool: Tool = {
  id: 'whatsapp_bridge_status',
  name: 'whatsapp_bridge_status',
  description: 'Check the WhatsApp bridge state: connected (with the paired number), pairing (QR pending), or stopped.',
  schema: { type: 'object', properties: {} },
  execute: async () => {
    if (!whatsAppBridgeService.available()) return bridgeUnavailable();
    try {
      const status = await whatsAppBridgeService.status();
      if (!status) return { success: false, content: '', error: 'Bridge is not reachable — start it with whatsapp_bridge_start.' };
      if (status.connected) return { success: true, content: `WhatsApp bridge is **connected** (${status.jid || 'account paired'}).` };
      if (status.pairing) return { success: true, content: 'WhatsApp bridge is **pairing** — scan the QR code shown by the app to connect the account.' };
      return { success: true, content: 'WhatsApp bridge is running but **not connected**. Pair an account or stop it with whatsapp_bridge_stop.' };
    } catch (e) {
      return { success: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
};

const whatsappBridgeStopTool: Tool = {
  id: 'whatsapp_bridge_stop',
  name: 'whatsapp_bridge_stop',
  description: 'Stop the local WhatsApp bridge and disconnect the paired account.',
  schema: { type: 'object', properties: {} },
  execute: async () => {
    if (!whatsAppBridgeService.available()) return bridgeUnavailable();
    try {
      await whatsAppBridgeService.stop();
      return { success: true, content: 'WhatsApp bridge stopped.' };
    } catch (e) {
      return { success: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
};

const whatsappNotifyTool: Tool = {
  id: 'whatsapp_notify',
  name: 'whatsapp_notify',
  description:
    'Send a WhatsApp message to a phone number (country code, no "+"). Optionally escalate: if the message stays unread after escalateAfterMs, GIA places a real WhatsApp voice call playing the TTS clip at escalateAudioPath (the call is auto-cancelled once the text is read).',
  schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Phone number with country code, no "+" (e.g. 233201234567)' },
      text: { type: 'string', description: 'The message to send' },
      escalateAfterMs: { type: 'number', description: 'Optional: escalate to a voice call if unread after this many milliseconds' },
      escalateAudioPath: { type: 'string', description: 'Optional: path to a pre-synthesized TTS clip of the message' },
    },
    required: ['to', 'text'],
  },
  execute: async (args) => {
    const { to, text, escalateAfterMs, escalateAudioPath } = args as { to?: string; text?: string; escalateAfterMs?: number; escalateAudioPath?: string };
    if (!to || !text) return { success: false, content: '', error: 'Both "to" (phone, with country code) and "text" are required.' };
    if (!whatsAppBridgeService.available()) return bridgeUnavailable();
    try {
      const res = await whatsAppBridgeService.notify({ to, text, escalateAfterMs, escalateAudioPath });
      if (!res) return { success: false, content: '', error: 'WhatsApp notify failed.' };
      return {
        success: true,
        content: res.escalated
          ? `✅ WhatsApp message sent to **${to}** — escalation armed (voice call if unread).`
          : `✅ WhatsApp message sent to **${to}**.`,
      };
    } catch (e) {
      return { success: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const whatsAppBridgeTools: Tool[] = [
  whatsappBridgeStartTool,
  whatsappBridgeStatusTool,
  whatsappBridgeStopTool,
  whatsappNotifyTool,
];
