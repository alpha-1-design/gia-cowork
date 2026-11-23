import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * One-mic mode for the wake word: with a frameSource, the engine must score
 * frames from the SHARED mic tap instead of opening its own getUserMedia
 * capture. Without one, the engine's own capture remains the fallback.
 */

const instances: FakeEngine[] = [];

class FakeEngine {
  handlers: Record<string, Array<(p: unknown) => void>> = {};
  loaded = false;
  started = false;
  scored: Float32Array[] = [];

  constructor() { instances.push(this); }

  on(event: string, handler: (p: unknown) => void): () => void {
    (this.handlers[event] ??= []).push(handler);
    return () => {
      this.handlers[event] = this.handlers[event].filter((h) => h !== handler);
    };
  }

  emit(event: string, payload: unknown): void {
    for (const h of [...(this.handlers[event] ?? [])]) h(payload);
  }

  async load(): Promise<void> { this.loaded = true; }
  async start(): Promise<void> { this.started = true; }
  async stop(): Promise<void> { this.started = false; }
  // Private scoring path the engine's own worklet would drive.
  async _processChunk(frame: Float32Array): Promise<void> { this.scored.push(frame); }
}

vi.mock('openwakeword-wasm-browser', () => ({ WakeWordEngine: FakeEngine }));

import { stubBrowserAudio } from '../../__tests__/browserAudioStub';

import {
  createOpenWakeWordSession,
  resolveWakeWordPlan,
  DEFAULT_WAKE_WORD_MODEL,
} from '../openWakeWord';

let restoreBrowser: () => void;

beforeEach(() => {
  instances.length = 0;
  restoreBrowser = stubBrowserAudio();
});

afterEach(() => {
  restoreBrowser();
});

describe('createOpenWakeWordSession one-mic frame source', () => {
  it('scores shared-tap frames WITHOUT opening its own capture', async () => {
    const plan = resolveWakeWordPlan({ enabled: true, sensitivity: 0.7 })!;
    const tapHandlers: Array<(f: Float32Array) => void> = [];
    const session = await createOpenWakeWordSession(plan, { onDetect: () => {}, onError: () => {} }, {
      onFrame(handler) {
        tapHandlers.push(handler);
        return () => { const i = tapHandlers.indexOf(handler); if (i >= 0) tapHandlers.splice(i, 1); };
      },
    });
    const engine = instances[0];
    await session.start();
    expect(engine.loaded).toBe(true);
    expect(engine.started).toBe(false); // no own getUserMedia capture
    const frame = new Float32Array(1280);
    for (const h of [...tapHandlers]) h(frame);
    expect(engine.scored).toEqual([frame]);
  });

  it('a detect fired through the shared-tap path still reaches onDetect', async () => {
    const plan = resolveWakeWordPlan({ enabled: true, sensitivity: 0.7 })!;
    const detections: string[] = [];
    const tapHandlers: Array<(f: Float32Array) => void> = [];
    const session = await createOpenWakeWordSession(plan, {
      onDetect: (d) => { detections.push(d.keyword); },
      onError: () => {},
    }, { onFrame: (h) => { tapHandlers.push(h); return () => {}; } });
    await session.start();
    const engine = instances[0];
    // Tap delivers a frame; the engine's scoring emits detect through its
    // own 'detect' handler (score above threshold).
    for (const h of [...tapHandlers]) h(new Float32Array(1280));
    engine.emit('detect', { keyword: DEFAULT_WAKE_WORD_MODEL, score: 0.9 });
    expect(detections).toEqual([DEFAULT_WAKE_WORD_MODEL]);
  });

  it('dispose unsubscribes the shared-tap feed', async () => {
    const plan = resolveWakeWordPlan({ enabled: true, sensitivity: 0.7 })!;
    const tapHandlers: Array<(f: Float32Array) => void> = [];
    const session = await createOpenWakeWordSession(plan, { onDetect: () => {}, onError: () => {} }, {
      onFrame: (h) => { tapHandlers.push(h); return () => { const i = tapHandlers.indexOf(h); if (i >= 0) tapHandlers.splice(i, 1); }; },
    });
    await session.start();
    expect(tapHandlers.length).toBe(1);
    await session.dispose();
    expect(tapHandlers.length).toBe(0); // no dangling feed into a disposed engine
  });

  it('without a frameSource the engine opens its own capture (fallback)', async () => {
    const plan = resolveWakeWordPlan({ enabled: true, sensitivity: 0.7 })!;
    const session = await createOpenWakeWordSession(plan);
    await session.start();
    const engine = instances[0];
    expect(engine.started).toBe(true); // own-capture path
    await session.dispose();
  });

  it('a scoring failure on a shared-tap frame surfaces as onError, not a crash', async () => {
    const plan = resolveWakeWordPlan({ enabled: true, sensitivity: 0.7 })!;
    const errors: string[] = [];
    const tapHandlers: Array<(f: Float32Array) => void> = [];
    const session = await createOpenWakeWordSession(plan, {
      onDetect: () => {},
      onError: (m) => { errors.push(m); },
    }, { onFrame: (h) => { tapHandlers.push(h); return () => {}; } });
    const engine = instances[0];
    engine._processChunk = async () => { throw new Error('wasm blew up'); };
    await session.start();
    for (const h of [...tapHandlers]) h(new Float32Array(1280));
    await Promise.resolve();
    expect(errors).toContain('wasm blew up');
  });
});
