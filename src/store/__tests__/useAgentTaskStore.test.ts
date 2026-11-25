import { describe, it, expect, beforeEach } from 'vitest';
import { useAgentTaskStore } from '../useAgentTaskStore';

/**
 * The swarm's persisted task ledger. Only the S4-25 invariant is pinned here:
 * a pre-allocated lane id with no record must not become a phantom entry in
 * runningIds (SubAgentManager passes spec.id for lanes it never dispatched
 * through the store).
 */

beforeEach(() => {
  useAgentTaskStore.setState({ tasks: [], runningIds: [] });
});

describe('markRunning — phantom-id guard (S4-25)', () => {
  it('records a real task as running and tracks its id', () => {
    const id = useAgentTaskStore.getState().dispatch({
      prompt: 'do a thing',
      agentId: 'a1',
      agentName: 'Atlas',
      agentRole: 'Strategist',
      agentColor: '#fff',
      agentIcon: 'Bot',
      providerId: 'openai',
    });

    useAgentTaskStore.getState().markRunning(id);
    const s = useAgentTaskStore.getState();
    expect(s.runningIds).toEqual([id]);
    expect(s.tasks.find((t) => t.id === id)?.status).toBe('running');
  });

  it('ignores an id with no store record instead of accumulating phantoms', () => {
    useAgentTaskStore.getState().markRunning('pre-allocated-lane-id');
    const s = useAgentTaskStore.getState();
    expect(s.runningIds).toEqual([]);
    expect(s.tasks).toEqual([]);
  });

  it('a real run then a phantom leaves exactly one running id', () => {
    const id = useAgentTaskStore.getState().dispatch({
      prompt: 'x',
      agentId: 'a1',
      agentName: 'Atlas',
      agentRole: 'Strategist',
      agentColor: '#fff',
      agentIcon: 'Bot',
      providerId: 'openai',
    });
    useAgentTaskStore.getState().markRunning(id);
    useAgentTaskStore.getState().markRunning('ghost');
    expect(useAgentTaskStore.getState().runningIds).toEqual([id]);
  });
});
