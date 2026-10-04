import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useProjectStore } from '../../store/useProjectStore';
import { useProjectContextStore } from '../../store/useProjectContextStore';
import { useProjectMemoryStore } from '../ProjectMemory';
import { resetProjectContext, pathArgsOf } from '../projects/projectIsolation';
import { projectIdFor, projectNameFor, syncActiveProject, welcomeForSwitch, guardPath } from '../projects/projectSync';
import { setShell } from '../agents/peerAgents';
import { buildGiaSystem, warmPeerAgentDetection } from '../buildGiaSystem';

/**
 * Prompt wiring.
 *
 * These exist because both features looked finished and were invisible in the
 * one place that matters. The peer block was a module-level `const` evaluated
 * at import — before detection could possibly run — and project notes were
 * sliced from every project at once under a heading that claimed they belonged
 * to this one. Both passed every unit test on the helpers they called.
 *
 * So these assert on the assembled prompt, not on the functions.
 */

/**
 * `buildGiaSystem` reads several stores. These are the minimum a real prompt
 * build needs; the project stores are deliberately NOT mocked, because what is
 * under test is how the real ones feed the prompt.
 */
const mockProviderState = {
  activeProvider: 'openai',
  providers: { openai: { enabled: true, apiKey: 'sk-test', model: 'gpt-4o' } },
  availableModels: { openai: [{ id: 'gpt-4o', label: 'GPT-4o', free: false, tools: true, vision: true, context: { length: 128000 } }] },
};

vi.mock('../../store/useProviderStore', () => ({
  useProviderStore: { getState: vi.fn(() => mockProviderState) },
}));

vi.mock('../../store/useMemoryStore', () => ({
  useMemoryStore: {
    getState: vi.fn(() => ({ memories: [], getRelevantContext: () => '', getCoreContext: () => '' })),
  },
}));

vi.mock('../../store/useGiaStore', () => ({
  useGiaStore: {
    getState: vi.fn(() => ({
      userProfile: { name: '', bio: '', goals: '' },
      activeSkillId: null,
      skills: [],
      customInstructions: '',
      pinnedMemories: [],
      handsOff: false,
      localTranslate: false,
      sharedData: {},
      sessions: [],
      activeSessionId: null,
      thinkingLevel: 'medium',
      systemCompliance: true,
    })),
  },
}));

vi.mock('../../utils/helpers', () => ({ isNativePlatform: vi.fn(() => false) }));

const ALPHA = '/work/alpha';
const BETA = '/work/beta';

function record(id: string, name: string, path: string, lastSeenAt: number) {
  return { id, name, path, lastSeenAt, restrictMemory: false };
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], activeProjectId: null });
  useProjectContextStore.setState({ entry: null });
  resetProjectContext();
});

afterEach(() => {
  useProjectStore.setState({ projects: [], activeProjectId: null });
  useProjectContextStore.setState({ entry: null });
  resetProjectContext();
});

describe('project identity', () => {
  it('gives the same directory the same id across restarts', () => {
    // A generated uuid per visit would make every launch look like a new
    // project, and "welcome back" could never fire.
    expect(projectIdFor(ALPHA)).toBe(projectIdFor(`${ALPHA}/`));
    expect(projectIdFor(ALPHA)).not.toBe(projectIdFor(BETA));
  });

  it('names a project after its directory', () => {
    expect(projectNameFor('/work/alpha/')).toBe('alpha');
  });
});

describe('syncActiveProject', () => {
  it('registers the open project and makes it active', () => {
    useProjectContextStore.setState({
      entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 },
    });
    syncActiveProject(1000);

    const s = useProjectStore.getState();
    expect(s.projects).toHaveLength(1);
    expect(s.projects[0].path).toBe(ALPHA);
    expect(s.activeProjectId).toBe(projectIdFor(ALPHA));
  });

  it('accumulates projects rather than replacing them', () => {
    // Without this there is never more than one project on record, so there is
    // never a boundary — which is the entire point of the feature.
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });
    syncActiveProject(1000);
    useProjectContextStore.setState({ entry: { path: BETA, projectName: 'Beta', markdown: '', updatedAt: 1 } });
    syncActiveProject(2000);

    expect(useProjectStore.getState().projects.map(p => p.path)).toEqual([BETA, ALPHA]);
    expect(useProjectStore.getState().activeProjectId).toBe(projectIdFor(BETA));
  });

  it('is idempotent, so repeated syncs do not duplicate the record', () => {
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });
    syncActiveProject(1000);
    syncActiveProject(1100);
    syncActiveProject(1200);
    expect(useProjectStore.getState().projects).toHaveLength(1);
  });

  it('preserves the memory restriction across visits', () => {
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });
    syncActiveProject(1000);
    useProjectStore.getState().patch(projectIdFor(ALPHA), { restrictMemory: true });

    syncActiveProject(2000);
    expect(useProjectStore.getState().projects[0].restrictMemory).toBe(true);
  });

  it('clears the active project when no project is open', () => {
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });
    syncActiveProject(1000);
    useProjectContextStore.setState({ entry: null });
    expect(syncActiveProject(2000)).toBeNull();
    expect(useProjectStore.getState().activeProjectId).toBeNull();
  });
});

describe('welcome back', () => {
  it('greets a genuine return', () => {
    const now = Date.now();
    useProjectStore.setState({
      projects: [record(projectIdFor(ALPHA), 'Alpha', ALPHA, now - 60_000)],
      activeProjectId: projectIdFor(ALPHA),
    });
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });
    syncActiveProject(now);
    expect(welcomeForSwitch(now)?.returning).toBe(true);
  });

  it('says nothing on a first visit', () => {
    const now = Date.now();
    useProjectStore.setState({
      projects: [record(projectIdFor(ALPHA), 'Alpha', ALPHA, 0)],
      activeProjectId: projectIdFor(ALPHA),
    });
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });
    syncActiveProject(now);
    expect(welcomeForSwitch(now)).toBeNull();
  });

  it('says nothing when no project is open', () => {
    expect(welcomeForSwitch()).toBeNull();
  });
});

describe('the guard is wired to the registry', () => {
  it('denies a path in another project once two are on record', () => {
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });
    syncActiveProject(1000);
    useProjectContextStore.setState({ entry: { path: BETA, projectName: 'Beta', markdown: '', updatedAt: 1 } });
    syncActiveProject(2000);
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });
    syncActiveProject(3000);

    expect(guardPath('/work/beta/src/x.ts').allowed).toBe(false);
    expect(guardPath('/work/alpha/src/x.ts').allowed).toBe(true);
  });

  it('is inert with a single project', () => {
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });
    syncActiveProject(1000);
    expect(guardPath('/work/beta/src/x.ts').allowed).toBe(true);
  });
});

describe('pathArgsOf', () => {
  it('reads known path arguments', () => {
    expect(pathArgsOf({ path: '/a/b.ts' })).toEqual(['/a/b.ts']);
    expect(pathArgsOf({ cwd: '/work/alpha' })).toEqual(['/work/alpha']);
  });

  it('finds absolute paths buried in a shell command', () => {
    expect(pathArgsOf({ command: 'cp /work/beta/x /tmp/x' })).toEqual(
      expect.arrayContaining(['/work/beta/x', '/tmp/x']),
    );
  });

  it('does not read a URL as a filesystem path', () => {
    expect(pathArgsOf({ command: 'curl https://example.com/a' })).toEqual([]);
  });

  it('ignores prose that merely contains slashes', () => {
    expect(pathArgsOf({ description: 'update src/index.ts and docs/readme.md' })).toEqual([]);
  });

  it('tolerates junk', () => {
    expect(pathArgsOf(undefined)).toEqual([]);
    expect(pathArgsOf('a string')).toEqual([]);
    expect(pathArgsOf({ path: 42 })).toEqual([]);
  });
});

describe('project notes reach the prompt scoped to the open project', () => {
  it('includes this project\'s notes', () => {
    useProjectMemoryStore.setState({
      entries: [{
        id: 'e1', project: 'Alpha', kind: 'gotcha', title: 'Alpha only note',
        body: 'The alpha thing that bites', paths: [], createdAt: 1, updatedAt: 1, seq: 1,
      }],
    });
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });

    expect(buildGiaSystem()).toContain('Alpha only note');
  });

  it('EXCLUDES another project\'s notes', () => {
    // The anti-blending check. Notes are keyed by project precisely so
    // switching does not merge two codebases' gotchas, and the prompt heading
    // claims they belong to "this project".
    useProjectMemoryStore.setState({
      entries: [
        {
          id: 'e1', project: 'Beta', kind: 'gotcha', title: 'BETA-ONLY-NOTE',
          body: 'Do not leak this', paths: [], createdAt: 1, updatedAt: 1, seq: 2,
        },
        {
          id: 'e2', project: 'Alpha', kind: 'gotcha', title: 'ALPHA-ONLY-NOTE',
          body: 'This one belongs here', paths: [], createdAt: 1, updatedAt: 1, seq: 1,
        },
      ],
    });
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });

    const prompt = buildGiaSystem();
    expect(prompt).toContain('ALPHA-ONLY-NOTE');
    expect(prompt).not.toContain('BETA-ONLY-NOTE');
  });
});

describe('the peer-agent block is not frozen at import time', () => {
  /**
   * This is the exact shape of the original bug: a module-level `const` built
   * from a cache that is always empty at import time. So the cache is cold here
   * — nothing in this file warms it earlier — and the block must go from absent
   * to present. Under the old frozen `const` the second assertion fails, because
   * the block was computed once, at import, when the cache was guaranteed empty.
   */
  it('appears once detection has run, and is absent before', async () => {
    const restore = setShell(async (cmd: string) =>
      cmd.includes('claude')
        ? { output: '/usr/bin/claude', exitCode: 0 }
        : { output: '', exitCode: 1 },
    );

    try {
      // Cold: nothing detected yet, so nothing claimed. That is correct.
      expect(buildGiaSystem()).not.toContain('Other agents installed on this machine');

      await warmPeerAgentDetection();

      // Warm: the block must now appear.
      const warm = buildGiaSystem();
      expect(warm).toContain('Other agents installed on this machine');
      expect(warm).toContain('delegate_to_agent');
      expect(warm).toContain('/usr/bin/claude');
    } finally {
      restore();
    }
  });
});

describe('the project boundary reaches the prompt', () => {
  it('states the boundary once two projects are on record', () => {
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });
    syncActiveProject(1000);
    useProjectContextStore.setState({ entry: { path: BETA, projectName: 'Beta', markdown: '', updatedAt: 1 } });
    syncActiveProject(2000);
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });
    syncActiveProject(3000);

    const prompt = buildGiaSystem();
    expect(prompt).toContain('Project boundary');
    expect(prompt).toContain('Beta');
  });

  it('says nothing about a boundary when there is only one project', () => {
    useProjectContextStore.setState({ entry: { path: ALPHA, projectName: 'Alpha', markdown: '', updatedAt: 1 } });
    syncActiveProject(1000);
    expect(buildGiaSystem()).not.toContain('Project boundary');
  });
});