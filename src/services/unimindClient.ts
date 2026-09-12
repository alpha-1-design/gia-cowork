/**
 * UnimindClient (desktop) — GIA Cowork's end of the cross-device spine.
 *
 * Connects to the shared Unimind relay and speaks the
 * UnimindMessage protocol (src/unimind/types.ts) with the phone:
 *
 *  - presence: the desktop announces active/away/offline, and tracks the
 *    phone's presence so GIA knows where the user is.
 *  - chat: messages in either direction (surfaced as notifications).
 *  - action: remote devices delegate real work here — an incoming
 *    `action` payload is dispatched to the desktop tool registry by
 *    capability (tool id), and the result is sent back. So the phone can
 *    lock this computer, run terminal commands, read files — anything
 *    GIA's own tools can do.
 *  - follow-lock rule: when the phone reports the user active on mobile
 *    while this desktop is idle, lock the session (opt-in).
 *
 * The relay only routes between devices sharing the same unimindId, so
 * pairing is just "both devices use the same unimindId + relay URL".
 */

import {
  makeEnvelope,
  type ActionDelegationMessage,
  type ChatMessage,
  type Device,
  type PresenceMessage,
  type PresenceStatus,
  type UnimindMessage,
  type UnimindPayload,
} from '../unimind/types';
import toolRegistry from './ToolRegistry';
import { logger } from '../utils/logger';
import { isDesktopIdle, isFollowLockEnabled } from './tools/systemControl';
import { isTauri } from '../platform';

const LS_RELAY_URL = 'gia:unimind:relayUrl';
const LS_UNIMIND_ID = 'gia:unimind:unimindId';
/**
 * The desktop app carries an embedded relay (auto-started by Tauri on boot),
 * so a fresh native install works out of the box with this default.
 */
const EMBEDDED_RELAY_URL = 'ws://127.0.0.1:8787/unimind';

const PRESENCE_INTERVAL = 30_000;
const ACTION_TIMEOUT = 60_000;
const FOLLOW_LOCK_IDLE_MS = 180_000;
const FOLLOW_LOCK_COOLDOWN_MS = 180_000;

export interface UnimindPeer {
  device: Device;
  deviceId: string;
  name: string;
  connectedAt: number;
  lastSeen: number;
  presence: PresenceStatus;
}

export interface UnimindStatus {
  connected: boolean;
  relayUrl: string;
  unimindId: string;
  deviceId: string;
  peers: UnimindPeer[];
  followLock: boolean;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `d-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class UnimindClient {
  private ws: WebSocket | null = null;
  private relayUrl = '';
  private unimindId = '';
  private deviceId = '';
  private seq = 0;
  private peers = new Map<string, UnimindPeer>();
  private pending = new Map<string, PendingRequest>();
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private presence: PresenceStatus = 'offline';
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private lastFollowLockAt = 0;

  // Wire-in callbacks (set by App / tools).
  onChat?: (peer: UnimindPeer, text: string) => void;
  onPresence?: (peer: UnimindPeer) => void;
  onStatusChange?: (connected: boolean) => void;
  onActionError?: (capability: string, error: string) => void;

  constructor() {
    try {
      this.relayUrl = localStorage.getItem(LS_RELAY_URL) || '';
      this.unimindId = localStorage.getItem(LS_UNIMIND_ID) || '';
      this.deviceId = localStorage.getItem('gia:unimind:deviceId') || '';
      if (!this.unimindId) {
        this.unimindId = `uni-${genId()}`;
        localStorage.setItem(LS_UNIMIND_ID, this.unimindId);
      }
      if (!this.deviceId) {
        this.deviceId = `desktop-${genId()}`;
        localStorage.setItem('gia:unimind:deviceId', this.deviceId);
      }
      // Fresh native installs get the embedded relay automatically — the
      // Tauri app runs it on boot, so pairing works out of the box.
      if (!this.relayUrl && isTauri()) {
        this.relayUrl = EMBEDDED_RELAY_URL;
        localStorage.setItem(LS_RELAY_URL, this.relayUrl);
      }
    } catch { /* non-browser env — identity will be regenerated */ }
  }

  // ── Config ──────────────────────────────────────────────────────

  getRelayUrl(): string {
    return this.relayUrl;
  }

  setRelayUrl(url: string): void {
    this.relayUrl = url.trim();
    try {
      localStorage.setItem(LS_RELAY_URL, this.relayUrl);
    } catch { /* best-effort */ }
  }

  getUnimindId(): string {
    return this.unimindId;
  }

  getStatus(): UnimindStatus {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      relayUrl: this.relayUrl,
      unimindId: this.unimindId,
      deviceId: this.deviceId,
      peers: Array.from(this.peers.values()).sort((a, b) => b.lastSeen - a.lastSeen),
      followLock: isFollowLockEnabled(),
    };
  }

  // ── Connection ──────────────────────────────────────────────────

  /** Connect to the relay (and keep reconnecting while stopped=false). */
  async connect(url?: string): Promise<boolean> {
    if (url) this.setRelayUrl(url);
    if (!this.relayUrl) return false;
    this.stopped = false;
    return this.open();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.stopPresence();
  }

  private open(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      try {
        const ws = new WebSocket(this.relayUrl);
        this.ws = ws;
        ws.onopen = () => {
          this.reconnectDelay = 1000;
          ws.send(
            JSON.stringify({
              type: 'hello',
              identity: { unimindId: this.unimindId, device: 'desktop' as Device, deviceId: this.deviceId },
              name: 'GIA Cowork',
            }),
          );
          this.startPresence();
          this.sendPresence('online');
          logger.log(`[Unimind] connected to ${this.relayUrl}`);
          this.onStatusChange?.(true);
          if (!settled) { settled = true; resolve(true); }
        };
        ws.onmessage = (ev) => {
          try {
            this.handle(JSON.parse(ev.data as string));
          } catch (e) {
            logger.warn('[Unimind] bad frame:', e);
          }
        };
        ws.onclose = () => {
          this.onStatusChange?.(false);
          this.failPending(new Error('Unimind disconnected'));
          this.stopPresence();
          if (!settled) { settled = true; resolve(false); }
          this.scheduleReconnect();
        };
        ws.onerror = () => {
          try { ws.close(); } catch { /* ignore */ }
        };
      } catch (e) {
        logger.warn('[Unimind] connect failed:', e);
        if (!settled) { settled = true; resolve(false); }
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped && this.relayUrl) void this.open();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }

  // ── Presence ────────────────────────────────────────────────────

  private startPresence(): void {
    this.stopPresence();
    this.presenceTimer = setInterval(() => this.sendPresence(this.presence), PRESENCE_INTERVAL);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
      window.addEventListener('focus', this.onVisibility);
      window.addEventListener('blur', this.onVisibility);
    }
  }

  private stopPresence(): void {
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
      window.removeEventListener('focus', this.onVisibility);
      window.removeEventListener('blur', this.onVisibility);
    }
  }

  private onVisibility = (): void => {
    const next: PresenceStatus =
      typeof document !== 'undefined' && document.visibilityState === 'visible' ? 'online' : 'away';
    this.sendPresence(next);
  };

  private sendPresence(status: PresenceStatus): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.presence = status;
    this.send({
      type: 'presence',
      device: 'desktop',
      status,
      activeDevice: status === 'online' ? 'desktop' : undefined,
    });
  }

  // ── Sending ─────────────────────────────────────────────────────

  private send(payload: UnimindPayload, targetDevice?: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const message = makeEnvelope(
      { unimindId: this.unimindId, device: 'desktop' as Device, deviceId: this.deviceId },
      payload,
      ++this.seq,
    );
    this.ws.send(JSON.stringify({ type: 'message', message, targetDevice }));
  }

  /** Send a chat message to the phone. */
  sendChat(text: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.send({ type: 'chat', role: 'assistant', content: text });
    return true;
  }

  /**
   * Delegate an action to the other device and await its result.
   * `capability` is a tool id on the target device; params are its args.
   */
  requestAction(
    targetDevice: string,
    capability: string,
    params: Record<string, unknown> = {},
    timeoutMs = ACTION_TIMEOUT,
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected to Unimind relay'));
        return;
      }
      const requestId = genId();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Action "${capability}" timed out on ${targetDevice}`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (v) => resolve(v as { success: boolean; content?: string; error?: string }),
        reject,
        timer,
      });
      this.send(
        {
          type: 'action',
          target: targetDevice.startsWith('mobile') ? 'mobile' : 'desktop',
          capability,
          params,
          requestId,
        } as ActionDelegationMessage,
        targetDevice,
      );
    });
  }

  // ── Receiving ───────────────────────────────────────────────────

  private handle(frame: { type: string; message?: UnimindMessage; peers?: unknown[] }): void {
    if (frame.type === 'peers' && Array.isArray(frame.peers)) {
      this.syncPeers(frame.peers as Array<{ device: Device; deviceId: string; name?: string; connectedAt?: number }>);
      return;
    }
    if (frame.type !== 'message' || !frame.message) return;
    const msg = frame.message;
    if (msg.envelope.deviceId === this.deviceId) return; // our own echo
    this.peerSeen(msg.envelope.deviceId, msg.envelope.device);
    void this.dispatch(msg);
  }

  private async dispatch(msg: UnimindMessage): Promise<void> {
    const payload = msg.payload;
    const from = this.peerFor(msg.envelope.deviceId, msg.envelope.device);

    switch (payload.type) {
      case 'chat': {
        this.onChat?.(from, payload.content);
        break;
      }
      case 'presence': {
        this.applyPresence(from, payload.status);
        if (payload.status === 'online' && payload.device === 'mobile') {
          void this.maybeFollowLock();
        }
        break;
      }
      case 'action': {
        // A response (result/error set) resolves a request we sent.
        if (payload.requestId && (payload.result !== undefined || payload.error !== undefined)) {
          this.resolveActionResult(payload);
          break;
        }
        // A request: remote device delegated work to us — run it through
        // the tool registry and send the result back.
        if (payload.requestId && payload.capability) {
          const result = await this.executeRemoteAction(payload.capability, payload.params || {});
          this.send(
            {
              type: 'action',
              target: payload.target,
              capability: payload.capability,
              params: payload.params || {},
              requestId: payload.requestId,
              result: result.success ? result : undefined,
              error: result.success ? undefined : result.error,
            } as ActionDelegationMessage,
            msg.envelope.deviceId,
          );
        }
        break;
      }
      case 'verify-request': {
        // Same-unimindId peers are already trusted by the relay. Auto-approve
        // for now; a biometric challenge can slot in here later.
        this.send(
          {
            type: 'verify-response',
            requestId: payload.requestId,
            verified: true,
            viaDevice: 'desktop' as Device,
            method: 'presence',
          },
          msg.envelope.deviceId,
        );
        break;
      }
      default:
        break;
    }
  }

  private async executeRemoteAction(
    capability: string,
    params: Record<string, unknown>,
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    const tool = toolRegistry.get(capability);
    if (!tool) {
      return { success: false, error: `Capability "${capability}" not available on desktop` };
    }
    try {
      const res = await tool.execute(params);
      return { success: res.success, content: res.content, error: res.error };
    } catch (e) {
      logger.warn(`[Unimind] remote action ${capability} failed:`, e);
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Action result came back from the other device — resolve the waiter. */
  private resolveActionResult(payload: ActionDelegationMessage): void {
    const pending = this.pending.get(payload.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(payload.requestId);
    if (payload.error) {
      pending.reject(new Error(payload.error));
    } else {
      pending.resolve({ success: true, content: payload.result as string | undefined });
    }
  }

  // ── Peer bookkeeping ────────────────────────────────────────────

  private peerFor(deviceId: string, device: Device): UnimindPeer {
    let peer = this.peers.get(deviceId);
    if (!peer) {
      peer = { device, deviceId, name: device === 'mobile' ? 'GIA Mobile' : 'GIA Desktop', connectedAt: Date.now(), lastSeen: Date.now(), presence: 'offline' };
      this.peers.set(deviceId, peer);
    }
    return peer;
  }

  private peerSeen(deviceId: string, device: Device): void {
    const peer = this.peerFor(deviceId, device);
    peer.lastSeen = Date.now();
  }

  private applyPresence(peer: UnimindPeer, status: PresenceStatus): void {
    peer.presence = status;
    peer.lastSeen = Date.now();
    logger.log(`[Unimind] ${peer.name || peer.device} presence: ${status}`);
    this.onPresence?.(peer);
  }

  private syncPeers(list: Array<{ device: Device; deviceId: string; name?: string; connectedAt?: number }>): void {
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.deviceId);
      const peer = this.peerFor(p.deviceId, p.device);
      peer.name = p.name || peer.name;
      peer.connectedAt = p.connectedAt || peer.connectedAt;
    }
    for (const [id, peer] of this.peers) {
      if (!seen.has(id) && peer.device !== 'desktop') {
        peer.presence = 'offline';
        this.peers.delete(id);
        this.onPresence?.(peer);
      }
    }
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  // ── Follow-lock rule ────────────────────────────────────────────

  /** If the user is on their phone while this desktop is idle, lock it. */
  private async maybeFollowLock(): Promise<void> {
    if (!isFollowLockEnabled()) return;
    const now = Date.now();
    if (now - this.lastFollowLockAt < FOLLOW_LOCK_COOLDOWN_MS) return;
    try {
      const idle = await isDesktopIdle(FOLLOW_LOCK_IDLE_MS);
      if (idle === true) {
        this.lastFollowLockAt = now;
        logger.log('[Unimind] follow-lock: user on mobile, desktop idle — locking');
        const lockTool = toolRegistry.get('system_lock');
        if (lockTool) await lockTool.execute({});
      }
    } catch (e) {
      logger.warn('[Unimind] follow-lock check failed:', e);
    }
  }
}

export const unimindClient = new UnimindClient();
