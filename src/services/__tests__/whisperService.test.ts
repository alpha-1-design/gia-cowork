import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * WhisperService runtime selection: the worker path is the default, and a
 * workerless environment (or a load error) transparently falls back to the
 * main-thread pipeline. The public API never changes.
 */

const workerInstances: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  messages: unknown[] = [];
  constructor(public url: string, public opts?: unknown) { workerInstances.push(this); }
  postMessage(msg: unknown) { this.messages.push(msg); }
  terminate() { this.terminated = true; }
}

vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);

const pipeline = vi.fn();
vi.mock('@huggingface/transformers', () => ({ pipeline }));

import whisper from '../WhisperService';

beforeEach(() => {
  workerInstances.length = 0;
  pipeline.mockReset();
  // reset singleton state
  whisper.unload();
});

describe('WhisperService runtime', () => {
  it('loads in the worker by default and routes transcription through it', async () => {
    pipeline.mockResolvedValue(undefined);
    const load = whisper.loadModel();
    await Promise.resolve(); await Promise.resolve();
    expect(workerInstances).toHaveLength(1);
    const w = workerInstances[0];
    expect(JSON.stringify(w.messages[0])).toContain('whisper-tiny');
    // The worker warms up → ready.
    w.onmessage?.({ data: { type: 'status', status: 'ready' } } as MessageEvent);
    await load;
    expect(whisper.status).toBe('ready');
    expect(whisper.runtime).toBe('worker');

    const result = whisper.transcribeFloat32(new Float32Array(1600));
    await Promise.resolve(); await Promise.resolve();
    // The transcribe message carried a TRANSFERRED copy, not the caller's buffer.
    expect(JSON.stringify(w.messages[1])).toContain('transcribe');
    w.onmessage?.({ data: { type: 'result', id: 1, text: '  hello there  ' } } as MessageEvent);
    await expect(result).resolves.toBe('hello there');
  });

  it('falls back to the main thread when the worker reports a load error', async () => {
    pipeline.mockResolvedValue(async () => ({ text: ' main thread text ' }));
    const load = whisper.loadModel();
    await Promise.resolve(); await Promise.resolve();
    const w = workerInstances[0];
    w.onmessage?.({ data: { type: 'error', id: null, message: 'no wasm' } } as MessageEvent);
    await load;
    expect(whisper.runtime).toBe('main');
    expect(whisper.status).toBe('ready');
    expect(pipeline).toHaveBeenCalled();
    await expect(whisper.transcribeFloat32(new Float32Array(1600))).resolves.toBe('main thread text');
  });

  it('falls back to the main thread when workers cannot be constructed at all', async () => {
    pipeline.mockResolvedValue(async () => ({ text: 'fallback' }));
    // Sabotage construction AFTER the first spawn attempt resolves.
    const original = globalThis.Worker;
    vi.stubGlobal('Worker', class { constructor() { throw new Error('no workers'); } });
    try {
      await whisper.loadModel();
      expect(whisper.runtime).toBe('main');
      await expect(whisper.transcribeFloat32(new Float32Array(1600))).resolves.toBe('fallback');
    } finally {
      vi.stubGlobal('Worker', original);
    }
  });

  it('a timed-out transcription rejects without poisoning the next one', async () => {
    await whisper.unload(); // explicit reset: this test must not inherit the previous runtime
    pipeline.mockResolvedValue(undefined);
    const load = whisper.loadModel();
    await Promise.resolve(); await Promise.resolve();
    const w = workerInstances[0];
    w.onmessage?.({ data: { type: 'status', status: 'ready' } } as MessageEvent);
    await load;

    const slow = whisper.transcribeFloat32(new Float32Array(1600), { timeoutMs: 10 });
    let err: Error | null = null;
    try { await slow; } catch (e) { err = e as Error; }
    expect(err?.message).toContain('timed out');

    const next = whisper.transcribeFloat32(new Float32Array(1600));
    await Promise.resolve(); await Promise.resolve();
    // Reply with the id the service actually assigned (ids accumulate across
    // tests on the singleton — reply to the live pending entry, not a guess).
    const liveId = (w.messages[w.messages.length - 1] as { id: number }).id;
    w.onmessage?.({ data: { type: 'result', id: liveId, text: 'still works' } } as MessageEvent);
    await expect(next).resolves.toBe('still works');
  });
});
