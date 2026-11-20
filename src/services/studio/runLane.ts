import { swarmCoordinator } from '../swarm/SwarmCoordinator';
import { useAgentTaskStore } from '../../store/useAgentTaskStore';
import type { StudioAgent } from './devAgents';

/**
 * Run one studio agent through the SwarmCoordinator — the ONE agent engine.
 * Each lane is a one-task swarm so the coordinator owns the AbortController:
 * cancelling from the task board actually aborts the underlying generation
 * (the old inline controller was dead — nothing ever called .abort()).
 * The studio persona instruction rides the task's systemPrompt override;
 * the coordinator still appends its persona/tool-policy context.
 */
export function runStudioLane(agent: StudioAgent, task: string, systemPrompt: string): string {
  const store = useAgentTaskStore.getState();
  const taskId = store.dispatch({
    prompt: task,
    agentId: agent.id,
    agentName: agent.name,
    agentRole: agent.role,
    agentColor: agent.color,
    agentIcon: agent.icon,
  });
  const providerId = store.resolveProvider(taskId);

  swarmCoordinator.startSwarm({
    tasks: [{
      id: taskId,
      prompt: task,
      persona: `${agent.name} — ${agent.role}`,
      systemPrompt,
      providerId: providerId || undefined,
    }],
    concurrency: 1,
    profile: 'ask',
  });

  return taskId;
}
