import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { idbStorage } from './idb-storage';
import { genId } from '../utils/id';
import { useProviderStore } from './useProviderStore';

export interface AgentDispatchTask {
  id: string;
  /** What the user asked for. */
  prompt: string;
  /** Which agent/sub-agent handles this (by name or id). */
  agentId: string;
  agentName: string;
  agentRole: string;
  agentColor: string;
  agentIcon: string;
  /** Which provider handles this agent's call. Empty = best-available. */
  providerId: string;
  /** Status of this dispatch. */
  status: 'queued' | 'spawning' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** Accumulated text result from the agent. */
  result: string;
  /** Current activity line (e.g. "Searching the web…"). */
  currentActivity: string;
  /** Error message if failed. */
  error: string;
  /** Token usage for this dispatch. */
  tokenUsage: { input: number; output: number } | null;
  /** Timestamps. */
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

interface AgentTaskState {
  /** All dispatch tasks, newest first. */
  tasks: AgentDispatchTask[];
  /** Currently running task ids (for concurrency tracking). */
  runningIds: string[];
  /** Max concurrent tasks. */
  maxConcurrent: number;
  /** Per-agent provider overrides (agent name → provider id). */
  agentProviders: Record<string, string>;
  /** Per-agent provider overrides for built-in sub-agents. */
  subAgentProviders: Record<string, string>;

  /** Dispatch a new task. Returns the task id. */
  dispatch: (opts: {
    prompt: string;
    agentId: string;
    agentName: string;
    agentRole: string;
    agentColor: string;
    agentIcon: string;
    providerId?: string;
  }) => string;

  /** Mark a task as running. */
  markRunning: (id: string) => void;

  /** Update activity text for a running task. */
  setActivity: (id: string, activity: string) => void;

  /** Append to result text (streamed). */
  appendResult: (id: string, text: string) => void;

  /** Set final result. */
  setResult: (id: string, result: string, tokens?: { input: number; output: number }) => void;

  /** Mark task as failed. */
  setFailed: (id: string, error: string) => void;

  /** Cancel a running task. */
  cancel: (id: string) => void;

  /** Remove a task from history. */
  remove: (id: string) => void;

  /** Clear all completed/failed tasks. */
  clearHistory: () => void;

  /** Set provider override for a custom agent. */
  setAgentProvider: (agentName: string, providerId: string) => void;

  /** Set provider override for a built-in sub-agent. */
  setSubAgentProvider: (subAgentName: string, providerId: string) => void;

  /** Resolve the effective provider for a task — per-task override, per-agent override, or best-available. */
  resolveProvider: (taskId: string) => string;
}

export const useAgentTaskStore = create<AgentTaskState>()(
  persist(
    (set, get) => ({
      tasks: [],
      runningIds: [],
      maxConcurrent: 5,
      agentProviders: {},
      subAgentProviders: {},

      dispatch: (opts) => {
        const id = genId();
        const task: AgentDispatchTask = {
          id,
          prompt: opts.prompt,
          agentId: opts.agentId,
          agentName: opts.agentName,
          agentRole: opts.agentRole,
          agentColor: opts.agentColor,
          agentIcon: opts.agentIcon,
          providerId: opts.providerId || '',
          status: 'queued',
          result: '',
          currentActivity: 'Queued…',
          error: '',
          tokenUsage: null,
          createdAt: Date.now(),
          startedAt: null,
          completedAt: null,
        };
        set(s => ({ tasks: [task, ...s.tasks].slice(0, 200) }));
        return id;
      },

      markRunning: (id) => {
        set(s => ({
          tasks: s.tasks.map(t =>
            t.id === id ? { ...t, status: 'running', startedAt: Date.now(), currentActivity: 'Starting…' } : t
          ),
          runningIds: [...s.runningIds.filter(r => r !== id), id],
        }));
      },

      setActivity: (id, activity) => {
        set(s => ({
          tasks: s.tasks.map(t => t.id === id ? { ...t, currentActivity: activity } : t),
        }));
      },

      appendResult: (id, text) => {
        set(s => ({
          tasks: s.tasks.map(t => t.id === id ? { ...t, result: t.result + text } : t),
        }));
      },

      setResult: (id, result, tokens) => {
        set(s => ({
          tasks: s.tasks.map(t =>
            t.id === id ? { ...t, status: 'completed', result, completedAt: Date.now(), tokenUsage: tokens || t.tokenUsage } : t
          ),
          runningIds: s.runningIds.filter(r => r !== id),
        }));
      },

      setFailed: (id, error) => {
        set(s => ({
          tasks: s.tasks.map(t =>
            t.id === id ? { ...t, status: 'failed', error, completedAt: Date.now() } : t
          ),
          runningIds: s.runningIds.filter(r => r !== id),
        }));
      },

      cancel: (id) => {
        set(s => ({
          tasks: s.tasks.map(t =>
            t.id === id ? { ...t, status: 'cancelled', completedAt: Date.now() } : t
          ),
          runningIds: s.runningIds.filter(r => r !== id),
        }));
      },

      remove: (id) => {
        set(s => ({
          tasks: s.tasks.filter(t => t.id !== id),
          runningIds: s.runningIds.filter(r => r !== id),
        }));
      },

      clearHistory: () => {
        set(s => ({
          tasks: s.tasks.filter(t => s.runningIds.includes(t.id)),
        }));
      },

      setAgentProvider: (agentName, providerId) => {
        set(s => ({
          agentProviders: { ...s.agentProviders, [agentName]: providerId },
        }));
      },

      setSubAgentProvider: (subAgentName, providerId) => {
        set(s => ({
          subAgentProviders: { ...s.subAgentProviders, [subAgentName]: providerId },
        }));
      },

      resolveProvider: (taskId) => {
        const s = get();
        const task = s.tasks.find(t => t.id === taskId);
        if (!task) return '';
        // 1. Per-task override
        if (task.providerId) return task.providerId;
        // 2. Per-agent override (custom or sub-agent)
        if (s.agentProviders[task.agentName]) return s.agentProviders[task.agentName];
        if (s.subAgentProviders[task.agentName]) return s.subAgentProviders[task.agentName];
        // 3. Best available from provider store
        const best = useProviderStore.getState().getBestProviderForTask();
        return best?.id || '';
      },
    }),
    {
      name: 'gia-agent-tasks',
      storage: createJSONStorage(() => idbStorage),
      partialize: (s) => ({
        tasks: s.tasks.slice(0, 100), // keep last 100
        agentProviders: s.agentProviders,
        subAgentProviders: s.subAgentProviders,
      }),
    }
  )
);
