import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The one-mic contract: startMicTap() hands out references to ONE capture and
 * stopMicTap() releases a reference — the stream tears down only when the
 * last consumer lets go. VoiceSession and the wake-word listener both live by
 * this rule.
 */
import { startMicTap, stopMicTap, __micTapReset, __micTapTestHooks, type MicTap } from '../micTap';
import { stubBrowserAudio, workletInstances } from '../../__tests__/browserAudioStub';

class FakeWorkletNode {
  port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: vi.fn() };
  connect() { /* sink-less tap never connects to destination */ }
  disconnect() { /* ignore */ }
  instances: FakeWorkletNode[] = [];
  static all: FakeWorkletNode[] = [];
  constructor() { FakeWorkletNode.all.push(this); }
}

class FakeAudioContext {
  sampleRate = 16000;
  state = 'running' as 'running' | 'closed';
  audioWorklet = { addModule: vi.fn(async () => {}) };
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
  async close() { this.state = 'closed'; }
}

const liveInstances: FakeWorkletNode[] = [];

const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));

let restoreBrowser: () => void;

beforeEach(() => {
  __micTapReset();
  FakeWorkletNode.all.length = 0;
  workletInstances.length = 0;
  getUserMedia.mockClear();
  restoreBrowser = stubBrowserAudio(getUserMedia as unknown as (c: unknown) => Promise<unknown>);
  __micTapTestHooks.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
  __micTapTestHooks.AudioWorkletNode = FakeWorkletNode as unknown as typeof AudioWorkletNode;
});

afterEach(() => {
  restoreBrowser();
  __micTapReset();
  delete __micTapTestHooks.AudioContext;
  delete __micTapTestHooks.AudioWorkletNode;
});

describe('micTap one-mic refcount', () => {
  it('two consumers share ONE capture, not two', async () => {
    const a: MicTap = await startMicTap();
    const b: MicTap = await startMicTap();
    expect(a).toBe(b);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('one consumer stopping leaves the stream alive for the other', async () => {
    const a: MicTap = await startMicTap();
    await startMicTap();
    await stopMicTap(); // a lets go
    expect(a.isRunning).toBe(true); // still alive for consumer two
    await stopMicTap(); // last one out
    expect(a.isRunning).toBe(false);
  });

  it('frames reach every subscriber through the shared tap', async () => {
    const tap: MicTap = await startMicTap();
    const seenA: number[] = [];
    const seenB: number[] = [];
    const offA = tap.onFrame((f) => { seenA.push(f.length); });
    tap.onFrame((f) => { seenB.push(f.length); });

    // The worklet delivers a 1280-sample frame.
    FakeWorkletNode.all[0].port.onmessage?.({ data: new Float32Array(1280) });
    expect(seenA).toEqual([1280]);
    expect(seenB).toEqual([1280]);

    offA();
    FakeWorkletNode.all[0].port.onmessage?.({ data: new Float32Array(1280) });
    expect(seenA.length).toBe(1); // unsubscribed
    expect(seenB.length).toBe(2); // still listening
  });

  it('a failed start does not leak a reference', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('NotAllowedError'));
    await expect(startMicTap()).rejects.toThrow('NotAllowedError');
    // A later start begins fresh and works.
    const tap: MicTap = await startMicTap();
    expect(tap.isRunning).toBe(true);
    await stopMicTap();
    expect(tap.isRunning).toBe(false);
  });

  it('malformed frames are dropped, well-formed frames flow', async () => {
    const tap: MicTap = await startMicTap();
    const seen: number[] = [];
    tap.onFrame((f) => { seen.push(f.length); });
    FakeWorkletNode.all[0].port.onmessage?.({ data: new Float32Array(99) }); // wrong size
    FakeWorkletNode.all[0].port.onmessage?.({ data: 'not audio' }); // wrong type
    FakeWorkletNode.all[0].port.onmessage?.({ data: new Float32Array(1280) });
    expect(seen).toEqual([1280]);
  });

  it('uses the shared tap without opening a second stream mid-flight', async () => {
    await startMicTap();
    const before = getUserMedia.mock.calls.length;
    await startMicTap(); // concurrent-ish second consumer
    expect(getUserMedia.mock.calls.length).toBe(before);
    await stopMicTap();
    await stopMicTap();
  });
});

