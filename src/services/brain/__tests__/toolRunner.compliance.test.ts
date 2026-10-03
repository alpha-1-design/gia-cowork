import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeToolBlocks } from '../toolRunner';
import { registerAllTools } from '../../tools';
import ToolRegistry from '../../ToolRegistry';
import { setModeForCompliance, setComplianceEnabledOverride, resetComplianceOverrides } from '../../system/complianceRuntime';

/**
 * `compliance.test.ts` proves the rules are correct. This proves they are
 * *wired in* — and that distinction is the whole risk.
 *
 * An auditor that is correct but never called passes every unit test and does
 * nothing. So these tests go through the real execution path and assert on the
 * strongest observable signal available: whether the tool's body ran at all.
 */

function toolBlock(id: string, args: Record<string, unknown> = {}) {
  return `\`\`\`tool\n${JSON.stringify({ id, args })}\n\`\`\``;
}

/** Records whether a tool body actually executed. */
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

beforeEach(() => {
  executed = [];
  resetComplianceOverrides();
  registerAllTools();
  // Registered under a REAL mutating id, so the compliance rules apply to it.
  ToolRegistry.register(sentinel('terminal_run'));
});

afterEach(() => {
  ToolRegistry.unregister('terminal_run');
  resetComplianceOverrides();
});

/** Run a tool block, returning both the result and the state fed back to the model. */
async function run(text: string) {
  const state = { history: [] as { role: string; content: string }[], currentPrompt: '', clarificationAttempts: 0 };
  const res = await executeToolBlocks(text, state as never, undefined, undefined, undefined, 'm1');
  return { res, state };
}

/** Everything the model will see about what just happened. */
const feedback = (state: { history: { content: string }[] }) =>
  [state.history.map(h => h.content).join('\n')].join('\n');

describe('compliance is enforced in the real tool path', () => {
  it('STOPS a mutating tool in PLAN mode and never runs it', async () => {
    setModeForCompliance('plan');
    const { state } = await run(toolBlock('terminal_run', { command: 'rm -rf /' }));

    // The strong assertion: the body never executed.
    expect(executed).toEqual([]);
    expect(feedback(state)).toMatch(/COMPLIANCE BLOCK/);
  });

  it('tells GIA which rule she broke, not merely that something failed', async () => {
    setModeForCompliance('plan');
    const { state } = await run(toolBlock('terminal_run', { command: 'ls' }));
    const text = feedback(state);
    // A correction she can act on, naming the rule and asking her to fix it.
    expect(text).toMatch(/PLAN mode/);
    expect(text).toMatch(/do it the way the rule says/i);
  });

  it('actually reaches the model history, not just the return value', async () => {
    // The observation has to survive the aggregate path into `history`,
    // otherwise the block is silent: the tool stops and GIA is never told why,
    // so she simply retries the same thing.
    setModeForCompliance('plan');
    const { state } = await run(toolBlock('terminal_run', { command: 'ls' }));
    expect(feedback(state)).toMatch(/COMPLIANCE BLOCK/);
  });

  it('lets the same tool through in CODE mode', async () => {
    setModeForCompliance('code');
    const { state } = await run(toolBlock('terminal_run', { command: 'ls' }));
    expect(executed).toEqual(['terminal_run']);
    expect(feedback(state)).not.toMatch(/COMPLIANCE BLOCK/);
  });

  it('blocks every tool in ASK mode', async () => {
    setModeForCompliance('ask');
    const { state } = await run(toolBlock('terminal_run'));
    expect(executed).toEqual([]);
    expect(feedback(state)).toMatch(/COMPLIANCE BLOCK/);
  });

  it('still enforces in BUILD mode for tools the build rules cover', async () => {
    // BUILD has full tool access — this asserts that the auditor does not
    // blanket-block builds, which would make the feature unusable.
    setModeForCompliance('build');
    await run(toolBlock('terminal_run'));
    expect(executed).toEqual(['terminal_run']);
  });

  it('does nothing at all when disarmed', async () => {
    setModeForCompliance('plan');
    setComplianceEnabledOverride(false);
    await run(toolBlock('terminal_run'));
    expect(executed).toEqual(['terminal_run']);
  });

  it('arms by default, so it does not need switching on', async () => {
    // An auditor that has to be enabled is one that will not be on when it
    // matters. No override set here on purpose.
    setModeForCompliance('plan');
    await run(toolBlock('terminal_run'));
    expect(executed).toEqual([]);
  });
});