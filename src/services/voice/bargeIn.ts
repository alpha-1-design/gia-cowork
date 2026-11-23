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

/** Spoken undo — routes to FileSnapshots.revert, not to the model. */
export const REVERT_KEYWORDS = ['undo that', 'undo', 'revert that', 'take it back', 'take that back', 'put it back', 'put that back', 'rollback'] as const;

/**
 * Spoken answers to a permission prompt. Exact whole-utterance matches only:
 * her own spoken prompt contains these words ("say do it, or say no"), and
 * only a whole-utterance rule keeps her echo from answering herself.
 */
export const APPROVAL_PHRASES = ['do it', 'yes', 'yes please', 'go ahead', 'approve', 'approve it', 'allow it', 'allow', 'do it gia', 'yes gia', 'sounds good', 'ok do it'] as const;
export const DENY_PHRASES = ['no', 'deny', 'deny it', "don't", 'do not', 'no gia', "don't do it", 'no thanks', 'nope', 'block it'] as const;

export type GatedAction =
  | { action: 'interrupt'; keyword: string }
  | { action: 'steer'; text: string }
  | { action: 'park'; text: string }
  | { action: 'revert' }
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

/** A spoken undo — the whole utterance must be the phrase, not contain it. */
export function isRevertPhrase(text: string): boolean {
  const norm = normalizeUtterance(text);
  if (!norm) return false;
  return REVERT_KEYWORDS.some((kw) => norm === kw || norm === `${kw} gia` || norm === `gia ${kw}`);
}

/** 'approve' | 'deny' | null — whole-utterance match against the whitelists. */
export function gateAnswer(text: string): 'approve' | 'deny' | null {
  const norm = normalizeUtterance(text);
  if (!norm) return null;
  if (APPROVAL_PHRASES.some((p) => norm === p)) return 'approve';
  if (DENY_PHRASES.some((p) => norm === p)) return 'deny';
  return null;
}

/** The spoken ask: headline + the answer vocabulary, kept short. */
export function spokenGatePrompt(toolName: string, headline: string, risk: string): string {
  const voiceAsk = risk === 'high' || risk === 'critical' || risk === 'moderate'
    ? 'This one needs the card on screen — I cannot take a spoken yes for it.'
    : 'Say do it, or say no.';
  return `Permission: ${toolName}. ${headline} ${voiceAsk}`;
}

/** Which action does an endpointed utterance take in the given phase? */
export function routeUtterance(
  text: string,
  phase: 'listening' | 'capturing' | 'transcribing' | 'thinking' | 'speaking',
): GatedAction {
  const clean = text.trim();
  if (!clean) return { action: 'ignore', reason: 'empty' };

  // Spoken undo works in every phase — it acts on the last completed write,
  // never on work in flight, so there is nothing to race.
  if (isRevertPhrase(clean)) return { action: 'revert' };

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
