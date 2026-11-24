import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * SwarmCoordinator tests.
 *
 * The executor, the stores and the worktree seam are all mocked at the same
 * seams the coordinator itself defines, so these tests drive the REAL lane
 * scheduler: FIFO pull, concurrency cap, cancel/abort/discard, kill-switch
 * pause, worktree fallback, profile wiring, persistence and synthesis.
 */

// ── Fake store state (closures — vi.mock is hoisted above these) ───────────

type StoreTask = {
  id: string;
  prompt: string;
  agentId: string;
  agentName: string;
  status: string;
  result: string;
  error: string;
  activity: string;
  tokenUsage: { input: number; output: number } | null;
};

const storeTasks: StoreTask[] = [];
const storeCalls: string[] = [];
let nextStoreId = 0;
const customAgents = new Map<string, { id: string; name: string; description: string; systemPrompt: string; icon: string; tools: string[] }>();

const protocolState = { fullAutonomy: false };
const sessionGrants: { scope: string; choice: string }[] = [];
const trustState = { armed: true };
const trustListeners = new Set<(s: typeof trustState) => void>();
const consoleLogs: { type: string; content: string }[] = [];
const stripState = { currentTool: null as string | null };

const worktreeCreated: { taskId: string; path: string }[] = [];
const worktreeRemoved: string[] = [];
let worktreeMode: 'ok' | 'fail' = 'ok';

vi.mock('../../../store/useAgentTaskStore', () => ({
  useAgentTaskStore: {
    getState: () => ({
      dispatch: (opts: { prompt: string; agentId: string; agentName: string }) => {
        const id = `task-${++nextStoreId}`;
        storeCalls.push(`dispatch:${opts.agentName}`);
        storeTasks.push({
          id, prompt: opts.prompt, agentId: opts.agentId, agentName: opts.agentName,
          status: 'queued', result: '', error: '', activity: '', tokenUsage: null,
        });
        return id;
      },
      markRunning: (id: string) => { storeCalls.push(`markRunning:${id}`); const t = storeTasks.find(x => x.id === id); if (t) t.status = 'running'; },
      setActivity: (id: string, a: string) => { storeCalls.push(`setActivity:${id}`); const t = storeTasks.find(x => x.id === id); if (t) t.activity = a; },
      appendResult: (id: string, text: string) => { storeCalls.push(`appendResult:${id}`); const t = storeTasks.find(x => x.id === id); if (t) t.result += text; },
      setResult: (id: string, result: string, tokens?: { input: number; output: number }) => {
        storeCalls.push(`setResult:${id}`);
        const t = storeTasks.find(x => x.id === id);
        if (t) { t.status = 'completed'; t.result = result; t.tokenUsage = tokens ?? null; }
      },
      setFailed: (id: string, error: string) => { storeCalls.push(`setFailed:${id}`); const t = storeTasks.find(x => x.id === id); if (t) { t.status = 'failed'; t.error = error; } },
      cancel: (id: string) => { storeCalls.push(`cancel:${id}`); const t = storeTasks.find(x => x.id === id); if (t) t.status = 'cancelled'; },
      resolveProvider: (id: string) => { storeCalls.push(`resolveProvider:${id}`); return 'openai'; },
    }),
  },
}));

vi.mock('../../../store/useTrustStore', () => ({
  // The coordinator subscribes at the HOOK level (zustand shape:
  // useTrustStore.subscribe), not via getState() — so subscribe lives on
  // the mocked store object itself.
  useTrustStore: {
    getState: () => ({
      armed: trustState.armed,
      grant: (request: { scope: string }, choice: string) => {
        if (choice === 'session') sessionGrants.push({ scope: request.scope, choice });
      },
      revokeSession: (scope: string) => {
        const i = sessionGrants.findIndex(g => g.scope === scope);
        if (i >= 0) sessionGrants.splice(i, 1);
      },
    }),
    subscribe: (l: (s: typeof trustState) => void) => {
      trustListeners.add(l);
      return () => { trustListeners.delete(l); };
    },
  },
}));

const autonomyListeners = new Set<(s: { fullAutonomy: boolean }) => void>();

vi.mock('../../../store/useProtocolStore', () => ({
  useProtocolStore: {
    getState: () => ({
      get fullAutonomy() { return protocolState.fullAutonomy; },
      setFullAutonomy: (enabled: boolean) => {
        storeCalls.push(`setFullAutonomy:${enabled}`);
        protocolState.fullAutonomy = enabled;
        for (const l of Array.from(autonomyListeners)) l({ fullAutonomy: enabled });
      },
    }),
    subscribe: (l: (s: { fullAutonomy: boolean }) => void) => {
      autonomyListeners.add(l);
      return () => { autonomyListeners.delete(l); };
    },
  },
}));

vi.mock('../../../store/useGiaStore', () => ({
  useGiaStore: {
    getState: () => ({
      get currentTool() { return stripState.currentTool; },
      addConsoleLog: (log: { type: string; content: string }) => { consoleLogs.push(log); },
      setCurrentTool: (tool: string | null) => { stripState.currentTool = tool; },
    }),
  },
}));

vi.mock('../../../store/useAgentStore', () => ({
  useAgentStore: {
    getState: () => ({
      getAgent: (id: string) => customAgents.get(id),
    }),
  },
}));

vi.mock('../../permissions', () => ({
  classifyToolRequest: (toolId: string) => ({
    id: `req-${toolId}`, toolId, toolName: toolId, risk: 'none',
    headline: toolId, reasons: [], scope: `tool:${toolId}`, scopeLabel: toolId, args: {},
  }),
}));

vi.mock('../../brain/SubAgentManager', () => ({
  AGENT_ROLES: [
    { name: 'Atlas', color: '#a855f7', icon: 'Search', role: 'Researcher', style: 'Thorough.', keywords: [] },
    { name: 'Nova', color: '#f59e0b', icon: 'TrendingUp', role: 'Analyst', style: 'Logical.', keywords: [] },
  ],
}));

vi.mock('../../buildGiaSystem', () => ({
  // Marker build: the coordinator must NOT compose a second full
  // buildGiaSystem into its system prompt (REVIEW-2 S2-5) — the base is
  // built once by the executor's 'append' path. 'BASE(' appearing in an
  // executor's systemPrompt would mean the persona is duplicated.
  buildGiaSystem: (query?: string) => `BASE(${query ?? ''})`,
}));

vi.mock('../../git/worktree', () => ({
  createWorktree: async (repoRoot: string, sessionId: string, title: string) => {
    if (worktreeMode === 'fail') return { ok: false, error: 'git worktree add failed' };
    const path = `/repo/.gia/worktrees/${sessionId}-${title.length}`;
    worktreeCreated.push({ taskId: sessionId, path });
    return { ok: true, target: { repoRoot, path, branch: `gia/${sessionId}` } };
  },
  removeWorktree: async (_repoRoot: string, path: string) => {
    worktreeRemoved.push(path);
    return { ok: true };
  },
}));

vi.mock('../../CostTracker', () => ({
  costTracker: {
    getSummary: (sinceMs?: number) => ({ totalCost: sinceMs ? 0.42 : 0, calls: 2 }),
  },
}));

import { swarmCoordinator, SwarmCoordinator, createDefaultAllocator, type SwarmEvent, type SwarmExecutorRequest, type SwarmExecutionResult } from '../SwarmCoordinator';

// ── Test harness ───────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface CapturedRequest extends SwarmExecutorRequest {
  deferred: Deferred<SwarmExecutionResult>;
}

/**
 * Executor mock with controlled timing: every call is parked on a deferred
 * the test resolves explicitly, so FIFO order, concurrency and cancel
 * timing are deterministic. Deferreds resolve SwarmExecutionResult objects,
 * matching the real executor contract.
 */
function makeExecutor() {
  const calls: CapturedRequest[] = [];
  const executor = async (req: SwarmExecutorRequest) => {
    const d = deferred<SwarmExecutionResult>();
    calls.push({ ...req, deferred: d });
    return d.promise;
  };
  return { executor, calls };
}

function setArmed(armed: boolean) {
  trustState.armed = armed;
  for (const l of [...trustListeners]) l(trustState);
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

function recordOf(coordinator: SwarmCoordinator, runId: string, taskId: string) {
  const run = coordinator.getRun(runId);
  return run!.tasks.find(t => t.id === taskId)!;
}

beforeEach(() => {
  storeTasks.length = 0;
  storeCalls.length = 0;
  nextStoreId = 0;
  customAgents.clear();
  sessionGrants.length = 0;
  consoleLogs.length = 0;
  stripState.currentTool = null;
  worktreeCreated.length = 0;
  worktreeRemoved.length = 0;
  worktreeMode = 'ok';
  protocolState.fullAutonomy = false;
  autonomyListeners.clear();
  trustState.armed = true;
  trustListeners.clear();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('SwarmCoordinator — auto-read grants retire with the run (S3-18)', () => {
  it('session grants minted by an auto-read run are revoked when it finishes', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    coordinator.startSwarm({ tasks: [{ prompt: 'a' }], concurrency: 1, profile: 'auto-read' });
    expect(sessionGrants.length).toBeGreaterThan(20);

    calls[0].deferred.resolve({ text: 'done' });
    await flush();
    expect(sessionGrants.length).toBe(0); // retired with the run
  });
});

describe('SwarmCoordinator — lane scheduler', () => {
  it('runs at most `concurrency` tasks at once and pulls the next queued task FIFO when a lane frees', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const { runId } = coordinator.startSwarm({
      tasks: [1, 2, 3, 4, 5].map(n => ({ prompt: `task ${n}` })),
      concurrency: 2,
      profile: 'ask',
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].prompt).toBe('task 1');
    expect(calls[1].prompt).toBe('task 2');

    calls[0].deferred.resolve({ text: 'one' });
    await flush();
    // Freed lane pulls task 3 next, not task 4/5.
    expect(calls).toHaveLength(3);
    expect(calls[2].prompt).toBe('task 3');

    calls[1].deferred.resolve({ text: 'two' });
    calls[2].deferred.resolve({ text: 'three' });
    await flush();
    expect(calls).toHaveLength(5);
    expect(calls[3].prompt).toBe('task 4');
    expect(calls[4].prompt).toBe('task 5');

    calls[3].deferred.resolve({ text: 'four' });
    calls[4].deferred.resolve({ text: 'five' });
    await flush();

    const run = coordinator.getRun(runId)!;
    expect(run.done).toBe(5);
    expect(run.failed).toBe(0);
    expect(run.tasks.every(t => t.status === 'done')).toBe(true);
  });

  it('clamps concurrency into 1-8', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    coordinator.startSwarm({
      tasks: Array.from({ length: 10 }, (_, i) => ({ prompt: `t${i}` })),
      concurrency: 99,
      profile: 'ask',
    });
    expect(calls).toHaveLength(8);

    const { executor: exec2, calls: calls2 } = makeExecutor();
    const coordinator2 = new SwarmCoordinator({ executor: exec2 });
    coordinator2.startSwarm({ tasks: [{ prompt: 'a' }, { prompt: 'b' }], concurrency: 0, profile: 'ask' });
    expect(calls2).toHaveLength(1); // 0 clamps to 1
  });

  it('persists task records via useAgentTaskStore and resolves the record id from the store', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const { runId } = coordinator.startSwarm({
      tasks: [{ prompt: 'do the thing', persona: 'Atlas' }],
      concurrency: 1,
      profile: 'ask',
    });
    const taskId = coordinator.getRun(runId)!.tasks[0].id;
    expect(storeCalls).toContain(`dispatch:Atlas`);
    expect(storeCalls).toContain(`resolveProvider:${taskId}`);
    expect(storeCalls).toContain(`markRunning:${taskId}`);
    expect(recordOf(coordinator, runId, taskId).provider).toBe('openai');

    calls[0].deferred.resolve({ text: 'the result' });
    await flush();
    expect(storeCalls).toContain(`setResult:${taskId}`);
    expect(storeTasks[0].result).toBe('the result');
  });
});

describe('SwarmCoordinator — cancellation (the V1 abort defect, fixed by design)', () => {
  it('cancel(taskId) aborts the running generation and a late result is DISCARDED, never appended', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const { runId } = coordinator.startSwarm({
      tasks: [{ prompt: 'long task', persona: 'Nova' }],
      concurrency: 1,
      profile: 'ask',
    });
    const taskId = coordinator.getRun(runId)!.tasks[0].id;

    expect(coordinator.cancel(taskId)).toBe(true);
    // The signal rides into the execution call, like the chat Stop button.
    expect(calls[0].signal!.aborted).toBe(true);
    expect(storeCalls).toContain(`cancel:${taskId}`);
    expect(recordOf(coordinator, runId, taskId).status).toBe('cancelled');

    // The generation finishes anyway (late result) — it must be discarded.
    calls[0].deferred.resolve({ text: 'late result that must not be kept' });
    await flush();
    expect(storeCalls).not.toContain(`setResult:${taskId}`);
    expect(storeCalls).not.toContain(`appendResult:${taskId}`);
    expect(recordOf(coordinator, runId, taskId).result).toBeUndefined();

    // run-finished still fires once the only task is terminal.
    await flush();
  });

  it('cancel on a queued task never starts it; cancelAll clears the rest', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const { runId } = coordinator.startSwarm({
      tasks: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }],
      concurrency: 1,
      profile: 'ask',
    });
    const ids = coordinator.getRun(runId)!.tasks.map(t => t.id);

    expect(coordinator.cancel(ids[1])).toBe(true); // queued → cancelled, never dispatched
    expect(recordOf(coordinator, runId, ids[1]).status).toBe('cancelled');

    coordinator.cancelAll(runId);
    expect(calls[0].signal!.aborted).toBe(true);
    expect(recordOf(coordinator, runId, ids[0]).status).toBe('cancelled');
    expect(recordOf(coordinator, runId, ids[2]).status).toBe('cancelled');
    await flush();
    expect(calls).toHaveLength(1); // nothing else was ever dispatched
  });

  it('an aborted (cancelled) executor rejection is also discarded', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const { runId } = coordinator.startSwarm({ tasks: [{ prompt: 'x' }], concurrency: 1, profile: 'ask' });
    const taskId = coordinator.getRun(runId)!.tasks[0].id;

    coordinator.cancel(taskId);
    calls[0].deferred.reject(new DOMException('Aborted', 'AbortError'));
    await flush();

    const record = recordOf(coordinator, runId, taskId);
    expect(record.status).toBe('cancelled');
    expect(record.error).toBeUndefined();
    expect(storeCalls).not.toContain(`setFailed:${taskId}`);
  });
});

describe('SwarmCoordinator — kill switch pauses the queue (does not cancel)', () => {
  it('does not dispatch while disarmed, and resumes the FIFO queue on re-arm', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    setArmed(false);
    const events: SwarmEvent[] = [];
    coordinator.on(e => events.push(e));

    const { runId } = coordinator.startSwarm({
      tasks: [{ prompt: 'a' }, { prompt: 'b' }],
      concurrency: 2,
      profile: 'ask',
    });

    expect(calls).toHaveLength(0);
    expect(events.some(e => e.type === 'queue-paused')).toBe(true);
    // Queued, not cancelled — the plan survives the pause.
    expect(coordinator.getRun(runId)!.tasks.every(t => t.status === 'queued')).toBe(true);

    setArmed(true);
    await flush();
    expect(calls).toHaveLength(2);
    expect(events.some(e => e.type === 'queue-resumed')).toBe(true);
  });

  it('pauses mid-run when the switch is flipped while a task runs', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const { runId } = coordinator.startSwarm({
      tasks: [{ prompt: 'a' }, { prompt: 'b' }],
      concurrency: 1,
      profile: 'ask',
    });
    expect(calls).toHaveLength(1);

    setArmed(false);
    calls[0].deferred.resolve({ text: 'done a' }); // settle → pump hits the pause
    await flush();
    expect(calls).toHaveLength(1); // task 2 NOT dispatched
    expect(coordinator.getRun(runId)!.tasks[1].status).toBe('queued');

    setArmed(true);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toBe('b');
  });
});

describe('SwarmCoordinator — worktree per code-task', () => {
  it('allocates before execution, records the path, releases after completion', async () => {
    const { executor, calls } = makeExecutor();
    // Real allocator over the mocked worktree module, with a repo root —
    // the same wiring the module integration (W7) will provide.
    const coordinator = new SwarmCoordinator({ executor, allocator: createDefaultAllocator('/repo') });

    const { runId } = coordinator.startSwarm({
      tasks: [{ prompt: 'refactor the login flow', worktree: true }],
      concurrency: 1,
      profile: 'ask',
    });
    const taskId = coordinator.getRun(runId)!.tasks[0].id;
    expect(worktreeCreated.some(w => w.taskId === taskId)).toBe(true);
    // The allocate→record handoff is async: let the awaited allocation
    // continuation resume before reading the record.
    await flush();

    const path = recordOf(coordinator, runId, taskId).worktreePath!;
    expect(path).toMatch(/\.gia\/worktrees\//);

    calls[0].deferred.resolve({ text: 'refactored' });
    await flush();
    expect(worktreeRemoved).toContain(path); // deallocated after completion
  });

  it('degrades to shared space with a task warning when allocation fails, and keeps the worktree on failure', async () => {
    worktreeMode = 'fail';
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor, allocator: createDefaultAllocator('/repo') });

    const { runId } = coordinator.startSwarm({
      tasks: [{ prompt: 'risky task', worktree: true }],
      concurrency: 1,
      profile: 'ask',
    });

    // Execution proceeds despite the failed allocation. (Async handoff:
    // let the failed-allocation continuation + dispatch resume first.)
    await flush();
    expect(calls).toHaveLength(1);
    const record = recordOf(coordinator, runId, coordinator.getRun(runId)!.tasks[0].id);
    expect(record.warning).toContain('Worktree unavailable');
    expect(record.worktreePath).toBeUndefined();

    calls[0].deferred.reject(new Error('generation blew up'));
    await flush();
    expect(record.status).toBe('failed');
    expect(worktreeRemoved).toHaveLength(0); // kept for inspection
  });
});

describe('SwarmCoordinator — autonomy restore respects user intent (S3-13)', () => {
  it('a user flipping fullAutonomy mid-run is NOT clobbered when the run finishes', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const { runId } = coordinator.startSwarm({ tasks: [{ prompt: 'a' }], concurrency: 1, profile: 'full' });
    expect(protocolState.fullAutonomy).toBe(true);

    // The user turns it OFF themselves mid-run.
    protocolState.fullAutonomy = false;
    for (const l of Array.from(autonomyListeners)) l({ fullAutonomy: false });

    calls[0].deferred.resolve({ text: 'done' });
    await flush();
    expect(coordinator.getRun(runId)!.done).toBe(1);
    // The user's OFF wins — the swarm must not switch it back on.
    expect(protocolState.fullAutonomy).toBe(false);
  });

  it('overlapping full-profile runs compose: autonomy stays on until the LAST run finishes', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const r1 = coordinator.startSwarm({ tasks: [{ prompt: 'a' }], concurrency: 1, profile: 'full' });
    const r2 = coordinator.startSwarm({ tasks: [{ prompt: 'b' }], concurrency: 1, profile: 'full' });
    expect(protocolState.fullAutonomy).toBe(true);

    calls[0].deferred.resolve({ text: 'done' });
    await flush();
    expect(protocolState.fullAutonomy).toBe(true); // run 2 still active
    expect(protocolState.fullAutonomy).toBe(true);

    calls[1].deferred.resolve({ text: 'done' });
    await flush();
    expect(protocolState.fullAutonomy).toBe(false); // restored only at the last finish
    void r1; void r2;
  });
});

describe('SwarmCoordinator — profile wiring', () => {
  it("profile 'full' sets the existing fullAutonomy flag and restores it after the run", async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const { runId } = coordinator.startSwarm({ tasks: [{ prompt: 'a' }], concurrency: 1, profile: 'full' });
    expect(protocolState.fullAutonomy).toBe(true);

    calls[0].deferred.resolve({ text: 'done' });
    await flush();
    expect(coordinator.getRun(runId)!.done).toBe(1);
    expect(protocolState.fullAutonomy).toBe(false); // restored
    expect(storeCalls).toContain('setFullAutonomy:true');
    expect(storeCalls).toContain('setFullAutonomy:false');
  });

  it("profile 'auto-read' pre-grants session grants for read-risk tools; 'ask' touches nothing", async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    coordinator.startSwarm({ tasks: [{ prompt: 'a' }], concurrency: 1, profile: 'auto-read' });
    expect(sessionGrants.length).toBeGreaterThan(20);
    expect(sessionGrants.every(g => g.choice === 'session')).toBe(true);
    expect(sessionGrants.some(g => g.scope === 'tool:web_search')).toBe(true);
    expect(sessionGrants.some(g => g.scope === 'tool:filesystem_read')).toBe(true);
    expect(protocolState.fullAutonomy).toBe(false);

    calls[0].deferred.resolve({ text: 'done' });
    await flush();

    const { executor: exec2, calls: calls2 } = makeExecutor();
    const coordinator2 = new SwarmCoordinator({ executor: exec2 });
    coordinator2.startSwarm({ tasks: [{ prompt: 'b' }], concurrency: 1, profile: 'ask' });
    const grantsAfter = sessionGrants.length;
    expect(protocolState.fullAutonomy).toBe(false);
    calls2[0].deferred.resolve({ text: 'done' });
    await flush();
    expect(sessionGrants.length).toBe(grantsAfter); // unchanged
  });
});

describe('SwarmCoordinator — per-task tool allow-list enforcement (the V1 tool defect, fixed by design)', () => {
  it('aborts the lane pre-execution when a tool outside the allow-list is called', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const { runId } = coordinator.startSwarm({
      tasks: [{ prompt: 'research only', persona: 'Atlas', tools: ['web_search', 'read_url'] }],
      concurrency: 1,
      profile: 'ask',
    });
    const taskId = coordinator.getRun(runId)!.tasks[0].id;

    // The restriction reached the system prompt…
    expect(calls[0].systemPrompt).toContain('web_search, read_url');
    // …without a second full buildGiaSystem composed into it (S2-5).
    expect(calls[0].systemPrompt).not.toContain('BASE(');
    // …and the emitted tool call outside it aborts the task BEFORE execution.
    calls[0].onThought!('⚙️ Executing terminal_run...');
    expect(calls[0].signal!.aborted).toBe(true);

    calls[0].deferred.resolve({ text: 'whatever the model said' });
    await flush();

    const record = recordOf(coordinator, runId, taskId);
    expect(record.status).toBe('failed');
    expect(record.error).toContain('Tool policy violation');
    expect(record.error).toContain('terminal_run');
    expect(storeCalls).toContain(`setFailed:${taskId}`);
    expect(storeCalls).not.toContain(`setResult:${taskId}`);
  });

  it('a custom agent\'s declared tools become the enforced allow-list; allowed calls pass', async () => {
    customAgents.set('agent-1', {
      id: 'agent-1', name: 'Librarian', description: 'Reads things', systemPrompt: 'Be tidy.',
      icon: 'BookOpen', tools: ['filesystem_read'],
    });
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const { runId } = coordinator.startSwarm({
      tasks: [{ prompt: 'read the docs', agentId: 'agent-1' }],
      concurrency: 1,
      profile: 'ask',
    });
    expect(calls[0].systemPrompt).toContain('filesystem_read');

    calls[0].onThought!('⚙️ Executing filesystem_read...');
    expect(calls[0].signal!.aborted).toBe(false); // allowed → lane continues

    calls[0].deferred.resolve({ text: 'docs read' });
    await flush();
    expect(recordOf(coordinator, runId, coordinator.getRun(runId)!.tasks[0].id).status).toBe('done');
  });

  it('a lane with a systemPrompt override carries it once — no second buildGiaSystem (S2-5)', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const { runId } = coordinator.startSwarm({
      tasks: [{ prompt: 'a', persona: 'Atlas', systemPrompt: 'Studio lane persona.' }],
      concurrency: 1,
      profile: 'ask',
    });
    // The adapter's instruction and the persona block are present exactly once…
    expect(calls[0].systemPrompt).toContain('Studio lane persona.');
    expect(calls[0].systemPrompt).toContain('swarm agent named Atlas');
    // …and the persona base is NOT composed a second time into the override.
    expect(calls[0].systemPrompt).not.toContain('BASE(');

    calls[0].deferred.resolve({ text: 'ok' });
    await flush();
    expect(recordOf(coordinator, runId, coordinator.getRun(runId)!.tasks[0].id).status).toBe('done');
  });
});

describe('SwarmCoordinator — synthesis + events', () => {
  it('synthesizes role-based results in the SubAgentManager pattern', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const { runId } = coordinator.startSwarm({
      tasks: [
        { prompt: 'research', persona: 'Atlas' },
        { prompt: 'analyze', persona: 'Nova' },
        { prompt: 'break things' },
      ],
      concurrency: 3,
      profile: 'ask',
    });
    calls[0].deferred.resolve({ text: 'Atlas findings' });
    calls[1].deferred.resolve({ text: 'Nova findings' });
    calls[2].deferred.reject(new Error('lane crashed'));
    await flush();

    const synthesis = coordinator.synthesize(runId);
    expect(synthesis).toContain('## Swarm Synthesis');
    expect(synthesis).toContain('2 task(s) succeeded, 1 failed, 0 cancelled');
    expect(synthesis).toContain('Atlas findings');
    expect(synthesis).toContain('Nova findings');
    expect(synthesis).toContain('lane crashed');
    expect(synthesis).toContain('Cross-Evaluation');
  });

  it('returns a fallback synthesis when everything failed', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });

    const { runId } = coordinator.startSwarm({ tasks: [{ prompt: 'a' }], concurrency: 1, profile: 'ask' });
    calls[0].deferred.reject(new Error('nope'));
    await flush();
    expect(coordinator.synthesize(runId)).toContain('All swarm tasks failed');
  });

  it('emits the event stream AgentActivityStrip / W7 UI consumes, and clears the strip line', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });
    const events: SwarmEvent[] = [];
    coordinator.on(e => events.push(e));

    const { runId } = coordinator.startSwarm({ tasks: [{ prompt: 'a', persona: 'Atlas' }], concurrency: 1, profile: 'ask' });
    calls[0].onThought!('Searching the web…');
    expect(stripState.currentTool).toContain('🧵 Swarm');
    expect(stripState.currentTool).toContain('Searching the web…');

    calls[0].deferred.resolve({ text: 'result' });
    await flush();

    const types = events.filter(e => e.runId === runId).map(e => e.type);
    expect(types).toEqual(['run-started', 'task-started', 'task-activity', 'task-completed', 'run-finished']);
    expect(stripState.currentTool).toBeNull();
  });

  it('reports run-window cost through CostTracker', async () => {
    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });
    const { runId } = coordinator.startSwarm({ tasks: [{ prompt: 'a' }], concurrency: 1, profile: 'ask' });
    expect(coordinator.runCost(runId)).toBe(0.42);
    calls[0].deferred.resolve({ text: 'done' });
    await flush();
  });
});

describe('SwarmCoordinator — singleton + store record identity', () => {
  it('exports a shared singleton and never lets persona unknowns crash identity resolution', async () => {
    expect(swarmCoordinator).toBeInstanceOf(SwarmCoordinator);

    const { executor, calls } = makeExecutor();
    const coordinator = new SwarmCoordinator({ executor });
    const { runId } = coordinator.startSwarm({
      tasks: [{ prompt: 'a', persona: 'Totally custom persona text' }],
      concurrency: 1,
      profile: 'ask',
    });
    expect(calls[0].systemPrompt).toContain('Totally custom persona text');
    calls[0].deferred.resolve({ text: 'ok' });
    await flush();
    expect(coordinator.getRun(runId)!.done).toBe(1);
  });
});
