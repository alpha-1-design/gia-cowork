import { describe, it, expect, beforeEach } from 'vitest';
import { executeToolBlocks } from '../toolRunner';
import { useGiaStore } from '../../../store/useGiaStore';
import { useProtocolStore } from '../../../store/useProtocolStore';
import { registerAllTools } from '../../tools';

/**
 * The store test proves notes can be queued and drained. This proves they
 * actually reach the agent mid-turn — which is the entire point, and the part
 * that silently rots: a steering feature that drains into a variable nothing
 * reads looks identical to one that works, right up until you depend on it.
 *
 * `list_goals` resolves synchronously with no native dependency, so two calls
 * in one block form two sequential groups and the drain point is observable.
 */

function toolBlock(id: string, args: Record<string, unknown> = {}) {
  return `\`\`\`tool\n${JSON.stringify({ id, args })}\n\`\`\``;
}

const TEST_TOOL = 'list_goals';

describe('executeToolBlocks — steering', () => {
  beforeEach(() => {
    registerAllTools();
    useProtocolStore.setState({ consoleProtocols: [], fullAutonomy: true });
    useGiaStore.setState({
      steeringNotes: [],
      sessions: [],
      activeSessionId: 's1',
    } as never);
  });

  it('injects a steering note into the running turn before the next step', async () => {
    useGiaStore.getState().addSteering('s1', 'actually use Tailwind, not CSS modules');

    const state = { history: [] as { role: string; content: string }[], currentPrompt: '', clarificationAttempts: 0 };
    await executeToolBlocks(
      toolBlock(TEST_TOOL),
      state as never,
      undefined, undefined, undefined,
      'm1',
    );

    const steered = state.history.filter(h => h.content.includes('STEERING FROM USER'));
    expect(steered.length).toBeGreaterThan(0);
    expect(steered[0].content).toContain('actually use Tailwind, not CSS modules');
    // It must be phrased as a correction, not as more task description.
    expect(steered[0].role).toBe('user');
  });

  it('delivers a note once, not on every subsequent tool group', async () => {
    useGiaStore.getState().addSteering('s1', 'stop, use the existing helper');

    const state = { history: [] as { role: string; content: string }[], currentPrompt: '', clarificationAttempts: 0 };
    await executeToolBlocks(
      toolBlock(TEST_TOOL) + '\n' + toolBlock(TEST_TOOL),
      state as never,
      undefined, undefined, undefined,
      'm1',
    );

    const steered = state.history.filter(h => h.content.includes('STEERING FROM USER'));
    expect(steered).toHaveLength(1);
    // And the store is drained, not merely marked read.
    expect(useGiaStore.getState().steeringNotes).toHaveLength(0);
  });

  it('leaves a note for a different session untouched', async () => {
    useGiaStore.getState().addSteering('other-session', 'not for you');

    const state = { history: [] as { role: string; content: string }[], currentPrompt: '', clarificationAttempts: 0 };
    await executeToolBlocks(toolBlock(TEST_TOOL), state as never, undefined, undefined, undefined, 'm1');

    expect(state.history.some(h => h.content.includes('STEERING FROM USER'))).toBe(false);
    expect(useGiaStore.getState().steeringNotes).toHaveLength(1);
  });

  it('does not disturb a turn with no steering', async () => {
    const state = { history: [] as { role: string; content: string }[], currentPrompt: '', clarificationAttempts: 0 };
    await executeToolBlocks(toolBlock(TEST_TOOL), state as never, undefined, undefined, undefined, 'm1');
    expect(state.history.some(h => h.content.includes('STEERING FROM USER'))).toBe(false);
  });
});