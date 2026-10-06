/**
 * A `GIAWakeWordPlugin` backed by the local openWakeWord ONNX engine.
 *
 * Shared by the Tauri desktop build and the browser build so there is exactly
 * one wake-word implementation to reason about. `accessKey` is accepted and
 * ignored: the previous Porcupine-backed native path required a cloud key, and
 * the whole point of moving to openWakeWord is that the wake word works
 * offline with no key configured.
 */
import type { PluginListenerHandle } from '@capacitor/core';
import {
  createOpenWakeWordSession,
  resolveWakeWordPlan,
  wakeWordUnavailableReason,
  type OpenWakeWordSession,
  type WakeWordDetection,
} from './openWakeWord';

export interface StartOptions {
  accessKey?: string;
  keyword?: string;
  sensitivity?: number;
  customModelPath?: string;
}

export interface GIAWakeWordPluginLike {
  startListening(options?: StartOptions): Promise<void>;
  stopListening(): Promise<void>;
  isListening(): Promise<{ listening: boolean }>;
  getPendingWakeWord(): Promise<{ detected: boolean; keyword: string }>;
  addListener(
    eventName: 'wakeWordDetected',
    handler: (result: { keyword: string }) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
  /** Last failure reason, for the settings page to surface. */
  lastError(): string | null;
  lastScore(): number;
}

export function createOpenWakeWordPlugin(
  defaultKeyword = 'hey gia',
  log: (msg: string) => void = () => {},
): GIAWakeWordPluginLike {
  const handlers = new Set<(r: { keyword: string }) => void>();
  let session: OpenWakeWordSession | null = null;
  let listening = false;
  let pending: { detected: boolean; keyword: string } = { detected: false, keyword: '' };
  let error: string | null = null;
  let score = 0;
  let starting: Promise<void> | null = null;

  async function disposeSession() {
    const current = session;
    session = null;
    listening = false;
    if (current) await current.dispose().catch(() => {});
  }

  return {
    async startListening(opts) {
      if (listening || starting) return starting ?? undefined;

      const plan = resolveWakeWordPlan({
        enabled: true,
        keyword: opts?.keyword || defaultKeyword,
        // The store's default is 0.7; treat a missing value the same way.
        sensitivity: typeof opts?.sensitivity === 'number' ? opts.sensitivity : 0.7,
        keepListening: false,
      });
      if (!plan) return;

      const unavailable = wakeWordUnavailableReason();
      if (unavailable) {
        error = `wake-word-unavailable:${unavailable}`;
        log(`[GIAWakeWord] openWakeWord cannot run here (${unavailable})`);
        return;
      }

      starting = (async () => {
        try {
          const created = await createOpenWakeWordSession(plan, {
            onDetect: (d: WakeWordDetection) => {
              score = d.score;
              pending = { detected: true, keyword: d.keyword };
              handlers.forEach((h) => h({ keyword: d.keyword }));
            },
            onError: (m: string) => {
              error = m;
            },
          });
          await created.start();
          session = created;
          listening = true;
          error = null;
          log('[GIAWakeWord] openWakeWord listening');
        } catch (err) {
          error = (err as Error).message;
          log(`[GIAWakeWord] failed to start: ${error}`);
          await disposeSession();
        } finally {
          starting = null;
        }
      })();

      return starting;
    },

    async stopListening() {
      await disposeSession();
    },

    async isListening() {
      return { listening };
    },

    async getPendingWakeWord() {
      const result = pending;
      pending = { detected: false, keyword: '' };
      return result;
    },

    async addListener(_eventName, handler) {
      handlers.add(handler);
      return {
        remove: () => {
          handlers.delete(handler);
          return Promise.resolve();
        },
      };
    },

    async removeAllListeners() {
      handlers.clear();
    },

    lastError() {
      return error;
    },

    lastScore() {
      return session ? session.lastScore() : score;
    },
  };
}