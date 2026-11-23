/// <reference lib="webworker" />
import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

/**
 * Whisper worker — speech recognition off the main thread.
 *
 * Transcription is the heaviest synchronous-ish job in the voice path; on
 * the main thread it competes with rendering and can stall the orb, the
 * captions and everything else. The worker owns the pipeline exclusively;
 * the main thread only ships Float32Arrays across (transferred, not copied)
 * and gets text back.
 *
 * Message protocol:
 *   → { type: 'load', modelId }
 *   → { type: 'transcribe', id, audio }        (audio buffer is transferred)
 *   ← { type: 'status', status }
 *   ← { type: 'result', id, text }
 *   ← { type: 'error', id | null, message }
 */

type ASR = AutomaticSpeechRecognitionPipeline;

let asr: ASR | null = null;
let loading = false;

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

async function load(modelId: string): Promise<void> {
  if (asr) { post({ type: 'status', status: 'ready' }); return; }
  if (loading) return;
  loading = true;
  post({ type: 'status', status: 'loading' });
  try {
    asr = await pipeline('automatic-speech-recognition', modelId, { dtype: 'q4' } as never) as ASR;
    post({ type: 'status', status: 'ready' });
  } catch (err) {
    post({ type: 'error', id: null, message: err instanceof Error ? err.message : String(err) });
  } finally {
    loading = false;
  }
}

async function transcribe(id: number, audio: Float32Array): Promise<void> {
  if (!asr) {
    post({ type: 'error', id, message: 'Whisper model not loaded' });
    return;
  }
  try {
    const result = await asr(audio as never);
    post({ type: 'result', id, text: (result as { text: string }).text ?? '' });
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string; modelId?: string; id?: number; audio?: Float32Array };
  if (msg.type === 'load') void load(msg.modelId ?? 'Xenova/whisper-tiny.en');
  else if (msg.type === 'transcribe') void transcribe(msg.id ?? 0, msg.audio ?? new Float32Array(0));
};
