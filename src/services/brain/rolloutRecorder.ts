/**
 * The flight recorder, installed in the plane (W13 TESTIMONY).
 *
 * `rollout.ts` could always serialize a session and `BrainExportSubPage`
 * could always write one — behind a manual button, so the record existed
 * only when someone remembered to ask for it. This module is the difference:
 * after every message lands in a session, a debounced write persists the
 * whole session to `~/gia-rollouts`. The recorder is deliberately dumb —
 * it owns WHEN (after a message, debounce, desktop only), never WHAT (the
 * serializer is pure and `rollout.ts` stays the single format authority).
 *
 * Dependency discipline: this module must not import the store. The caller
 * (useGiaStore.addMessage) hands in the session object, which keeps the
 * store → recorder edge one-way and the recorder unit-testable with plain
 * objects.
 */

import { rolloutSerialize, rolloutWrite } from './rollout';
import { isTauri } from '../../platform';

/** Trailing debounce: a streaming turn touches the store repeatedly; one write covers them. */
const DEBOUNCE_MS = 2500;

/** Minimal slice of the store's session shape the recorder needs. */
interface RecordableSession {
  id: string;
  messages: unknown[];
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule a debounced rollout write for a session. Safe to call per message:
 * the trailing timer coalesces a burst into one serialization+write. Fire the
 * returned callback only in tests — callers never need it.
 */
export function scheduleRollout(session: RecordableSession, debounceMs = DEBOUNCE_MS): void {
  if (!isTauri()) return; // web/no-shell: the write itself would no-op anyway; skip the work
  if (!session || typeof session.id !== 'string' || !session.id) return;
  const existing = timers.get(session.id);
  if (existing) clearTimeout(existing);
  timers.set(
    session.id,
    setTimeout(() => {
      timers.delete(session.id);
      void recordRolloutNow(session);
    }, debounceMs),
  );
}

/** Serialize + write immediately. Best-effort like every rollout write. */
export async function recordRolloutNow(session: RecordableSession): Promise<string | null> {
  try {
    return await rolloutWrite(session.id, rolloutSerialize(session));
  } catch {
    // The in-memory store remains the source of truth; a failed recorder
    // write is never allowed to break the turn that triggered it.
    return null;
  }
}

/** Cancel a pending write (session deleted mid-debounce). */
export function cancelScheduledRollout(sessionId: string): void {
  const t = timers.get(sessionId);
  if (t) {
    clearTimeout(t);
    timers.delete(sessionId);
  }
}
