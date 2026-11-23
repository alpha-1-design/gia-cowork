import { fileSnapshots, type FileSnapshot } from './FileSnapshots';

/**
 * Time-travel helpers — the pure core of the scrubber.
 *
 * FileSnapshots stores every write GIA made as a seq-ordered entry with the
 * content before and after. That ring already contains every past state of
 * every file; what it lacks is the two questions the scrubber answers:
 *
 *   1. "What did the workspace look like after write N?" (stateAt)
 *   2. "What was she working on when this happened?" (alignToMessages)
 *
 * Everything here is pure over plain arrays so it is trivially testable —
 * the panel supplies FileSnapshots.list() and the session's messages.
 *
 * Revert semantics (the honest kind): "back to here" reverts every pending
 * snapshot AFTER the chosen step, newest first, exactly like the Undo page's
 * revertAll — overlapping writes unwind cleanly. It never invents content
 * that was never captured.
 */

export interface TimelineStep {
  /** Chronological index (0 = oldest write). */
  index: number;
  snapshot: FileSnapshot;
}

/** Chronological (oldest first) timeline from the newest-first snapshot list. */
export function buildTimeline(snapshots: FileSnapshot[]): TimelineStep[] {
  return [...snapshots]
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    .map((snapshot, index) => ({ index, snapshot }));
}

/** Per-path state as of chronological step N (inclusive). */
export interface PathState {
  path: string;
  /** Content of the file as of this step; null = created by a later write. */
  content: string | null;
  /** The snapshot that produced this state (null = file did not exist yet). */
  snapshot: FileSnapshot | null;
  /** True when the file was created at or before step N. */
  exists: boolean;
}

export function stateAt(timeline: TimelineStep[], stepIndex: number): PathState[] {
  const byPath = new Map<string, PathState>();
  for (let i = 0; i <= stepIndex && i < timeline.length; i++) {
    const { snapshot } = timeline[i];
    byPath.set(snapshot.path, {
      path: snapshot.path,
      content: snapshot.newContent,
      snapshot,
      exists: true,
    });
  }
  // Paths written AFTER this step: report as "not yet" — honest absence.
  for (let i = stepIndex + 1; i < timeline.length; i++) {
    const { snapshot } = timeline[i];
    if (!byPath.has(snapshot.path)) {
      byPath.set(snapshot.path, { path: snapshot.path, content: null, snapshot: null, exists: false });
    }
  }
  return [...byPath.values()];
}

/** Summarised line-diff between a snapshot's previous and new content. */
export function diffCounts(previousContent: string | null, newContent: string): { additions: number; deletions: number } {
  if (previousContent === null) {
    return { additions: newContent ? newContent.split('\n').length : 0, deletions: 0 };
  }
  const count = (lines: string[]) => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const prev = count(previousContent.split('\n'));
  const next = count(newContent.split('\n'));
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of next) {
    const p = prev.get(line) ?? 0;
    if (n > p) additions += n - p;
  }
  for (const [line, p] of prev) {
    const n = next.get(line) ?? 0;
    if (p > n) deletions += p - n;
  }
  return { additions, deletions };
}

/** Minimal message shape the alignment needs (store messages carry timestamps). */
export interface AlignableMessage {
  timestamp: number;
  text?: string;
  content?: string;
  role?: string;
  isUser?: boolean;
}

export interface Alignment {
  step: TimelineStep;
  /** The user's most recent ask at or before the write, or null. */
  prompt: string | null;
}

/** "What was she working on?" — nearest user message at or before each write. */
export function alignToMessages(timeline: TimelineStep[], messages: AlignableMessage[]): Alignment[] {
  const sorted = [...messages]
    .filter(m => typeof m.timestamp === 'number')
    .sort((a, b) => a.timestamp - b.timestamp);
  return timeline.map((step) => {
    let prompt: string | null = null;
    for (const m of sorted) {
      if (m.timestamp > step.snapshot.timestamp) break;
      const text = m.text ?? m.content ?? '';
      if (typeof text === 'string' && text.trim()) prompt = text;
    }
    return { step, prompt };
  });
}

/**
 * Roll the workspace back to chronological step N: revert every PENDING
 * snapshot after it, newest first, through the normal FileSnapshots rail.
 * Reverted snapshots are skipped (they are already unwound). Returns counts.
 */
export async function revertToStep(
  timeline: TimelineStep[],
  stepIndex: number,
): Promise<{ reverted: number; failed: number }> {
  let reverted = 0;
  let failed = 0;
  const after = timeline
    .filter(s => s.index > stepIndex && !s.snapshot.reverted)
    .sort((a, b) => (b.snapshot.seq || 0) - (a.snapshot.seq || 0)); // newest first
  for (const s of after) {
    const res = await fileSnapshots.revert(s.snapshot.id);
    if (res.success) reverted++;
    else failed++;
  }
  return { reverted, failed };
}
