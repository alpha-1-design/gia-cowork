import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildTimeline, stateAt, diffCounts, alignToMessages, revertToStep, type AlignableMessage } from '../timetravel';
import type { FileSnapshot } from '../FileSnapshots';

/**
 * The scrubber's pure core: timeline construction, workspace state at a
 * step, message alignment, and the revert-range semantics (newest first,
 * pending only, through the FileSnapshots rail).
 */

const snap = (over: Partial<FileSnapshot>): FileSnapshot => ({
  id: over.id ?? `s${over.seq ?? 0}`,
  path: over.path ?? 'a.txt',
  previousContent: over.previousContent ?? null,
  newContent: over.newContent ?? 'x',
  timestamp: over.timestamp ?? 1000,
  seq: over.seq ?? 0,
  source: 'filesystem_write',
  reverted: over.reverted ?? false,
});

afterEach(() => { vi.restoreAllMocks(); });

describe('buildTimeline', () => {
  it('sorts by seq, oldest first, regardless of input order', () => {
    const timeline = buildTimeline([snap({ seq: 3 }), snap({ seq: 1 }), snap({ seq: 2 })]);
    expect(timeline.map(t => t.snapshot.seq)).toEqual([1, 2, 3]);
    expect(timeline[0].index).toBe(0);
  });

  it('empty history gives an empty timeline', () => {
    expect(buildTimeline([])).toEqual([]);
  });
});

describe('stateAt', () => {
  const tl = buildTimeline([
    snap({ seq: 1, path: 'a.ts', newContent: 'v1' }),
    snap({ seq: 2, path: 'b.ts', newContent: 'b1' }),
    snap({ seq: 3, path: 'a.ts', newContent: 'v2' }),
  ]);

  it('before any write: everything is absent, honestly', () => {
    const state = stateAt(tl, -1);
    expect(state.map(p => p.path).sort()).toEqual(['a.ts', 'b.ts']);
    expect(state.every(p => !p.exists && p.content === null)).toBe(true);
  });

  it('after write 2: a.ts v1, b.ts created', () => {
    const state = stateAt(tl, 1);
    const a = state.find(p => p.path === 'a.ts')!;
    const b = state.find(p => p.path === 'b.ts')!;
    expect(a.content).toBe('v1');
    expect(b.content).toBe('b1');
  });

  it('after write 3: a.ts has the NEWEST content at or before the step', () => {
    const state = stateAt(tl, 2);
    expect(state.find(p => p.path === 'a.ts')!.content).toBe('v2');
  });
});

describe('alignToMessages', () => {
  const tl = buildTimeline([
    snap({ seq: 1, timestamp: 2000 }),
    snap({ seq: 2, timestamp: 8000 }),
  ]);

  it('attaches the most recent user ask at or before each write', () => {
    const messages: AlignableMessage[] = [
      { timestamp: 1000, text: 'build the login page' },
      { timestamp: 5000, text: 'add dark mode' },
    ];
    const al = alignToMessages(tl, messages);
    expect(al[0].prompt).toBe('build the login page');
    expect(al[1].prompt).toBe('add dark mode');
  });

  it('writes before any message align to null (never invent an ask)', () => {
    // A message at 7500 lands before the second write (8000) but after the
    // first (2000) — alignment follows the clock, never the future.
    const al = alignToMessages(tl, [{ timestamp: 7500, text: 'mid ask' }, { timestamp: 9000, text: 'later ask' }]);
    expect(al[0].prompt).toBeNull();
    expect(al[1].prompt).toBe('mid ask');
  });
});

describe('diffCounts', () => {
  it('counts a file creation as all additions', () => {
    expect(diffCounts(null, 'a\nb\nc')).toEqual({ additions: 3, deletions: 0 });
  });

  it('counts edits on both sides', () => {
    expect(diffCounts('a\nb\nc', 'a\nx\nc')).toEqual({ additions: 1, deletions: 1 });
  });
});

describe('revertToStep', () => {
  it('reverts every pending snapshot after the step, newest first, via FileSnapshots', async () => {
    const tl = buildTimeline([
      snap({ seq: 1, id: 's1' }),
      snap({ seq: 2, id: 's2' }),
      snap({ seq: 3, id: 's3' }),
      snap({ seq: 4, id: 's4' }),
    ]);
    const revertOrder: string[] = [];
    const mod = await import('../FileSnapshots');
    vi.spyOn(mod.fileSnapshots, 'revert').mockImplementation(async (id: string) => {
      revertOrder.push(id);
      return { success: true };
    });

    const res = await revertToStep(tl, 1); // back to after write 2
    expect(res).toEqual({ reverted: 2, failed: 0 }); // s3 + s4 unwind; s1, s2 stay
    expect(revertOrder).toEqual(['s4', 's3']); // newest first
    expect(revertOrder).not.toContain('s1'); // the chosen step itself is kept
  });

  it('skips already-reverted snapshots and counts failures without stopping', async () => {
    const tl = buildTimeline([
      snap({ seq: 1, id: 's1' }),
      snap({ seq: 2, id: 's2', reverted: true }),
      snap({ seq: 3, id: 's3' }),
      snap({ seq: 4, id: 's4' }),
    ]);
    const mod = await import('../FileSnapshots');
    const spy = vi.spyOn(mod.fileSnapshots, 'revert')
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'disk full' });

    const res = await revertToStep(tl, 0); // pending after step 0: s3, s4 (s2 already unwound)
    expect(res).toEqual({ reverted: 1, failed: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith('s4');
  });
});
