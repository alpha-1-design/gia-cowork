import { describe, it, expect, beforeEach, vi } from 'vitest';

// The orb must be told when GIA starts and stops talking. This is the signal
// it was silently missing on the main chat path.
vi.mock('../KokoroService', () => ({
  default: { isReady: false, speak: vi.fn(async () => false), stop: vi.fn() },
}));
vi.mock('../LocalTTSService', () => ({
  default: { isReady: false, speak: vi.fn(async () => false) },
}));
vi.mock('@capacitor-community/text-to-speech', () => ({
  TextToSpeech: { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
}));

import TTSService from '../TTSService';

describe('TTSService speaking signal', () => {
  beforeEach(() => {
    localStorage.clear();
    TTSService.setEnabled(true);
  });

  it('notifies subscribers when speech starts and stops', async () => {
    const seen: boolean[] = [];
    const off = TTSService.onSpeakingChange(s => seen.push(s));

    await TTSService.speak('Hello there, this is a test sentence.');
    // Let the queue drain.
    await new Promise(r => setTimeout(r, 60));

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);

    off();
  });

  it('does not notify for text too short to speak', async () => {
    const seen: boolean[] = [];
    const off = TTSService.onSpeakingChange(s => seen.push(s));

    await TTSService.speak('a');
    await new Promise(r => setTimeout(r, 30));

    expect(seen).toEqual([]);
    off();
  });

  it('notifies nothing when TTS is disabled', async () => {
    TTSService.setEnabled(false);
    const seen: boolean[] = [];
    const off = TTSService.onSpeakingChange(s => seen.push(s));

    await TTSService.speak('This should never be spoken at all.');
    await new Promise(r => setTimeout(r, 30));

    expect(seen).toEqual([]);
    off();
    TTSService.setEnabled(true);
  });

  it('stops notifying after unsubscribe', async () => {
    const seen: boolean[] = [];
    const off = TTSService.onSpeakingChange(s => seen.push(s));
    off();

    await TTSService.speak('Nothing should be recorded here.');
    await new Promise(r => setTimeout(r, 40));

    expect(seen).toEqual([]);
  });

  it('reports speaking=false after an explicit stop', async () => {
    const seen: boolean[] = [];
    const off = TTSService.onSpeakingChange(s => seen.push(s));

    await TTSService.speak('A longer sentence that will still be draining.');
    await TTSService.stop();

    expect(TTSService.isSpeaking()).toBe(false);
    expect(seen[seen.length - 1]).toBe(false);
    off();
  });

  it('never leaves the flag stuck true when a listener throws', async () => {
    // A broken orb subscription must not take the TTS queue down with it.
    const good: boolean[] = [];
    const offBad = TTSService.onSpeakingChange(() => { throw new Error('bad listener'); });
    const offGood = TTSService.onSpeakingChange(s => good.push(s));

    await TTSService.speak('Robustness check, the listener above throws.');
    await new Promise(r => setTimeout(r, 60));

    expect(good.length).toBeGreaterThan(0);
    expect(TTSService.isSpeaking()).toBe(false);

    offBad();
    offGood();
  });

  it('does not re-notify when the state has not actually changed', async () => {
    const seen: boolean[] = [];
    const off = TTSService.onSpeakingChange(s => seen.push(s));

    await TTSService.stop();
    await TTSService.stop();

    // stop() when already silent must not spam the orb.
    expect(seen).toEqual([]);
    off();
  });
});