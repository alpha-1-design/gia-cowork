import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * warmKokoro: the phase-4 background warm-up. Gated on the user's own
 * toggles — never loads a model for someone who did not ask for local TTS.
 * The service is injectable, so no heavyweight engine is touched here.
 */
import { warmKokoro } from '../KokoroService';

const loadModel = vi.fn(async () => undefined);
const fakeService = () => ({ isReady: false, loadModel });

beforeEach(() => {
  loadModel.mockClear();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('warmKokoro', () => {
  it('does nothing when TTS is off', async () => {
    localStorage.setItem('gia-kokoro-enabled', 'true');
    await warmKokoro(fakeService());
    expect(loadModel).not.toHaveBeenCalled();
  });

  it('does nothing when Kokoro is off', async () => {
    localStorage.setItem('gia-tts-enabled', 'true');
    await warmKokoro(fakeService());
    expect(loadModel).not.toHaveBeenCalled();
  });

  it('warms when both toggles are on', async () => {
    localStorage.setItem('gia-tts-enabled', 'true');
    localStorage.setItem('gia-kokoro-enabled', 'true');
    await warmKokoro(fakeService());
    expect(loadModel).toHaveBeenCalledTimes(1);
  });

  it('an already-ready engine is not loaded again', async () => {
    localStorage.setItem('gia-tts-enabled', 'true');
    localStorage.setItem('gia-kokoro-enabled', 'true');
    await warmKokoro({ isReady: true, loadModel });
    expect(loadModel).not.toHaveBeenCalled();
  });

  it('a warm-up failure is a log line, not a boot problem', async () => {
    localStorage.setItem('gia-tts-enabled', 'true');
    localStorage.setItem('gia-kokoro-enabled', 'true');
    loadModel.mockRejectedValueOnce(new Error('no webgpu, no patience'));
    await expect(warmKokoro(fakeService())).resolves.toBeUndefined();
  });
});
