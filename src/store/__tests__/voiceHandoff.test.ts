import { describe, it, expect, beforeEach } from 'vitest';
import { useGiaStore } from '../useGiaStore';

/**
 * Wake→voice handoff (phase 3): the wake word's query must reach the voice
 * surface exactly once, and the setting must persist.
 */
describe('wake→voice handoff state', () => {
  beforeEach(() => {
    localStorage.removeItem('gia-wake-opens-voice');
    useGiaStore.setState({ voiceHandoff: null, wakeOpensVoice: true } as never);
  });

  it('requestVoiceHandoff stages the utterance; clearVoiceHandoff consumes it', () => {
    useGiaStore.getState().requestVoiceHandoff("what's on my plate today");
    expect(useGiaStore.getState().voiceHandoff).toEqual({ text: "what's on my plate today" });
    useGiaStore.getState().clearVoiceHandoff();
    expect(useGiaStore.getState().voiceHandoff).toBeNull();
  });

  it('a second request replaces the first (last query wins)', () => {
    useGiaStore.getState().requestVoiceHandoff('first');
    useGiaStore.getState().requestVoiceHandoff('second');
    expect(useGiaStore.getState().voiceHandoff).toEqual({ text: 'second' });
  });

  it('wakeOpensVoice persists and round-trips through the store', () => {
    useGiaStore.getState().setWakeOpensVoice(false);
    expect(localStorage.getItem('gia-wake-opens-voice')).toBe('false');
    expect(useGiaStore.getState().wakeOpensVoice).toBe(false);
    useGiaStore.getState().setWakeOpensVoice(true);
    expect(localStorage.getItem('gia-wake-opens-voice')).toBe('true');
  });
});
