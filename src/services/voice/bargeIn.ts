/**
 * bargeIn — the escalation ladder for user speech while GIA is busy
 * (wave-1 §3 layer 3 + live-architecture §3).
 *
 * Three situations, three different consequences:
 *
 *   mouth speaking → ONLY trusted keywords ("stop", "quiet", "wait")
 *                    interrupt immediately. AEC can't be trusted to keep her
 *                    own voice out of the mic, so any other content heard
 *                    during playback is parked in a pending queue and
 *                    delivered as the next turn AFTER she finishes talking.
 *   hands working (mouth quiet) → the utterance becomes a STEERING note:
 *                    a mid-task correction lands at the next tool-group
 *                    boundary via the existing steering rail.
 *   idle → ordinary new turn (the normal capture path, not this gate).
 *
 * The keyword decision is pure and synchronous — fully unit-testable; the
 * transcribed-text routing is exercised through VoiceSession.
 */

export const BARGE_IN_KEYWORDS = ['stop', 'quiet', 'shush', 'silence', 'wait', 'hold on', 'never mind'] as const;

export type GatedAction =
  | { action: 'interrupt'; keyword: string }
  | { action: 'steer'; text: string }
  | { action: 'park'; text: string }
  | { action: 'ignore'; reason: string };

/** Normalize a transcript for keyword matching (words only, lowercase). */
export function normalizeUtterance(text: string): string {
  return text.toLowerCase().replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isStopKeyword(text: string): string | null {
  const norm = normalizeUtterance(text);
  if (!norm) return null;
  // The whole utterance must be (essentially) the keyword — "stop" stops,
  // but "stop at the store" is content.
  for (const kw of BARGE_IN_KEYWORDS) {
    if (norm === kw || norm === `${kw} gia` || norm === `gia ${kw}`) return kw;
  }
  return null;
}

/** Which action does an endpointed utterance take in the given phase? */
export function routeUtterance(
  text: string,
  phase: 'listening' | 'capturing' | 'transcribing' | 'thinking' | 'speaking',
): GatedAction {
  const clean = text.trim();
  if (!clean) return { action: 'ignore', reason: 'empty' };

  const keyword = isStopKeyword(clean);
  if (keyword) {
    // Keywords interrupt in ANY busy phase — that is their whole job.
    if (phase === 'speaking' || phase === 'thinking' || phase === 'transcribing') {
      return { action: 'interrupt', keyword };
    }
    // Idle/capturing: "stop" with nothing to stop is content-free noise.
    return { action: 'ignore', reason: 'nothing-to-stop' };
  }

  switch (phase) {
    case 'thinking':
      // She is working with her mouth shut — safe to correct mid-task.
      return { action: 'steer', text: clean };
    case 'speaking':
      // She is talking through speakers; non-keyword speech may be her own
      // echo. Park it — delivered after playback, never trusted mid-speech.
      return { action: 'park', text: clean };
    default:
      return { action: 'ignore', reason: 'not-busy' };
  }
}
