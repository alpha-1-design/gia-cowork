import { logger } from '../../utils/logger';

/**
 * micTap — the one microphone stream.
 *
 * Vendored from `openwakeword-wasm-browser/src/WakeWordEngine.js` (the inline
 * AUDIO_PROCESSOR worklet): buffers 1280 samples @ 16 kHz = 80 ms frames and
 * posts each Float32Array to the main thread. The voice module owns its own
 * getUserMedia + AudioContext so the conversation VAD, the (future) wake-word
 * tap and the STT buffer all share ONE capture — one permission prompt, one
 * mic indicator, one clock. This is the wave-2 "vendor the tap" option A.
 *
 * The worklet source is vendored verbatim rather than imported from the
 * library because WakeWordEngine creates and closes its own AudioContext with
 * no way to attach a second consumer to its graph.
 */

export const FRAME_SIZE = 1280; // 80 ms @ 16 kHz

const WORKLET_SRC = `
class AudioProcessor extends AudioWorkletProcessor {
    bufferSize = 1280;
    _buffer = new Float32Array(this.bufferSize);
    _pos = 0;
    process(inputs) {
        const input = inputs[0][0];
        if (input) {
            for (let i = 0; i < input.length; i++) {
                this._buffer[this._pos++] = input[i];
                if (this._pos === this.bufferSize) {
                    this.port.postMessage(this._buffer);
                    this._pos = 0;
                }
            }
        }
        return true;
    }
}
registerProcessor('audio-processor', AudioProcessor);
`;

export type FrameHandler = (frame: Float32Array) => void;

export interface MicTap {
  /** Raw 16 kHz mono frames of exactly FRAME_SIZE samples. */
  onFrame(handler: FrameHandler): () => void;
  stop(): Promise<void>;
  readonly isRunning: boolean;
}

let active: MicTap | null = null;
let starting: Promise<MicTap> | null = null;
/**
 * Test seam: happy-dom locks `AudioContext` as a non-configurable global, so
 * tests inject fakes here instead of stubbing the environment. Production
 * code path is unchanged — the browser globals are used whenever unset.
 */
export const __micTapTestHooks: {
  AudioContext?: typeof AudioContext;
  AudioWorkletNode?: typeof AudioWorkletNode;
} = {};
/**
 * Refcount over the ONE capture. VoiceSession and the wake-word listener
 * both hold a reference: either can start the tap, and the stream lives
 * until the LAST consumer stops. This is what makes the one-mic design
 * real — a voice session closing no longer kills the wake word's ears.
 */
let refs = 0;

/**
 * Start (or return the already-running) shared mic tap.
 *
 * AEC/NS/AGC are ON: she speaks through the same machine's speakers, so the
 * capture must do its best to keep her own voice out of the utterance buffer.
 */
export async function startMicTap(): Promise<MicTap> {
  if (active?.isRunning) { refs++; return active; }
  if (starting) {
    refs++;
    return starting;
  }
  refs++;

  starting = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const Ctx = __micTapTestHooks.AudioContext ?? AudioContext;
    const ctx = new Ctx({ sampleRate: 16000 });
    const source = ctx.createMediaStreamSource(stream);
    const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    const WorkletCtor = __micTapTestHooks.AudioWorkletNode ?? AudioWorkletNode;
    const worklet = new WorkletCtor(ctx, 'audio-processor');
    source.connect(worklet);
    // Do NOT connect the worklet to ctx.destination — this is a sink-less tap.
    // (Chromium still drives the worklet as long as the context is running.)

    const handlers = new Set<FrameHandler>();
    worklet.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const frame = e.data;
      if (!(frame instanceof Float32Array) || frame.length !== FRAME_SIZE) return;
      for (const h of Array.from(handlers)) {
        try { h(frame); } catch (err) { logger.error('[micTap] handler error:', err); }
      }
    };

    const tap: MicTap = {
      onFrame(handler) {
        handlers.add(handler);
        return () => { handlers.delete(handler); };
      },
      async stop() {
        handlers.clear();
        active = null;
        starting = null;
        refs = 0;
        try { worklet.port.onmessage = null; worklet.disconnect(); } catch { /* ignore */ }
        try { source.disconnect(); } catch { /* ignore */ }
        for (const track of stream.getTracks()) track.stop();
        try { await ctx.close(); } catch { /* ignore */ }
      },
      get isRunning() { return ctx.state !== 'closed'; },
    };

    active = tap;
    return tap;
  })();

  try {
    return await starting;
  } catch (err) {
    // The failed start never produced a usable reference — release it so a
    // later attempt starts from a clean count.
    refs = Math.max(0, refs - 1);
    starting = null;
    throw err;
  }
}

/**
 * Release one reference to the shared tap. The stream tears down only when
 * the LAST consumer stops — the one-mic contract.
 */
export async function stopMicTap(): Promise<void> {
  refs = Math.max(0, refs - 1);
  if (refs === 0) {
    const tap = active;
    active = null;
    starting = null;
    if (tap) await tap.stop();
  }
}

/** Test hook: reset the module's refcount/caching state between tests. */
export function __micTapReset(): void {
  refs = 0;
  active = null;
  starting = null;
}
