import { logger } from '../utils/logger';

export type WhisperModelId = 'Xenova/whisper-tiny.en' | 'Xenova/whisper-base.en';

export type WhisperStatus = 'unloaded' | 'loading' | 'ready' | 'error';

/**
 * Where transcription runs. 'worker' is the default path (the model is the
 * heaviest thing in the voice loop and must not stall the main thread);
 * 'main' is the automatic fallback for environments where module workers
 * are unavailable (some test rigs, exotic webviews).
 */
export type WhisperRuntime = 'worker' | 'main';

type Transcriber = (audio: Float32Array | Blob) => Promise<{ text: string }>;

interface WorkerAPI {
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
  terminate: () => void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

const WORKER_TIMEOUT_MS = 120_000; // one utterance, generously — q4 on CPU can crawl

class WhisperService {
  private static instance: WhisperService;
  static getInstance() {
    if (!this.instance) this.instance = new WhisperService();
    return this.instance;
  }

  private transcriber: Transcriber | null = null;
  private _modelId: WhisperModelId = 'Xenova/whisper-tiny.en';
  private _status: WhisperStatus = 'unloaded';
  private _loading = false;
  private _runtime: WhisperRuntime = 'worker';
  private worker: WorkerAPI | null = null;
  private pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  get status() { return this._status; }
  get modelId() { return this._modelId; }
  get isReady() { return this._status === 'ready' && (this.transcriber !== null || (this._runtime === 'worker' && this.workerReady)); }
  get runtime(): WhisperRuntime { return this._runtime; }
  private workerReady = false;

  async loadModel(modelId: WhisperModelId = 'Xenova/whisper-tiny.en'): Promise<void> {
    if (this.isReady && this._modelId === modelId) return;
    if (this._loading) return;

    this._loading = true;
    this._modelId = modelId;
    this._status = 'loading';

    try {
      // Worker first; fall back to the main thread if the environment cannot
      // spawn one. The fallback is invisible to callers — same API either way.
      if (this._runtime === 'worker') {
        const ok = await this.loadInWorker(modelId).catch(() => false);
        if (ok) {
          this._status = 'ready';
          logger.log(`[Whisper] Loaded ${modelId} in worker`);
          return;
        }
        logger.warn('[Whisper] worker unavailable — falling back to main thread');
        this._runtime = 'main';
      }
      const mod = await import('@huggingface/transformers');
      this.transcriber = await mod.pipeline('automatic-speech-recognition', modelId, {
        dtype: 'q4',
      } as never) as typeof this.transcriber;
      this._status = 'ready';
      logger.log(`[Whisper] Loaded ${modelId} on main thread`);
    } catch (err) {
      this._status = 'error';
      logger.error('[Whisper] Failed to load model:', err);
      throw err;
    } finally {
      this._loading = false;
    }
  }

  /** Spawn + warm the worker; resolve false on ANY failure (fallback path). */
  private loadInWorker(modelId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      let worker: WorkerAPI;
      try {
        // Vite module-worker construction; throws in environments without them.
        worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerAPI;
      } catch (e) {
        logger.warn('[Whisper] cannot spawn worker:', e instanceof Error ? e.message : e);
        done(false);
        return;
      }
      const abortTimer = setTimeout(() => { if (!settled) { worker.terminate(); done(false); } }, 60_000);
      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data as { type: string; status?: string; id?: number; text?: string; message?: string };
        if (msg.type === 'status' && msg.status === 'ready') {
          clearTimeout(abortTimer);
          this.workerReady = true;
          this.worker = worker;
          done(true);
        } else if (msg.type === 'result') {
          const p = this.pending.get(msg.id!);
          if (p) { this.pending.delete(msg.id!); p.resolve(msg.text ?? ''); }
        } else if (msg.type === 'error') {
          clearTimeout(abortTimer);
          if (msg.id !== null && msg.id !== undefined) {
            const p = this.pending.get(msg.id);
            if (p) { this.pending.delete(msg.id); p.reject(new Error(msg.message ?? 'transcription failed')); }
          } else if (!settled) {
            worker.terminate();
            done(false); // load error → fall back
          }
        }
      };
      worker.onerror = (e) => {
        clearTimeout(abortTimer);
        logger.warn('[Whisper] worker error:', e);
        if (!settled) { worker.terminate(); done(false); }
      };
      worker.postMessage({ type: 'load', modelId });
    });
  }

  /** 16 kHz mono PCM straight from the mic tap — skips WAV encode/decode. */
  async transcribeFloat32(audio: Float32Array, opts: { timeoutMs?: number } = {}): Promise<string> {
    if (this._status === 'error') throw new Error('Whisper model not loaded');
    if (this._runtime === 'worker' && this.workerReady && this.worker) {
      return this.transcribeInWorker(audio, opts.timeoutMs ?? WORKER_TIMEOUT_MS);
    }
    if (!this.isReady || !this.transcriber) {
      throw new Error('Whisper model not loaded');
    }
    const result = await this.transcriber(audio as never);
    return result.text.trim();
  }

  private transcribeInWorker(audio: Float32Array, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!this.worker) { reject(new Error('Whisper worker not running')); return; }
      const id = this.nextId++;
      const copy = audio.slice(); // transferred buffers are neutered — send a copy
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Transcription timed out'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (text) => { clearTimeout(timer); resolve(text.trim()); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.worker.postMessage({ type: 'transcribe', id, audio: copy }, [copy.buffer]);
    });
  }

  async transcribe(audioBlob: Blob): Promise<string> {
    if (this._runtime === 'worker' && this.workerReady && this.worker) {
      // Decode to 16 kHz mono on the main thread (fast), then ship.
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      return this.transcribeFloat32(audioBuffer.getChannelData(0));
    }
    if (!this.isReady || !this.transcriber) {
      throw new Error('Whisper model not loaded');
    }
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    const result = await this.transcriber(channelData as never);
    return result.text.trim();
  }

  async unload(): Promise<void> {
    this.transcriber = null;
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.workerReady = false;
    for (const [, p] of this.pending) p.reject(new Error('Whisper unloaded'));
    this.pending.clear();
    this._status = 'unloaded';
    // Reset the runtime choice: a previous fallback must not stick forever —
    // workers may exist again by the next load (reload, new webview).
    this._runtime = 'worker';
  }
}

export default WhisperService.getInstance();
