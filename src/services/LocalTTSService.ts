import { logger } from '../utils/logger';

// ── Types ───────────────────────────────────────────────────────────

export type LocalTTSModelId = 'Xenova/speecht5_tts';

export type LocalTTSStatus = 'unloaded' | 'loading' | 'ready' | 'error';

export interface LocalTTSProgress {
  loaded: number;
  total: number;
  percent: number;
}

// ── Speaker embeddings ──────────────────────────────────────────────
// SpeechT5 requires speaker embeddings for voice identity.
// This is a pre-computed average CMU Arctic speaker embedding (768-dim float32).
// It produces a clear, neutral American English female voice.
// Source: HuggingFace speecht5 CMU Arctic average embedding
const SPEAKER_EMBEDDING_URL =
  'https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/transformers/tasks/speecht5_speaker_embeddings.bin';

let cachedSpeakerEmbedding: Float32Array | null = null;

async function getSpeakerEmbedding(): Promise<Float32Array> {
  if (cachedSpeakerEmbedding) return cachedSpeakerEmbedding;

  try {
    const res = await fetch(SPEAKER_EMBEDDING_URL);
    if (!res.ok) throw new Error(`Failed to fetch speaker embeddings: ${res.status}`);
    const buffer = await res.arrayBuffer();
    cachedSpeakerEmbedding = new Float32Array(buffer);
    logger.log(`[LocalTTS] Loaded speaker embeddings (${cachedSpeakerEmbedding.length} floats)`);
    return cachedSpeakerEmbedding;
  } catch (err) {
    logger.error('[LocalTTS] Failed to load speaker embeddings:', err);
    throw err;
  }
}

// ── Service ─────────────────────────────────────────────────────────

class LocalTTSService {
  private static instance: LocalTTSService;
  static getInstance() {
    if (!this.instance) this.instance = new LocalTTSService();
    return this.instance;
  }

  private synthesizer: ((text: string, options?: Record<string, unknown>) => Promise<unknown>) | null = null;
  private _modelId: LocalTTSModelId = 'Xenova/speecht5_tts';
  private _status: LocalTTSStatus = 'unloaded';
  private _loading = false;
  private _progress: LocalTTSProgress = { loaded: 0, total: 0, percent: 0 };

  get status() { return this._status; }
  get modelId() { return this._modelId; }
  get isReady() { return this._status === 'ready' && this.synthesizer !== null; }
  get progress() { return this._progress; }

  async loadModel(modelId: LocalTTSModelId = 'Xenova/speecht5_tts'): Promise<void> {
    if (this.isReady && this._modelId === modelId) return;
    if (this._loading) return;

    this._loading = true;
    this._modelId = modelId;
    this._status = 'loading';
    this._progress = { loaded: 0, total: 0, percent: 0 };

    try {
      const mod = await import('@huggingface/transformers');

      // Create a progress-tracking wrapper
      const pipeline = mod.pipeline as (
        task: string,
        model: string,
        options?: Record<string, unknown>
      ) => Promise<unknown>;

      this.synthesizer = await pipeline('text-to-speech', modelId, {}) as typeof this.synthesizer;

      this._status = 'ready';
      this._progress = { loaded: 100, total: 100, percent: 100 };
      logger.log(`[LocalTTS] Loaded ${modelId}`);
    } catch (err) {
      this._status = 'error';
      this.synthesizer = null;
      logger.error('[LocalTTS] Failed to load model:', err);
      throw err;
    } finally {
      this._loading = false;
    }
  }

  /**
   * Synthesize speech from text. Returns an AudioBuffer ready to play.
   */
  async synthesize(text: string): Promise<AudioBuffer | null> {
    if (!this.isReady || !this.synthesizer) {
      logger.warn('[LocalTTS] Model not loaded');
      return null;
    }

    try {
      // Get speaker embeddings for voice identity
      const speakerEmbedding = await getSpeakerEmbedding();

      // Run the TTS pipeline
      const result = await this.synthesizer(text, {
        speaker_embeddings: [speakerEmbedding],
      }) as { audio?: Float32Array } | Float32Array;

      // Extract the audio data — result may be a Float32Array directly or an object with .audio
      const audioData = result instanceof Float32Array
        ? result
        : (result as { audio?: Float32Array })?.audio ?? null;

      if (!audioData) {
        logger.warn('[LocalTTS] No audio data returned');
        return null;
      }

      // SpeechT5 outputs at 16kHz
      const sampleRate = 16000;
      const audioCtx = new AudioContext({ sampleRate });
      const audioBuffer = audioCtx.createBuffer(1, audioData.length, sampleRate);
      audioBuffer.getChannelData(0).set(audioData);

      return audioBuffer;
    } catch (err) {
      logger.error('[LocalTTS] Synthesis failed:', err);
      return null;
    }
  }

  /**
   * Synthesize and play. Returns a promise that resolves when playback finishes.
   */
  async speak(text: string): Promise<boolean> {
    const audioBuffer = await this.synthesize(text);
    if (!audioBuffer) return false;

    try {
      const audioCtx = new AudioContext({ sampleRate: audioBuffer.sampleRate });
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);

      return new Promise<boolean>((resolve) => {
        source.onended = () => {
          audioCtx.close().catch(() => {});
          resolve(true);
        };
        // AudioBufferSourceNode has no onerror; handle via setTimeout safety
        const safety = setTimeout(() => {
          audioCtx.close().catch(() => {});
          resolve(true);
        }, Math.max(5000, audioBuffer.duration * 1000 + 1000));
        source.onended = () => {
          clearTimeout(safety);
          audioCtx.close().catch(() => {});
          resolve(true);
        };
        source.start();
      });
    } catch (err) {
      logger.error('[LocalTTS] Playback failed:', err);
      return false;
    }
  }

  async unload(): Promise<void> {
    this.synthesizer = null;
    this._status = 'unloaded';
    this._progress = { loaded: 0, total: 0, percent: 0 };
    cachedSpeakerEmbedding = null;
  }
}

export default LocalTTSService.getInstance();
