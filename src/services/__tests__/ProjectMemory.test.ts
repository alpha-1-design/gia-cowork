import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useProjectMemoryStore, renderMemoryForPrompt, MAX_MEMORY_CHARS, type ProjectMemoryEntry } from '../ProjectMemory';

const base = { project: 'app', paths: [] as string[] };

function reset() {
  useProjectMemoryStore.setState({ entries: [] });
}

describe('ProjectMemory store', () => {
  beforeEach(reset);

  it('records an entry with timestamps', () => {
    const e = useProjectMemoryStore.getState().add({
      ...base, kind: 'gotcha', title: 'Relay is HTTP only', body: 'The dev relay does not speak websockets.',
    });
    expect(e.id).toBeTruthy();
    expect(e.createdAt).toBeGreaterThan(0);
    expect(e.kind).toBe('gotcha');
    expect(useProjectMemoryStore.getState().entries).toHaveLength(1);
  });

  it('updates in place rather than duplicating the same kind+title', () => {
    const s = () => useProjectMemoryStore.getState();
    s().add({ ...base, kind: 'gotcha', title: 'Relay is HTTP only', body: 'First version.' });
    s().add({ ...base, kind: 'gotcha', title: 'relay is http only', body: 'Sharper second version.' });

    // Case-insensitive: the second sighting of a gotcha should sharpen it,
    // not start a new row that buries the first.
    expect(s().entries).toHaveLength(1);
    expect(s().entries[0].body).toBe('Sharper second version.');
  });

  it('keeps the same title when the kind differs', () => {
    const s = () => useProjectMemoryStore.getState();
    s().add({ ...base, kind: 'gotcha', title: 'Zustand', body: 'a' });
    s().add({ ...base, kind: 'decision', title: 'Zustand', body: 'b' });
    // A decision and a gotcha about the same thing are different knowledge.
    expect(s().entries).toHaveLength(2);
  });

  it('keeps notes for different projects apart', () => {
    const s = () => useProjectMemoryStore.getState();
    s().add({ ...base, kind: 'gotcha', title: 'A', body: 'a' });
    s().add({ project: 'other', kind: 'gotcha', title: 'B', body: 'b' });

    expect(s().list('app')).toHaveLength(1);
    expect(s().list('other')).toHaveLength(1);
    // A gotcha from one codebase must never surface in another.
    expect(s().list('app')[0].title).toBe('A');
  });

  it('lists most recently updated first', () => {
    const s = () => useProjectMemoryStore.getState();
    s().add({ ...base, kind: 'decision', title: 'first', body: 'a' });
    s().add({ ...base, kind: 'decision', title: 'second', body: 'b' });
    s().add({ ...base, kind: 'decision', title: 'first', body: 'updated' });

    expect(s().list('app')[0].title).toBe('first');
  });

  it('orders correctly when several notes share one timestamp', () => {
    // Regression: same-millisecond writes made updatedAt tie, so the sort fell
    // back to insertion order and surfaced the OLDER note first.
    const fixedNow = 1_700_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      const s = () => useProjectMemoryStore.getState();
      s().add({ ...base, kind: 'decision', title: 'alpha', body: 'a' });
      s().add({ ...base, kind: 'decision', title: 'beta', body: 'b' });
      s().add({ ...base, kind: 'decision', title: 'gamma', body: 'c' });
      s().add({ ...base, kind: 'decision', title: 'alpha', body: 'a2' });

      expect(s().list('app').map(e => e.title)).toEqual(['alpha', 'gamma', 'beta']);
    } finally {
      spy.mockRestore();
    }
  });

  it('orders correctly for entries persisted before seq existed', () => {
    // Legacy rows have no seq; the timestamp fallback must still not crash.
    useProjectMemoryStore.setState({
      entries: [
        mk({ id: 'l1', title: 'old', updatedAt: 1 }),
        mk({ id: 'l2', title: 'new', updatedAt: 2 }),
      ],
    });
    expect(useProjectMemoryStore.getState().list('app').map(e => e.title)).toEqual(['new', 'old']);
  });

  it('removes a single entry', () => {
    const s = () => useProjectMemoryStore.getState();
    const e = s().add({ ...base, kind: 'todo', title: 'parked', body: 'later' });
    s().remove(e.id);
    expect(s().entries).toHaveLength(0);
  });

  it('clears only the named project', () => {
    const s = () => useProjectMemoryStore.getState();
    s().add({ ...base, kind: 'todo', title: 'a', body: 'a' });
    s().add({ project: 'other', kind: 'todo', title: 'b', body: 'b' });
    s().clearProject('app');
    expect(s().entries).toHaveLength(1);
    expect(s().entries[0].project).toBe('other');
  });
});

function mk(over: Partial<ProjectMemoryEntry> = {}): ProjectMemoryEntry {
  return {
    id: 'x', project: 'app', kind: 'gotcha', title: 't', body: 'b', paths: [],
    createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('renderMemoryForPrompt', () => {
  it('renders nothing when there are no entries', () => {
    expect(renderMemoryForPrompt([])).toBe('');
  });

  it('groups by kind and labels each group', () => {
    const out = renderMemoryForPrompt([
      mk({ kind: 'gotcha', title: 'HTTP only' }),
      mk({ kind: 'decision', title: 'Polling' }),
    ]);
    expect(out).toContain('### Gotchas');
    expect(out).toContain('### Decisions');
    expect(out).toContain('HTTP only');
    expect(out).toContain('Polling');
  });

  it('puts gotchas first, because that is what prevents repeat mistakes', () => {
    const out = renderMemoryForPrompt([
      mk({ kind: 'todo', title: 'TASKLIST' }),
      mk({ kind: 'decision', title: 'DECISION' }),
      mk({ kind: 'gotcha', title: 'GOTCHA' }),
    ]);
    expect(out.indexOf('GOTCHA')).toBeLessThan(out.indexOf('DECISION'));
    expect(out.indexOf('DECISION')).toBeLessThan(out.indexOf('TASKLIST'));
  });

  it('includes paths so a note is recalled when that file is touched', () => {
    const out = renderMemoryForPrompt([mk({ paths: ['src/relay/index.ts'] })]);
    expect(out).toContain('src/relay/index.ts');
  });

  it('tells her to record more', () => {
    const out = renderMemoryForPrompt([mk()]);
    expect(out).toContain('project_memory');
  });

  it('skips an empty kind group', () => {
    const out = renderMemoryForPrompt([mk({ kind: 'gotcha' })]);
    expect(out).not.toContain('### Parked work');
  });

  it('caps the injected size so memory cannot crowd out the conversation', () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      mk({ id: `e${i}`, title: `Gotcha ${i}`, body: 'x'.repeat(200) }),
    );
    const out = renderMemoryForPrompt(many);
    expect(out.length).toBeLessThan(MAX_MEMORY_CHARS + 1500);
    // Still useful — the cap truncates, it does not blank it.
    expect(out).toContain('Gotcha 0');
  });

  it('does not emit an empty heading when everything was cut by the cap', () => {
    const huge = Array.from({ length: 5 }, (_, i) => mk({ id: `h${i}`, body: 'y'.repeat(5000) }));
    const out = renderMemoryForPrompt(huge);
    expect(out).not.toContain('### Gotchas\n\n');
  });
});