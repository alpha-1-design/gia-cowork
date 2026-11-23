import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeOrbLiveState, ORB_TEMPO } from '../useOrbLiveState';
import type { VoiceSnapshot } from '../../services/voice/VoiceSession';

/**
 * The orb is a status light: its tempo maps ONLY to real conditions.
 * thinking = a generation is running; speaking = her TTS is playing;
 * idle otherwise. Every state has a backing fact — nothing decorative.
 */
const snap = (over: Partial<VoiceSnapshot>): VoiceSnapshot => ({
  phase: 'idle', error: null, activity: null, working: false, caption: null,
  stt: 'unloaded', vad: null,
  ...over,
});

describe('orb live state', () => {
  it('speaking wins while her TTS plays, even if a generation also runs', () => {
    expect(computeOrbLiveState(true, snap({ phase: 'speaking' }))).toBe('speaking');
  });

  it('thinking maps to an active generation', () => {
    expect(computeOrbLiveState(true, snap({ phase: 'listening' }))).toBe('thinking');
  });

  it('idle is the default with no backing activity', () => {
    expect(computeOrbLiveState(false, snap({ phase: 'listening' }))).toBe('idle');
    expect(computeOrbLiveState(false, null)).toBe('idle');
  });

  it('each state has a distinct breath tempo (they must be tellable apart)', () => {
    const tempos = [ORB_TEMPO.idle, ORB_TEMPO.thinking, ORB_TEMPO.speaking];
    expect(new Set(tempos).size).toBe(3);
    expect(ORB_TEMPO.idle).toBeGreaterThan(ORB_TEMPO.speaking);
  });
});
