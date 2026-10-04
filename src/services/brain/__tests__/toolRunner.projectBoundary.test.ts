import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeToolBlocks } from '../toolRunner';
import { registerAllTools } from '../../tools';
import ToolRegistry from '../../ToolRegistry';
import { setModeForCompliance, resetComplianceOverrides } from '../../system/complianceRuntime';
import { setActiveProject, resetProjectContext } from '../../projects/projectIsolation';
import { useProjectStore } from '../../../store/useProjectStore';
import { useProtocolStore } from '../../../store/useProtocolStore';

/**
 * `projectIsolation.test.ts` proves the decision is correct. This proves it is
 * *enforced*.
 *
 * The failure this guards against is not a wrong answer — it is no answer.
 * `checkProjectIngress` had a carefully argued policy, thorough unit tests, and
 * no caller at all: GIA was told in prose not to touch other projects and was
 * never stopped when she did. So these tests assert on the strongest signal
 * available, whether the tool body executed at all.
 */

function toolBlock(id: string, args: Record<string, unknown> = {}) {
  return `\`\`\`tool\n${JSON.stringify({ id, args })}\n\`\`\``;
}

let executed: string[] = [];

function sentinel(id: string) {
  return {
    id,
    name: id,
    description: `sentinel ${id}`,
    schema: { type: 'object' as const, properties: {}, required: [] as string[] },
    execute: async () => {
      executed.push(id);
      return { success: true, content: 'OBSERVATION: Success — sentinel ran' };
    },
  };
}

const ALPHA = { id: 'p-alpha', name: 'Alpha', path: '/work/alpha', lastSeenAt: 1, restrictMemory: false };
const BETA = { id: 'p-beta', name: 'Beta', path: '/work/beta', lastSeenAt: 1, restrictMemory: false };

function seed(activeId: string | null, projects = [ALPHA, BETA]) {
  useProjectStore.setState({ projects, activeProjectId: activeId });
  resetProjectContext();
  setActiveProject(activeId);
}

async function run(text: string) {
  const state = { history: [] as { role: string; content: string }[], currentPrompt: '', clarificationAttempts: 0 };
  const res = await executeToolBlocks(text, state as never, undefined, undefined, undefined, 'm1');
  return { res, state };
}

const feedback = (state: { history: { content: string }[] }) =>
  state.history.map(h => h.content).join('\n');

beforeEach(() => {
  executed = [];
  resetComplianceOverrides();
  registerAllTools();
  ToolRegistry.register(sentinel('terminal_run'));
  ToolRegistry.register(sentinel('filesystem_write'));
  // CODE mode so the compliance gate passes and the ingress gate is the only
  // thing that can block — otherwise a green test could be green for the wrong
  // reason.
  setModeForCompliance('code');
  // Full autonomy skips the consent prompt, which otherwise waits on a user
  // that does not exist in a test. The point here is the boundary, and the
  // ingress gate sits above this either way.
  useProtocolStore.getState().setFullAutonomy(true);
});

afterEach(() => {
  ToolRegistry.unregister('terminal_run');
  ToolRegistry.unregister('filesystem_write');
  resetComplianceOverrides();
  resetProjectContext();
  useProtocolStore.getState().setFullAutonomy(false);
  useProjectStore.setState({ projects: [], activeProjectId: null });
});

describe('the project boundary is enforced in the real tool path', () => {
  it('STOPS a write into another project and never runs it', async () => {
    seed('p-alpha');
    const { state } = await run(toolBlock('filesystem_write', { path: '/work/beta/src/index.ts', content: 'x' }));

    expect(executed).toEqual([]);
    expect(feedback(state)).toMatch(/PROJECT BOUNDARY/);
  });

  it('names the project it refused, so GIA can explain herself', async () => {
    seed('p-alpha');
    const { state } = await run(toolBlock('filesystem_write', { path: '/work/beta/src/index.ts', content: 'x' }));
    expect(feedback(state)).toContain('Beta');
  });

  it('catches a path buried inside a shell command', async () => {
    // The obvious failure mode: gating a `path` argument while `cat /work/beta/x`
    // walks straight through. Commands are the most common way a boundary gets
    // crossed, so they have to be read too.
    seed('p-alpha');
    const { state } = await run(toolBlock('terminal_run', { command: 'cat /work/beta/secret.env' }));

    expect(executed).toEqual([]);
    expect(feedback(state)).toMatch(/PROJECT BOUNDARY/);
  });

  it('allows work in the active project', async () => {
    seed('p-alpha');
    await run(toolBlock('filesystem_write', { path: '/work/alpha/src/index.ts', content: 'x' }));
    expect(executed).toEqual(['filesystem_write']);
  });

  it('allows unrelated paths outside every known project', async () => {
    // A gate that refuses every path outside the project root gets switched
    // off entirely, which is worse than a slightly loose one.
    seed('p-alpha');
    await run(toolBlock('filesystem_write', { path: '/tmp/scratch.txt', content: 'x' }));
    expect(executed).toEqual(['filesystem_write']);
  });

  it('does not treat a sibling directory sharing a prefix as the same project', async () => {
    // "/work/alpha-other" is not inside "/work/alpha". A prefix match would
    // block a legitimate sibling checkout.
    seed('p-alpha');
    await run(toolBlock('filesystem_write', { path: '/work/alpha-other/main.ts', content: 'x' }));
    expect(executed).toEqual(['filesystem_write']);
  });

  it('stays completely inert with only one project open', async () => {
    // One project has no boundary, so the gate must not fire on anything.
    seed('p-alpha', [ALPHA]);
    await run(toolBlock('filesystem_write', { path: '/work/beta/src/index.ts', content: 'x' }));
    expect(executed).toEqual(['filesystem_write']);
  });

  it('stays inert when no project is open at all', async () => {
    seed(null, []);
    await run(toolBlock('filesystem_write', { path: '/work/beta/src/index.ts', content: 'x' }));
    expect(executed).toEqual(['filesystem_write']);
  });

  it('does not mistake a URL for a filesystem path', async () => {
    // "https://..." contains a slash and would resolve to a path-shaped token
    // if the extractor were loose. Fetching a URL must never be blocked.
    seed('p-alpha');
    await run(toolBlock('terminal_run', { command: 'curl https://example.com/work/beta/x' }));
    expect(executed).toEqual(['terminal_run']);
  });
});