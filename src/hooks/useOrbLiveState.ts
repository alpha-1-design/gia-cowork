import { useSyncExternalStore } from 'react';
import { useGiaStore } from '../store/useGiaStore';
import { voiceSession } from '../services/voice/VoiceSession';
import type { VoiceSnapshot } from '../services/voice/VoiceSession';

/**
 * useOrbLiveState — the orb as a status light.
 *
 * Maps ONLY real conditions to orb tempo, never moods: thinking while a
 * generation runs, speaking while her TTS is actually playing, idle
 * otherwise. Every state has a backing fact; nothing is decorative. The
 * idle case is deliberately the slow, dim default the app already had.
 */
export type OrbLiveState = 'idle' | 'thinking' | 'speaking';

const IDLE_SNAPSHOT: VoiceSnapshot = {
  phase: 'idle', error: null, activity: null, working: false, caption: null,
  stt: 'unloaded', vad: null,
};

export function computeOrbLiveState(generationActive: boolean, snapshot: VoiceSnapshot | null): OrbLiveState {
  if (snapshot?.phase === 'speaking') return 'speaking';
  if (generationActive) return 'thinking';
  return 'idle';
}

/** Breath tempo per state (seconds) — idle keeps the app's existing 2.8s. */
export const ORB_TEMPO: Record<OrbLiveState, number> = {
  idle: 2.8,
  thinking: 1.4,
  speaking: 0.9,
};

export function useOrbLiveState(): OrbLiveState {
  const generationActive = useGiaStore(s => s.generationState.active);
  const snapshot = useSyncExternalStore(
    (cb) => voiceSession.subscribe(() => cb()),
    () => voiceSession.getSnapshot(),
    () => IDLE_SNAPSHOT,
  );
  return computeOrbLiveState(generationActive, snapshot);
}
