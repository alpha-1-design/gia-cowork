import { logger } from '../../utils/logger';
import { FRAME_SIZE } from './micTap';

/**
 * vad — conversation endpointing over the shared mic tap.
 *
 * Two implementations behind one interface (wave-2 dive §1.5):
 *  - SileroVadRouter: the staged silero-vad v4 ONNX (already shipped for the
 *    wake-word front-end, 1.8 MB, MIT) run frame-wise via onnxruntime-web
 *    WASM, self-hosted (no CDN);
 *  - EnergyVAD: zero-dependency RMS over the same frames with an adaptive
 *    noise floor — automatic fallback when the ORT session cannot be created.
 *
 * Hysteresis is tuned for turn-taking, not wake word (wave-2 §1.4):
 *  - onset:   probability > 0.6 sustained 2 frames (160 ms) — responsive entry
 *  - offset:  probability < 0.35 sustained N frames — slow exit avoids clipping
 *    trailing words (default N=5 ≈ 400 ms)
 *  - barge-in: during playback the onset rises to > 0.7 × 3 frames (240 ms) so
 *    speaker leakage does not read as the user talking.
 * Frames in the breathy 0.35–0.6 band do not count toward the offset counter.
 */

export interface VadConfig {
  onsetThreshold?: number;
  onsetFrames?: number;
  offsetThreshold?: number;
  offsetFrames?: number;
  /** Onset threshold while GIA is speaking (barge-in mode). */
  bargeInOnsetThreshold?: number;
  bargeInOnsetFrames?: number;
}

export interface VadDecision {
  speechStart: boolean;
  speechEnd: boolean;
  /** True once speech has begun and speechEnd has not fired yet. */
  active: boolean;
}

export interface VAD {
  /** Feed one 80 ms frame; returns the hysteresis decision for it. */
  feed(frame: Float32Array): VadDecision;
  /** Zero state — call after barge-in or when resuming listening. */
  reset(): void;
  setBargeInMode(on: boolean): void;
  readonly kind: 'silero' | 'energy';
}

const DEFAULTS = {
  onsetThreshold: 0.6,
  onsetFrames: 2,
  offsetThreshold: 0.35,
  offsetFrames: 5,
  bargeInOnsetThreshold: 0.7,
  bargeInOnsetFrames: 3,
};

// ─── Shared hysteresis state machine ─────────────────────────────────────

/** Pure hysteresis over any per-frame speech probability. Exported for tests. */
export class HysteresisVAD {
  private cfg: Required<VadConfig>;
  private probability: (frame: Float32Array) => number;
  private onsetCount = 0;
  private offsetCount = 0;
  private active = false;
  private bargeIn = false;

  constructor(probability: (frame: Float32Array) => number, cfg: VadConfig = {}) {
    this.probability = probability;
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  isActive() { return this.active; }

  setBargeInMode(on: boolean) {
    if (this.bargeIn === on) return;
    this.bargeIn = on;
    this.onsetCount = 0;
  }

  reset() {
    this.onsetCount = 0;
    this.offsetCount = 0;
    this.active = false;
  }

  feed(frame: Float32Array): VadDecision {
    const p = this.probability(frame);
    const onsetThreshold = this.bargeIn ? this.cfg.bargeInOnsetThreshold : this.cfg.onsetThreshold;
    const onsetFrames = this.bargeIn ? this.cfg.bargeInOnsetFrames : this.cfg.onsetFrames;
    const wasActive = this.active;

    if (!this.active) {
      if (p >= onsetThreshold) {
        this.onsetCount++;
        if (this.onsetCount >= onsetFrames) {
          this.active = true;
          this.offsetCount = 0;
        }
      } else {
        this.onsetCount = 0;
      }
    } else {
      // Breathy pause band: hold, don't count toward offset.
      if (p < this.cfg.offsetThreshold) this.offsetCount++;
      else this.offsetCount = 0;
      if (this.offsetCount >= this.cfg.offsetFrames) {
        this.active = false;
        this.onsetCount = 0;
        this.offsetCount = 0;
      }
    }

    return {
      speechStart: !wasActive && this.active,
      speechEnd: wasActive && !this.active,
      active: this.active,
    };
  }
}

// ─── Silero VAD (onnxruntime-web, WASM, self-hosted) ─────────────────────

let ortPromise: Promise<typeof import('onnxruntime-web')> | null = null;

function loadOrt() {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web').then((ort) => {
      // Self-hosted ORT runtime + single thread: Tauri's custom protocol does
      // not set COOP/COEP, so SharedArrayBuffer is unavailable and the
      // jsDelivr CDN default is both a network dependency and CSP-fragile.
      ort.env.wasm.wasmPaths = '/openwakeword/ort/';
      ort.env.wasm.numThreads = 1;
      return ort;
    });
  }
  return ortPromise;
}

const SILERO_MODEL_URL = '/openwakeword/models/silero_vad.onnx';

/** silero-vad v4 frame call: input [1,1280] + sr + recurrent h/c [2,1,64]. */
export class SileroVadRouter implements VAD {
  readonly kind = 'silero' as const;
  private hyst: HysteresisVAD;
  private session: import('onnxruntime-web').InferenceSession | null = null;
  private h: import('onnxruntime-web').Tensor | null = null;
  private c: import('onnxruntime-web').Tensor | null = null;
  private srTensor: import('onnxruntime-web').Tensor | null = null;
  private inputTensor: import('onnxruntime-web').Tensor | null = null;
  private running = false;
  private pending: Float32Array | null = null;
  private lastP = 0;
  /** Set after repeated runtime failures so callers can degrade gracefully. */
  broken = false;

  private constructor(cfg: VadConfig = {}) {
    this.hyst = new HysteresisVAD(() => this.lastP, cfg);
  }

  static async create(cfg: VadConfig = {}): Promise<SileroVadRouter> {
    const router = new SileroVadRouter(cfg);
    await router.init();
    // Self-test one silent frame before declaring silero usable — catches
    // broken wasm at init time so createVAD can fall back immediately.
    await router.run(new Float32Array(FRAME_SIZE));
    return router;
  }

  private async init() {
    const ort = await loadOrt();
    const data = await fetch(SILERO_MODEL_URL).then((r) => {
      if (!r.ok) throw new Error(`silero model fetch failed: ${r.status}`);
      return r.arrayBuffer();
    });
    this.session = await ort.InferenceSession.create(new Uint8Array(data), {
      executionProviders: ['wasm'],
    });
    await this.buildTensors();
    logger.log('[VAD] silero ready (wasm, self-hosted)');
  }

  private async buildTensors() {
    const ort = await loadOrt();
    const zeros = new Float32Array(2 * 1 * 64);
    this.h = new ort.Tensor('float32', new Float32Array(zeros), [2, 1, 64]);
    this.c = new ort.Tensor('float32', new Float32Array(zeros), [2, 1, 64]);
    this.srTensor = new ort.Tensor('int64', [BigInt(16000)], []);
    this.inputTensor = new ort.Tensor('float32', new Float32Array(FRAME_SIZE), [1, FRAME_SIZE]);
  }

  reset() {
    this.lastP = 0;
    this.running = false;
    this.pending = null;
    this.hyst.reset();
    if (this.session && this.h) {
      // Zero recurrent state without rebuilding the session.
      const data = this.h.data as Float32Array;
      data.fill(0);
      const cData = this.c!.data as Float32Array;
      cData.fill(0);
    }
  }

  /** Inference runs serially; the newest frame replaces any queued one. */
  private async run(frame: Float32Array): Promise<void> {
    if (this.running) { this.pending = frame; return; }
    this.running = true;
    try {
      (this.inputTensor!.data as Float32Array).set(frame);
      const out = await this.session!.run({
        input: this.inputTensor!,
        sr: this.srTensor!,
        h: this.h!,
        c: this.c!,
      });
      this.lastP = (out.speech_prob.data as Float32Array)[0] ?? 0;
      this.h = out.hn;
      this.c = out.cn;
    } finally {
      this.running = false;
    }
    if (this.pending) {
      const next = this.pending;
      this.pending = null;
      await this.run(next);
    }
  }

  feed(frame: Float32Array): VadDecision {
    // Fire-and-forget inference; hysteresis reads the LAST probability. The
    // 80 ms cadence keeps this at worst one frame behind — inaudible.
    this.run(frame).catch((err) => {
      this.runFailures++;
      if (this.runFailures === 1 || this.runFailures % 50 === 0) {
        logger.warn('[VAD] silero inference failing (' + this.runFailures + '):', err);
      }
      if (this.runFailures >= 20) this.broken = true;
    });
    return this.hyst.feed(frame);
  }

  private runFailures = 0;

  setBargeInMode(on: boolean) { this.hyst.setBargeInMode(on); }
}

// ─── Energy fallback (RMS + adaptive floor) ──────────────────────────────

/** RMS energy VAD — good enough in quiet rooms / headphones. */
export class EnergyVAD implements VAD {
  readonly kind = 'energy' as const;
  private hyst: HysteresisVAD;
  private floor = 0.01;

  constructor(cfg: VadConfig = {}) {
    this.hyst = new HysteresisVAD((frame) => this.probability(frame), cfg);
  }

  private probability(frame: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    // Adaptive noise floor: EMA of the quiet end.
    if (rms < this.floor) this.floor = this.floor * 0.95 + rms * 0.05;
    const threshold = Math.max(this.floor * 3, this.floor + 0.006);
    const ratio = rms / threshold;
    // Map ratio to a pseudo-probability that saturates around 2x threshold.
    return Math.min(1, ratio / 2);
  }

  feed(frame: Float32Array): VadDecision {
    return this.hyst.feed(frame);
  }

  setBargeInMode(on: boolean) { this.hyst.setBargeInMode(on); }
  reset() { this.floor = 0.01; this.hyst.reset(); }
}

/**
 * Create the best available VAD: silero first, energy fallback on any
 * failure (missing wasm, blocked fetch). Never throws.
 */
export async function createVAD(cfg: VadConfig = {}): Promise<VAD> {
  try {
    return await SileroVadRouter.create(cfg);
  } catch (err) {
    logger.warn('[VAD] silero unavailable, using energy fallback:', err);
    return new EnergyVAD(cfg);
  }
}

/** Concatenate endpointed frames into one utterance buffer. */
export function concatFrames(frames: Float32Array[]): Float32Array {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const out = new Float32Array(total);
  let pos = 0;
  for (const f of frames) { out.set(f, pos); pos += f.length; }
  return out;
}
