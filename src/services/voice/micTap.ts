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
 * Start (or return the already-running) shared mic tap.
 *
 * AEC/NS/AGC are ON: she speaks through the same machine's speakers, so the
 * capture must do its best to keep her own voice out of the utterance buffer.
 */
export async function startMicTap(): Promise<MicTap> {
  if (active?.isRunning) return active;
  if (starting) return starting;

  starting = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const ctx = new AudioContext({ sampleRate: 16000 });
    const source = ctx.createMediaStreamSource(stream);
    const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    const worklet = new AudioWorkletNode(ctx, 'audio-processor');
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
    starting = null;
    throw err;
  }
}

/** Stop the shared tap if it is running. Safe to call twice. */
export async function stopMicTap(): Promise<void> {
  const tap = active;
  active = null;
  starting = null;
  if (tap) await tap.stop();
}
