import GiaBrain from '../GiaBrain';
import { useAgentTaskStore } from '../../store/useAgentTaskStore';
import type { StudioAgent } from './devAgents';

/** Run one studio agent. Parallel callers share the task board. */
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
  const controller = new AbortController();
  store.markRunning(taskId);
  store.setActivity(taskId, 'Starting…');
  const providerId = store.resolveProvider(taskId);

  void GiaBrain.generate({
    prompt: task,
    systemPrompt,
    providerId: providerId || undefined,
    signal: controller.signal,
    onStream: (chunk) => {
      useAgentTaskStore.getState().appendResult(taskId, chunk);
      useAgentTaskStore.getState().setActivity(taskId, 'Writing…');
    },
  }).then((result) => {
    if (controller.signal.aborted) return;
    useAgentTaskStore.getState().setResult(
      taskId,
      result.text,
      result.tokenUsage ? { input: result.tokenUsage.input, output: result.tokenUsage.output } : undefined,
    );
  }).catch((e: unknown) => {
    if (e instanceof Error && e.name === 'AbortError') {
      useAgentTaskStore.getState().cancel(taskId);
      return;
    }
    useAgentTaskStore.getState().setFailed(taskId, e instanceof Error ? e.message : 'The lane failed');
  });

  return taskId;
}
