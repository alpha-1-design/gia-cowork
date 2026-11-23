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

describe('voice-parked queue hold (barge-in handshake)', () => {
  const store = () => useGiaStore.getState();
  beforeEach(() => {
    useGiaStore.setState({ queuedMessages: [] } as never);
  });

  it('releaseHeldQueues un-holds only this session\'s held items; drain-time guard semantics live in the hook', () => {
    store().enqueueMessage({ id: 'q1', sessionId: 's1', text: 'first', attachments: [], queuedAt: 1, holdForVoice: true });
    store().enqueueMessage({ id: 'q2', sessionId: 's2', text: 'other chat', attachments: [], queuedAt: 2, holdForVoice: true });
    store().enqueueMessage({ id: 'q3', sessionId: 's1', text: 'typed normally', attachments: [], queuedAt: 3 });

    store().releaseHeldQueues('s1');
    const after = store().queuedMessages;
    expect(after.find(m => m.id === 'q1')?.holdForVoice).toBe(false); // released
    expect(after.find(m => m.id === 'q2')?.holdForVoice).toBe(true); // another chat, still held
    expect(after.find(m => m.id === 'q3')?.holdForVoice).toBeUndefined(); // untouched

    store().releaseHeldQueues(); // no session = release everything held
    expect(store().queuedMessages.every(m => !m.holdForVoice)).toBe(true);
  });

  it('held items are not drained as ordinary sends — dequeue still works for released ones', () => {
    store().enqueueMessage({ id: 'q1', sessionId: 's1', text: 'held', attachments: [], queuedAt: 1, holdForVoice: true });
    expect(store().queuedMessages[0].holdForVoice).toBe(true);
    store().releaseHeldQueues('s1');
    expect(store().dequeueMessage('q1')?.text).toBe('held');
    expect(store().queuedMessages).toHaveLength(0);
  });
});
