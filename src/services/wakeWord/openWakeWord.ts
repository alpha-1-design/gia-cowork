/**
 * openWakeWord wake-word engine for GIA Cowork.
 *
 * Why this replaced the previous implementation: the old desktop path ran
 * continuous `SpeechRecognition` and substring-matched the transcript for
 * "gia". That is not a wake word -- it needs a full speech recogniser running
 * forever, it fires on the word appearing anywhere in any sentence, and in a
 * Chromium webview it hands raw microphone audio to a speech service, which is
 * the exact opposite of this product's promise. The web build was worse still:
 * `GIAWakeWord.web.ts` only logged a warning, so the toggle did nothing.
 *
 * openWakeWord runs a small ONNX keyword model locally over 16kHz audio in an
 * AudioWorklet. No audio leaves the machine, no cloud key is required, and it
 * is the same engine on the desktop app and in the browser.
 *
 * The scoring/lifecycle logic below is deliberately separated from the heavy
 * runtime so it can be unit tested without a microphone.
 */

/** openWakeWord keyword heads this app is willing to listen for. */
export const WAKE_WORD_MODELS = ['hey_jarvis', 'hey_mycroft', 'alexa'] as const;

export type WakeWordModel = (typeof WAKE_WORD_MODELS)[number];

/**
 * The app's own wake-word label ("GIA") has no bespoke openWakeWord head, so
 * it is mapped onto the closest public model. `hey_jarvis` is the natural fit:
 * two syllables, low false-positive rate, and the phrase users already say.
 */
export const DEFAULT_WAKE_WORD_MODEL: WakeWordModel = 'hey_jarvis';

export interface WakeWordPlan {
  /** Keyword heads to load. */
  keywords: WakeWordModel[];
  /** ONNX score above which a wake word is accepted. */
  detectionThreshold: number;
  /** Suppression window after a detection, in ms. */
  cooldownMs: number;
}

export interface WakeWordSettings {
  enabled: boolean;
  /** The user-facing wake word. Only the default is modelled today. */
  keyword?: string;
  /** 0..1, higher = easier to trigger. Mirrors the store's `nativeSensitivity`. */
  sensitivity: number;
  /** When true we are already in a listening turn, so retrigger fast. */
  keepListening?: boolean;
}

export interface WakeWordDetection {
  keyword: string;
  score: number;
  at: number;
}

/**
 * Map a 0..1 sensitivity onto an ONNX acceptance threshold. Sensitivity rises
 * as the threshold falls, so "easier to trigger" and "less sensitive" are
 * opposites. Clamped so a mis-saved store value can never make the model
 * either silent (threshold >= 1) or trigger-happy (threshold <= 0).
 */
export function thresholdForSensitivity(sensitivity: number): number {
  if (!Number.isFinite(sensitivity)) return 0.3;
  const clamped = Math.min(1, Math.max(0, sensitivity));
  return round2(Math.min(0.95, Math.max(0.05, 1 - clamped)));
}

/** Resolve which keyword heads to load for a settings object. */
export function keywordsFor(keyword?: string): WakeWordModel[] {
  const normalized = (keyword || '').trim().toLowerCase();
  // "hey jarvis" is the default head; anything else the user typed still falls
  // back to it rather than silently disabling the wake word.
  return [DEFAULT_WAKE_WORD_MODEL];
}

/**
 * Build the engine plan, or `null` when the wake word should not run. Returning
 * null (rather than a plan with a flag) keeps every call site honest: a disabled
 * wake word cannot be accidentally started.
 */
export function resolveWakeWordPlan(settings: WakeWordSettings): WakeWordPlan | null {
  if (!settings.enabled) return null;
  const keepListening = settings.keepListening === true;
  return {
    keywords: keywordsFor(settings.keyword),
    detectionThreshold: thresholdForSensitivity(settings.sensitivity),
    cooldownMs: keepListening ? 1200 : 2000,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Absolute URL for the staged ONNX assets.
 *
 * Resolved against this module's own built URL (`import.meta.url`, i.e.
 * `<origin>/assets/<chunk>.js`) rather than `document.baseURI`. The app is
 * built with `base: './'` and is served from a subpath on GitHub Pages, at the
 * root on Vercel, and from a custom scheme inside the Tauri webview -- and a
 * browser sitting on a deep route like `/settings/voice` would make
 * `document.baseURI` resolve `openwakeword/models` to `/settings/openwakeword/…`
 * and 404. The chunk location is always `/assets/`, so going up one level is
 * correct at any route depth, on any host, and under the Tauri scheme.
 */
export function modelBaseUrl(baseUri?: string): string {
  const base = baseUri ?? import.meta.url;
  return new URL('../openwakeword/models', base).href.replace(/\/$/, '');
}

/** Minimal structural type for the untyped `openwakeword-wasm-browser` engine. */
interface RawEngine {
  load(): Promise<void>;
  start(opts?: { deviceId?: string; gain?: number }): Promise<void>;
  stop(): Promise<void>;
  setActiveKeywords(keywords: string[]): void;
  on(event: string, handler: (payload: unknown) => void): () => void;
}

interface RawEngineCtor {
  new (opts: Record<string, unknown>): RawEngine;
}

/**
 * Guard against the wake word being started in environments that cannot run it:
 * no WebAssembly, no microphone API, or no real audio graph. Returning a reason
 * lets the UI explain itself instead of silently doing nothing -- the failure
 * mode that made the old web implementation invisible.
 */
export function wakeWordUnavailableReason(): string | null {
  if (typeof window === 'undefined') return 'no-window';
  if (typeof WebAssembly === 'undefined') return 'no-wasm';
  const nav = window.navigator as Navigator & { mediaDevices?: { getUserMedia?: unknown } };
  if (!nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') return 'no-microphone-api';
  if (typeof AudioWorkletNode === 'undefined') return 'no-audioworklet';
  return null;
}

export interface OpenWakeWordSession {
  /** Idempotent; safe to await more than once. */
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  onDetect(handler: (detection: WakeWordDetection) => void): () => void;
  onError(handler: (message: string) => void): () => void;
  /** Last observed ONNX score, for diagnostics in the settings page. */
  lastScore(): number;
}

/**
 * Create a live session. The engine module is imported dynamically so the
 * ~19MB of models and the ONNX runtime never enter the main app chunk -- it is
 * only fetched when the user actually turns the wake word on.
 */
export async function createOpenWakeWordSession(
  plan: WakeWordPlan,
  handlers: { onDetect: (d: WakeWordDetection) => void; onError: (m: string) => void } = {
    onDetect: () => {},
    onError: () => {},
  },
): Promise<OpenWakeWordSession> {
  const unavailable = wakeWordUnavailableReason();
  if (unavailable) throw new Error(`wake-word-unavailable:${unavailable}`);

  let mod: { WakeWordEngine: RawEngineCtor };
  try {
    mod = (await import('openwakeword-wasm-browser')) as unknown as {
      WakeWordEngine: RawEngineCtor;
    };
  } catch (err) {
    throw new Error(`wake-word-engine-unavailable:${(err as Error).message}`);
  }

  let score = 0;
  const engine = new mod.WakeWordEngine({
    keywords: plan.keywords,
    baseAssetUrl: modelBaseUrl(),
    detectionThreshold: plan.detectionThreshold,
    cooldownMs: plan.cooldownMs,
  });

  const offDetect = engine.on('detect', (payload) => {
    const d = payload as Partial<WakeWordDetection>;
    const nextScore = typeof d.score === 'number' ? d.score : 0;
    score = nextScore;
    if (nextScore < plan.detectionThreshold) return;
    handlers.onDetect({ keyword: d.keyword ?? plan.keywords[0], score: nextScore, at: d.at ?? Date.now() });
  });

  const offError = engine.on('error', (payload) => {
    const message = typeof payload === 'string' ? payload : (payload as Error)?.message ?? 'unknown';
    handlers.onError(message);
  });

  let started = false;
  return {
    async start() {
      await engine.load();
      if (started) return;
      await engine.start();
      started = true;
    },
    async stop() {
      if (!started) return;
      started = false;
      await engine.stop();
    },
    async dispose() {
      offDetect();
      offError();
      if (started) {
        started = false;
        await engine.stop().catch(() => {});
      }
    },
    onDetect(handler) {
      return engine.on('detect', (payload) => {
        const d = payload as Partial<WakeWordDetection>;
        if (typeof d.score === 'number') score = d.score;
        if ((d.score ?? 0) < plan.detectionThreshold) return;
        handler({ keyword: d.keyword ?? plan.keywords[0], score: d.score ?? 0, at: d.at ?? Date.now() });
      });
    },
    onError(handler) {
      return engine.on('error', (payload) => {
        handler(typeof payload === 'string' ? payload : (payload as Error)?.message ?? 'unknown');
      });
    },
    lastScore() {
      return score;
    },
  };
}