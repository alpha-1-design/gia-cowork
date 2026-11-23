import { vi } from 'vitest';

const fakeTrack = { stop: vi.fn() };

/** Every AudioWorkletNode created while the stub is active. */
export const workletInstances: FakeWorkletNode[] = [];

class FakeWorkletNode {
  port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: vi.fn() };
  connect() { /* never wired to destination */ }
  disconnect() { /* ignore */ }
  constructor() { workletInstances.push(this); }
}

/**
 * happy-dom locks `AudioContext` as a non-configurable own global, so we do
 * NOT stub it. What we can do: attach `mediaDevices` to the live navigator
 * object and define `AudioWorkletNode` when the environment lacks it. Tests
 * needing a constructor they control use the service's own test hooks.
 */
export function stubBrowserAudio(getUserMediaFn?: (c: unknown) => Promise<unknown>): () => void {
  const gUM = getUserMediaFn ?? (async () => ({ getTracks: () => [fakeTrack] }));
  const nav = globalThis.navigator as unknown as { mediaDevices?: unknown };
  const hadMedia = 'mediaDevices' in nav;
  const prevMedia = nav.mediaDevices;
  Object.defineProperty(nav, 'mediaDevices', {
    value: { getUserMedia: gUM },
    configurable: true,
    writable: true,
  });
  const hadWorklet = typeof globalThis.AudioWorkletNode !== 'undefined';
  if (!hadWorklet) {
    Object.defineProperty(globalThis, 'AudioWorkletNode', {
      value: FakeWorkletNode,
      configurable: true,
      writable: true,
    });
  }
  return () => {
    if (hadMedia) Object.defineProperty(nav, 'mediaDevices', { value: prevMedia, configurable: true, writable: true });
    else delete (nav as Record<string, unknown>).mediaDevices;
    if (!hadWorklet) delete (globalThis as Record<string, unknown>).AudioWorkletNode;
  };
}

export { FakeWorkletNode };
