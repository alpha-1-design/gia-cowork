import { logger } from '../utils/logger';
import type { KokoroTTS as KokoroModel } from 'kokoro-js';

// ── Types ───────────────────────────────────────────────────────────

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
type KokoroAudio = Awaited<ReturnType<KokoroModel['generate']>>;
type KokoroVoice = NonNullable<NonNullable<Parameters<KokoroModel['generate']>[1]>['voice']>;

export type KokoroStatus = 'unloaded' | 'loading' | 'ready' | 'error';

export interface KokoroProgress {
  loaded: number;
  total: number;
  percent: number;
}

// Curated subset of the ~30 Kokoro voices (id → label). All verified on the
// Kokoro-82M model card. `tts.voices` exposes the full set at runtime.
export const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: 'af_heart', label: 'Heart (American female)' },
  { id: 'af_bella', label: 'Bella (American female)' },
  { id: 'af_sky', label: 'Sky (American female)' },
  { id: 'am_adam', label: 'Adam (American male)' },
  { id: 'bf_emma', label: 'Emma (British female)' },
];

interface KokoroProgressInfo {
  status?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

// ── Service ─────────────────────────────────────────────────────────
// 100% in-browser TTS (Apache-2.0, 82M params) via kokoro-js +
// transformers.js — same download-cache mechanism SpeechT5 already uses.
// Outputs 24kHz mono Float32 audio (~86MB q8 model).

class KokoroService {
  private static instance: KokoroService;
  static getInstance() {
    if (!this.instance) this.instance = new KokoroService();
    return this.instance;
  }

  private model: KokoroModel | null = null;
  private _status: KokoroStatus = 'unloaded';
  private _loading = false;
  private _progress: KokoroProgress = { loaded: 0, total: 0, percent: 0 };
  private _device: 'webgpu' | 'wasm' = 'wasm';

  private activeCtx: AudioContext | null = null;
  private activeSource: AudioBufferSourceNode | null = null;

  private _voice: KokoroVoice;

  constructor() {
    const storedVoice = localStorage.getItem('gia-kokoro-voice');
    this._voice = (KOKORO_VOICES.some(({ id }) => id === storedVoice) ? storedVoice : 'af_heart') as KokoroVoice;
  }

  get status() { return this._status; }
  get isReady() { return this._status === 'ready' && this.model !== null; }
  get progress() { return this._progress; }
  get device() { return this._device; }
  get modelId() { return KOKORO_MODEL_ID; }

  get voice() { return this._voice; }
  setVoice(v: string) {
    if (!KOKORO_VOICES.some(({ id }) => id === v)) return;
    this._voice = v as KokoroVoice;
    localStorage.setItem('gia-kokoro-voice', v);
  }

  hasWebGPU() {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  async loadModel(forceWasm: boolean = false): Promise<void> {
    if (this.isReady) return;
    if (this._loading) return;

    this._loading = true;
    this._status = 'loading';
    this._progress = { loaded: 0, total: 0, percent: 0 };

    const device = !forceWasm && this.hasWebGPU() ? 'webgpu' : 'wasm';

    try {
      const mod = await import('kokoro-js');
      const KokoroTTS = mod.KokoroTTS;

      try {
        this.model = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
          dtype: 'q8',
          device,
          progress_callback: (p: KokoroProgressInfo) => this.trackProgress(p),
        });
      } catch (webgpuErr) {
        // The model repo (or this WebView2) may not expose WebGPU-compatible
        // weights — fall back to WASM, which always works.
        if (device === 'webgpu') {
          logger.warn('[Kokoro] WebGPU load failed, falling back to WASM:', webgpuErr);
          this.model = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
            dtype: 'q8',
            device: 'wasm',
            progress_callback: (p: KokoroProgressInfo) => this.trackProgress(p),
          });
        } else {
          throw webgpuErr;
        }
      }

      this._device = device;
      this._status = 'ready';
      this._progress = { loaded: 100, total: 100, percent: 100 };
      logger.log(`[Kokoro] Loaded ${KOKORO_MODEL_ID} (${device}, q8)`);
    } catch (err) {
      this._status = 'error';
      this.model = null;
      logger.error('[Kokoro] Failed to load model:', err);
      throw err;
    } finally {
      this._loading = false;
    }
  }

  private trackProgress(p: KokoroProgressInfo) {
    if (p.status === 'progress' && typeof p.progress === 'number') {
      this._progress = { loaded: p.progress, total: 100, percent: p.progress };
    } else if (typeof p.loaded === 'number' && typeof p.total === 'number' && p.total > 0) {
      this._progress = {
        loaded: p.loaded,
        total: p.total,
        percent: Math.min(100, Math.round((p.loaded / p.total) * 100)),
      };
    }
  }

  /**
   * Synthesize speech from text. Returns an AudioBuffer ready to play.
   */
  async synthesize(text: string, voice: string = this._voice): Promise<AudioBuffer | null> {
    if (!this.isReady || !this.model) {
      logger.warn('[Kokoro] Model not loaded');
      return null;
    }

    try {
      const raw: KokoroAudio = await this.model.generate(text, { voice: voice as KokoroVoice, speed: 1 });
      const audio = raw.data;
      const sampleRate = raw.sampling_rate || 24000;

      const audioCtx = new AudioContext({ sampleRate });
      const audioBuffer = audioCtx.createBuffer(1, audio.length, sampleRate);
      audioBuffer.getChannelData(0).set(audio);

      return audioBuffer;
    } catch (err) {
      logger.error('[Kokoro] Synthesis failed:', err);
      return null;
    }
  }

  /**
   * Synthesize and play. Returns a promise that resolves when playback finishes.
   *
   * Uses the prefetch slot when it matches: TTSService asks for the NEXT
   * sentence's synthesis while the current one plays, so a sentence boundary
   * costs zero synthesis dead-air. (Measured gap without prefetch: ~1-3 s on
   * WASM Kokoro, ~300-750 ms on WebGPU — every sentence boundary.)
   */
  async speak(text: string, voice: string = this._voice): Promise<boolean> {
    const audioBuffer = await this.takePrefetch(text, voice);
    if (!audioBuffer) return false;

    try {
      const audioCtx = new AudioContext({ sampleRate: audioBuffer.sampleRate });
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);

      this.activeCtx = audioCtx;
      this.activeSource = source;

      return new Promise<boolean>((resolve) => {
        const safety = setTimeout(() => {
          this.activeCtx = null;
          this.activeSource = null;
          audioCtx.close().catch(() => {});
          resolve(true);
        }, Math.max(5000, audioBuffer.duration * 1000 + 1000));

        source.onended = () => {
          clearTimeout(safety);
          this.activeCtx = null;
          this.activeSource = null;
          audioCtx.close().catch(() => {});
          resolve(true);
        };

        source.start();
      });
    } catch (err) {
      logger.error('[Kokoro] Playback failed:', err);
      return false;
    }
  }

  // ── Prefetch slot ─────────────────────────────────────────────────────
  // One slot, filled by TTSService with the queue head while the current
  // sentence plays. speak() consumes it only on an exact text+voice match;
  // anything else is dropped (a stale buffer is worse than a fresh one).

  private prefetchText: string | null = null;
  private prefetchVoice: string | null = null;
  private prefetchPromise: Promise<AudioBuffer | null> | null = null;

  /** Start synthesizing `text` in the background for the next play call. */
  prefetch(text: string, voice: string = this._voice): void {
    if (!this.isReady || !this.model) return;
    if (this.prefetchPromise) return; // one slot; already busy
    this.prefetchText = text;
    this.prefetchVoice = voice;
    this.prefetchPromise = this.synthesize(text, voice);
  }

  private async takePrefetch(text: string, voice: string): Promise<AudioBuffer | null> {
    const pending = this.prefetchPromise;
    this.prefetchPromise = null;
    if (pending && this.prefetchText === text && this.prefetchVoice === voice) {
      this.prefetchText = null;
      this.prefetchVoice = null;
      return await pending;
    }
    // Stale or absent prefetch: drop it and synthesize fresh. A dropped
    // promise's buffer is discarded — never played by mistake.
    this.prefetchText = null;
    this.prefetchVoice = null;
    return await this.synthesize(text, voice);
  }

  /** Stop any in-flight Kokoro playback and drop the active audio context. */
  stop() {
    // Drop any pending prefetch: a stopped queue must not hand its stale
    // buffer to the next unrelated sentence.
    this.prefetchPromise = null;
    this.prefetchText = null;
    this.prefetchVoice = null;
    try {
      this.activeSource?.stop();
    } catch {
      // Already stopped — ignore.
    }
    if (this.activeCtx) {
      this.activeCtx.close().catch(() => {});
      this.activeCtx = null;
    }
    this.activeSource = null;
  }

  async unload(): Promise<void> {
    this.stop();
    this.model = null;
    this._status = 'unloaded';
    this._progress = { loaded: 0, total: 0, percent: 0 };
  }
}

/**
 * Phase-4 warm-up: load the model in the background BEFORE her first
 * utterance, so the first spoken sentence never pays the model download
 * (q8 Kokoro is tens of MB — a multi-second dead-air on a cold engine).
 * Only warms when the user actually has TTS + Kokoro turned on; the model
 * singleton no-ops when already ready or loading; failure is a log line.
 */
export async function warmKokoro(
  /** Injectable for tests; defaults to the app singleton. */
  service: { isReady: boolean; loadModel(): Promise<void> } = KokoroService.getInstance(),
): Promise<void> {
  if (localStorage.getItem('gia-tts-enabled') !== 'true') return;
  if (localStorage.getItem('gia-kokoro-enabled') !== 'true') return;
  if (service.isReady) return;
  try {
    await service.loadModel();
  } catch (err) {
    logger.warn('[Kokoro] warm-up failed:', err);
  }
}

export default KokoroService.getInstance();