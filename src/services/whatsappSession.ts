/**
 * WhatsAppSession — frontend state for the two-way WhatsApp channel.
 *
 * The sidecar delivers incoming messages as push events (whatsapp://incoming),
 * so there is no polling here. This module owns the things the bridge can't:
 *
 *  - Per-chat conversation memory, so GIA answers with context instead of
 *    replying to every message cold.
 *  - Burst coalescing: five quick messages are answered as one reply after
 *    a short quiet period, instead of five overlapping generations.
 *  - Persistence for the auto-respond toggle and the catch-up cursor
 *    (survives app restarts).
 *
 * It does NOT own notifications or the actual GiaBrain call — the App
 * wires those in via onIncoming / onAnswer so this stays testable.
 */

import { logger } from '../utils/logger';
import type { WhatsAppIncomingMessage } from './WhatsAppBridgeService';

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface AnswerRequest {
  /** Remote JID, e.g. "233201234567@s.whatsapp.net". */
  jid: string;
  /** Best display name we have (null when unknown yet). */
  name: string | null;
  /** The messages in this burst, oldest first. */
  texts: string[];
  /** Prior conversation turns for this chat (for context). */
  history: ChatTurn[];
}

const LS_AUTO_RESPOND = 'gia:whatsapp:autoRespond';
const LS_CURSOR = 'gia:whatsapp:cursor';

/** Turns of history kept per chat. */
const HISTORY_LIMIT = 24;
/** Quiet period (ms) before a burst is answered. */
const BURST_MS = 1500;
/** Joined burst text cap — WhatsApp rejects messages over 4096 chars. */
const MAX_BURST_CHARS = 3500;
/** Hard cap for any single reply we send. */
const MAX_REPLY_CHARS = 3900;

export class WhatsAppSession {
  /** jid -> display name (from pushName / contacts). */
  private names = new Map<string, string>();
  /** jid -> conversation turns, oldest first. */
  private history = new Map<string, ChatTurn[]>();
  /** jid -> messages waiting to be answered (burst buffer). */
  private pending = new Map<string, WhatsAppIncomingMessage[]>();
  /** jid -> pending burst timer. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** jids currently being answered (guards re-entry per chat). */
  private answering = new Set<string>();

  private autoRespond: boolean;
  private cursor: number;

  /** Fired immediately per incoming message (for notifications). */
  onIncoming?: (m: WhatsAppIncomingMessage) => void;
  /** Fired when a burst is ready to be answered. Return the reply text. */
  onAnswer?: (req: AnswerRequest) => Promise<string | null>;

  constructor() {
    this.autoRespond =
      typeof localStorage !== 'undefined' ? localStorage.getItem(LS_AUTO_RESPOND) !== 'off' : true;
    this.cursor =
      (typeof localStorage !== 'undefined' ? Number(localStorage.getItem(LS_CURSOR) || 0) : 0) || 0;
  }

  // ── Persisted state ─────────────────────────────────────────────

  isAutoRespond(): boolean {
    return this.autoRespond;
  }

  setAutoRespond(enabled: boolean): void {
    this.autoRespond = enabled;
    try {
      localStorage.setItem(LS_AUTO_RESPOND, enabled ? 'on' : 'off');
    } catch { /* best-effort */ }
  }

  /** Last processed message timestamp — used for one-time catch-up. */
  getCursor(): number {
    return this.cursor;
  }

  setCursor(ts: number): void {
    if (ts <= this.cursor) return;
    this.cursor = ts;
    try {
      localStorage.setItem(LS_CURSOR, String(this.cursor));
    } catch { /* best-effort */ }
  }

  /** Seed a contact name (from a /contacts fetch) without a message. */
  noteName(jid: string, name: string): void {
    if (name && jid) this.names.set(jid, name);
  }

  // ── Incoming flow ───────────────────────────────────────────────

  /**
   * Handle an incoming message (from a push event or a catch-up fetch).
   * Notifies immediately, then arms the burst timer for this chat.
   */
  enqueue(m: WhatsAppIncomingMessage): void {
    this.setCursor(m.ts);
    if (m.fromName) this.names.set(m.from, m.fromName);

    const existing = this.pending.get(m.from) || [];
    existing.push(m);
    this.pending.set(m.from, existing);

    try {
      this.onIncoming?.(m);
    } catch (e) {
      logger.warn('[WhatsAppSession] onIncoming handler error:', e);
    }

    const timer = this.timers.get(m.from);
    if (timer) clearTimeout(timer);
    this.timers.set(
      m.from,
      setTimeout(() => {
        this.timers.delete(m.from);
        void this.flush(m.from);
      }, BURST_MS),
    );
  }

  /** Answer a chat's pending burst (if any) with full conversation context. */
  private async flush(jid: string): Promise<void> {
    const msgs = this.pending.get(jid);
    this.pending.delete(jid);
    if (!msgs || msgs.length === 0) return;

    const last = msgs[msgs.length - 1];
    const text = msgs
      .map((x) => x.text.trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_BURST_CHARS);

    this.append(jid, { role: 'user', text, ts: last.ts });

    // Auto-respond off, or already answering this chat -> notification only.
    if (!this.autoRespond || this.answering.has(jid) || !this.onAnswer) return;
    this.answering.add(jid);
    try {
      const reply = await this.onAnswer({
        jid,
        name: this.names.get(jid) || null,
        texts: msgs.map((x) => x.text),
        history: this.getHistory(jid),
      });
      if (reply) {
        this.append(jid, { role: 'assistant', text: reply, ts: Date.now() });
      }
    } catch (e) {
      logger.warn(`[WhatsAppSession] answer failed for ${jid}:`, e);
    } finally {
      this.answering.delete(jid);
    }
  }

  // ── History ─────────────────────────────────────────────────────

  getHistory(jid: string): ChatTurn[] {
    return this.history.get(jid) || [];
  }

  /** Record a turn into per-chat history (bounded). */
  append(jid: string, turn: ChatTurn): void {
    const turns = this.history.get(jid) || [];
    turns.push(turn);
    while (turns.length > HISTORY_LIMIT) turns.shift();
    this.history.set(jid, turns);
  }

  /** Cap a reply so WhatsApp never rejects it. */
  capReply(text: string): string {
    return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS - 1)}…` : text;
  }
}

export const whatsAppSession = new WhatsAppSession();
