import { describe, it, expect, beforeEach } from 'vitest';
import {
  visibleMemories,
  scopeMemory,
  welcomeBack,
  checkProjectIngress,
  projectIsolationPromptBlock,
  setActiveProject,
  resetProjectContext,
  RETURN_WINDOW_MS,
  type ProjectMemory,
  type ProjectRecord,
} from '../projects/projectIsolation';

const project = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: 'p1', name: 'Alpha', path: '/work/alpha', lastSeenAt: Date.now(), restrictMemory: false, ...over,
});

const mem = (key: string, projectId: string | null): ProjectMemory => ({ key, value: key, projectId });

describe('memory scoping', () => {
  it('always shows global memories', () => {
    const all = [mem('g', null), mem('a', 'p1')];
    expect(visibleMemories(all, { projectId: 'p1', restricted: {} }).map(m => m.key)).toEqual(['g', 'a']);
  });

  it('hides another project\'s memories once that project restricts', () => {
    const all = [mem('g', null), mem('a', 'p1'), mem('b', 'p2')];
    const out = visibleMemories(all, { projectId: 'p1', restricted: { p2: true } });
    expect(out.map(m => m.key)).toEqual(['g', 'a']);
  });

  it('shows another project\'s memories when it does not restrict', () => {
    const all = [mem('a', 'p1'), mem('b', 'p2')];
    expect(visibleMemories(all, { projectId: 'p1', restricted: {} }).map(m => m.key)).toEqual(['a', 'b']);
  });

  it('shows only global memories when no project is open', () => {
    const all = [mem('g', null), mem('a', 'p1'), mem('b', 'p2')];
    expect(visibleMemories(all, { projectId: null, restricted: {} }).map(m => m.key)).toEqual(['g']);
  });

  it('always shows a project its own memories regardless of restrictions', () => {
    const all = [mem('a', 'p1')];
    expect(visibleMemories(all, { projectId: 'p1', restricted: { p1: true } }).map(m => m.key)).toEqual(['a']);
  });

  it('scopes a memory to a project or makes it global', () => {
    expect(scopeMemory({ key: 'k', value: 'v' }, 'p1').projectId).toBe('p1');
    expect(scopeMemory({ key: 'k', value: 'v' }, null).projectId).toBeNull();
  });
});

describe('welcome back', () => {
  beforeEach(() => { resetProjectContext(); });

  const now = 1_000_000_000_000;

  it('greets by name when genuinely returning', () => {
    const p = project({ lastSeenAt: now - 1000 * 60 * 60 * 3 });
    const res = welcomeBack(p, 'Kofi', now);
    expect(res.returning).toBe(true);
    expect(res.message).toContain('Welcome back Kofi');
    expect(res.message).toContain('Alpha');
    expect(res.message).toContain('3 hours ago');
  });

  it('does NOT claim a welcome back on a first visit', () => {
    // The failure this prevents: an assistant that says "welcome back" every
    // time trains the user that the phrase means nothing.
    const res = welcomeBack(project({ lastSeenAt: 0 }), 'Kofi', now);
    expect(res.returning).toBe(false);
    expect(res.message).not.toContain('Welcome back');
  });

  it('does not claim a welcome back after a long absence', () => {
    const res = welcomeBack(project({ lastSeenAt: now - (RETURN_WINDOW_MS + 1000) }), 'Kofi', now);
    expect(res.returning).toBe(false);
    expect(res.message).not.toContain('Welcome back');
  });

  it('handles a missing user name without greeting "undefined"', () => {
    const res = welcomeBack(project({ lastSeenAt: now - 60000 }), '', now);
    expect(res.message).toContain('Welcome back');
    expect(res.message).not.toContain('undefined');
  });

  it('describes gaps in human units', () => {
    const cases: [number, string][] = [
      [30_000, 'a moment ago'],
      [5 * 60_000, '5 minutes ago'],
      [1 * 3_600_000, '1 hour ago'],
      [24 * 3_600_000, 'yesterday'],
    ];
    for (const [gap, phrase] of cases) {
      expect(welcomeBack(project({ lastSeenAt: now - gap }), 'K', now).message).toContain(phrase);
    }
  });
});

describe('cross-project ingress', () => {
  const projects = [
    project({ id: 'p1', name: 'Alpha', path: '/work/alpha' }),
    project({ id: 'p2', name: 'Beta', path: '/work/beta' }),
  ];

  it('blocks a path inside another project', () => {
    const res = checkProjectIngress('/work/beta/src/index.ts', projects, { activeProjectId: 'p1' });
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('Beta');
  });

  it('allows the active project', () => {
    expect(checkProjectIngress('/work/alpha/src/index.ts', projects, { activeProjectId: 'p1' }).allowed).toBe(true);
  });

  it('allows an unrelated path, because an over-eager gate gets switched off', () => {
    expect(checkProjectIngress('/tmp/scratch.txt', projects, { activeProjectId: 'p1' }).allowed).toBe(true);
  });

  it('does not treat a sibling directory as a child', () => {
    // "/work/alpha-other" starts with "/work/alpha" as a STRING but is a
    // different directory. A prefix check without the separator says otherwise
    // and blocks the user from an entirely unrelated project.
    const list = [project({ id: 'p1', name: 'Alpha', path: '/work/alpha' })];
    expect(checkProjectIngress('/work/alpha-other/main.ts', list, { activeProjectId: null }).allowed).toBe(true);
  });

  it('allows an explicit override for a specific project', () => {
    const res = checkProjectIngress('/work/beta/src/x.ts', projects, {
      activeProjectId: 'p1', explicitlyAllowed: ['/work/beta'],
    });
    expect(res.allowed).toBe(true);
  });

  it('handles trailing slashes and backslashes consistently', () => {
    const res = checkProjectIngress('/work/beta\\src\\x.ts', [project({ id: 'p2', name: 'Beta', path: '/work/beta/' })], {
      activeProjectId: 'p1',
    });
    expect(res.allowed).toBe(false);
  });
});

describe('active project tracking', () => {
  beforeEach(() => { resetProjectContext(); });

  it('tracks the project we came from for the welcome-back', () => {
    setActiveProject('p1');
    setActiveProject('p2');
    expect(setActiveProject('p1')).toBeUndefined();
  });
});

describe('isolation prompt block', () => {
  const others = [
    project({ id: 'p1', name: 'Alpha', path: '/work/alpha' }),
    project({ id: 'p2', name: 'Beta', path: '/work/beta' }),
  ];

  it('states the boundary and names the other projects', () => {
    const block = projectIsolationPromptBlock(others[0], others);
    expect(block).toContain('Alpha');
    expect(block).toContain('Beta');
    expect(block).toMatch(/explicitly switched|off-limits/i);
  });

  it('mentions restriction only when the project restricts memory', () => {
    expect(projectIsolationPromptBlock(others[0], others)).not.toContain('Memory is restricted');
    expect(projectIsolationPromptBlock({ ...others[0], restrictMemory: true }, others))
      .toContain('Memory is restricted');
  });

  it('is empty with no active project', () => {
    expect(projectIsolationPromptBlock(null, others)).toBe('');
  });
});