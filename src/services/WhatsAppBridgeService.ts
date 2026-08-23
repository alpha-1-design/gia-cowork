/**
 * WhatsAppBridgeService - GIA Cowork only, no mobile equivalent.
 *
 * Wraps the Rust whatsapp_bridge commands (src-tauri/src/whatsapp_bridge.rs),
 * which supervise a Node.js sidecar holding a real WhatsApp connection
 * (via Baileys -- see src-tauri/sidecars/whatsapp-bridge/README.md for
 * what that actually means and its risks before pairing an account).
 *
 * This is the "text me, call me if I don't reply in time" channel: send a
 * message immediately, and if it goes unread past a deadline, place a
 * real WhatsApp call playing a TTS clip of the same message. The call is
 * automatically cancelled the moment the text gets read -- see the
 * sidecar's messages.update handler.
 */

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface WhatsAppBridgeStatus {
  connected: boolean;
  jid: string | null;
  pairing: boolean;
  qr: string | null;
}

export const whatsAppBridgeService = {
  available(): boolean {
    return isTauri();
  },

  async start(): Promise<{ started: boolean; alreadyRunning: boolean } | null> {
    if (!isTauri()) return null;
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('whatsapp_bridge_start');
  },

  async stop(): Promise<void> {
    if (!isTauri()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('whatsapp_bridge_stop');
  },

  async status(): Promise<WhatsAppBridgeStatus | null> {
    if (!isTauri()) return null;
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('whatsapp_status');
  },

  /**
   * Send `text` to `to` (phone number with country code, no '+' needed).
   * If `escalateAfterMs` and `escalateAudioPath` (a pre-synthesized TTS
   * clip of the same message) are both given, and the message is still
   * unread after that delay, the sidecar places a real WhatsApp voice
   * call playing that clip. Omit both for a plain text-only send.
   */
  async notify(args: {
    to: string;
    text: string;
    escalateAfterMs?: number;
    escalateAudioPath?: string;
  }): Promise<{ messageId?: string; escalated: boolean } | null> {
    if (!isTauri()) return null;
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('whatsapp_notify', { args });
  },
};
