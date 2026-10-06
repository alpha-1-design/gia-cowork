/**
 * Ambient types for `openwakeword-wasm-browser`, which ships no declarations.
 *
 * Only the surface GIA Cowork actually uses is declared. The engine class is
 * intentionally described structurally so `src/services/wakeWord/openWakeWord.ts`
 * can keep its own narrower `RawEngine` view of it.
 */
declare module 'openwakeword-wasm-browser' {
  export interface WakeWordDetectionEvent {
    keyword: string;
    score: number;
    at: number;
  }

  export interface WakeWordEngineOptions {
    /** Keyword heads to load, e.g. ['hey_jarvis']. */
    keywords?: string[];
    /** Directory the .onnx files are served from. */
    baseAssetUrl?: string;
    /** Self-host the onnxruntime wasm runtime from this path. */
    ortWasmPath?: string;
    frameSize?: number;
    sampleRate?: number;
    vadHangoverFrames?: number;
    detectionThreshold?: number;
    cooldownMs?: number;
    executionProviders?: string[];
    embeddingWindowSize?: number;
    debug?: boolean;
  }

  export class WakeWordEngine {
    constructor(options?: WakeWordEngineOptions);
    /** Downloads the ONNX models and warms the inference sessions. */
    load(): Promise<void>;
    /** Requests the microphone and starts streaming. */
    start(opts?: { deviceId?: string; gain?: number }): Promise<void>;
    stop(): Promise<void>;
    setGain(value: number): void;
    /** Runs the whole pipeline over a WAV buffer offline. */
    runWav(buffer: ArrayBuffer): Promise<number>;
    setActiveKeywords(keywords: string[]): void;
    /** Events: ready, detect, speech-start, speech-end, error. Returns an unsubscribe fn. */
    on(event: string, handler: (payload: unknown) => void): () => void;
    off(event: string, handler: (payload: unknown) => void): void;
  }

  export const MODEL_FILE_MAP: Record<string, string>;

  export default WakeWordEngine;
}