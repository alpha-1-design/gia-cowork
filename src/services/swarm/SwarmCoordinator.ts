import { useAgentTaskStore } from '../../store/useAgentTaskStore';
import { useTrustStore } from '../../store/useTrustStore';
import { useProtocolStore } from '../../store/useProtocolStore';
import { useGiaStore } from '../../store/useGiaStore';
import { useAgentStore } from '../../store/useAgentStore';
import { classifyToolRequest, type PermissionRequest } from '../permissions';
import { AGENT_ROLES } from '../brain/SubAgentManager';
import { createWorktree, removeWorktree } from '../git/worktree';
import { costTracker } from '../CostTracker';
import { genId } from '../../utils/id';

/**
 * SwarmCoordinator — THE one agent engine.
 *
 * V1's audit (task-reports/V1-feature-integrity.md §F) verified that every
 * "engine" in this repo (SubAgentManager batching, runLane lanes, the
 * DispatchBoard's 1:1 calls, autonomy's step executor) converges on the same
 * primitive — a generation through GiaBrain, which runs the full tool loop
 * with Guardian + the permission gate ahead of every tool call. The engines
 * differ only in scheduling and prompt source, and each of them re-implements
 * (or forgets) the same hard parts: cancellation that actually aborts, task
 * records, concurrency, synthesis.
 *
 * This module is the consolidation target: ONE lane scheduler with ONE set of
 * task records that everything else will delegate to. It is deliberately
 * additive — SubAgentManager / runLane / devAgents keep working this task;
 * re-pointing their call sites is REVIEW-2's call (see task-reports/W6-swarm.md
 * for the list of legacy call sites).
 *
 * What is real here, by design (each one fixes a defect V1 verified):
 *
 * - ABORT THAT ABORTS. V1 found that DispatchBoard's ✕ flips a status flag
 *   while the generation keeps running and billing (useAgentTaskStore.cancel
 *   never touches the AbortController — useAgentTaskStore.ts:164-171, and
 *   runLane.ts:17-19 builds a controller nothing aborts). Here every task
 *   owns an AbortController whose signal rides into the execution call
 *   exactly the way ChatModule's Stop works (useChatGeneration.ts:300-313:
 *   `new AbortController()` → `BrainRequest.signal` → ProviderService's
 *   fetches and toolRunner's pre-dispatch checks at toolRunner.ts:394). A
 *   cancelled task's late result is DISCARDED, never appended.
 *
 * - TOOL ALLOW-LISTS THAT ENFORCE. V1 found per-agent tool lists are
 *   prompt-only — no enforcement exists anywhere in the runtime. Enforced
 *   here at TWO points: (1) the task's system prompt carries the restriction,
 *   and (2) mechanically, in the onThought path — GiaBrain emits
 *   `⚙️ Executing <toolId>...` for every parsed tool call BEFORE
 *   ToolExecutionService.execute runs (GiaBrain.ts, sourced from extractToolCalls so every parsed format is announced), so a call outside
 *   the allow-list is caught pre-execution and the lane's AbortController is
 *   aborted before the tool dispatches (toolRunner re-checks the signal at
 *   :394). This is fail-closed for the lane: the whole task fails with a
 *   policy error rather than skipping one call, because skipping a call
 *   mid-loop requires injecting an observation into the running generation,
 *   which needs a toolRunner seam. That granular filter is filed for
 *   REVIEW-2 (task-reports/W6-swarm.md).
 *
 * - KILL SWITCH AS QUEUE GOVERNOR. 'full' and 'auto-read' pre-grant authority
 *   for the swarm's calls, so the armed state is checked before EVERY
 *   dispatch; disarming pauses the queue (running tasks still abort through
 *   the per-tool checks in toolRunner) and re-arming resumes it. Pause, not
 *   cancel — the plan survives.
 *
 * - WORKTREE PER CODE-TASK. Allocated BEFORE execution via the real
 *   services/git/worktree.ts, recorded on the task, released after a clean
 *   completion and kept on failure/cancel for inspection. Allocation failure
 *   degrades to shared space with a warning on the record.
 *
 * A swarm is many calls, not a privilege: every lane's tool calls still pass
 * Guardian + the permission gate inside GiaBrain's tool loop (the invariant
 * V1 verified at toolRunner.ts:248-313), and fullAutonomy here is the
 * existing flag with its existing contract — set for the run, restored after.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** One unit of work in a swarm plan. */
export interface SwarmPlanTask {
  /** Stable id — one is generated when omitted. */
  id?: string;
  /** What this lane should do. */
  prompt: string;
  /**
   * Built-in persona name or role from AGENT_ROLES ('Atlas', 'Skeptic', …)
   * or a free-text persona description. Omit for a plain lane.
   */
  persona?: string;
  /** Custom agent id (useAgentStore) — its systemPrompt and tools apply. */
  agentId?: string;
  /** Give this task its own git worktree for the duration of the run. */
  worktree?: boolean;
  /**
   * Per-task tool allow-list. When the persona/agent specifies tools, they
   * are enforced at execution time — see the module comment for the two
   * enforcement points.
   */
  tools?: string[];
  /** Provider override for this lane; empty = best-available. */
  providerId?: string;
  /**
   * Full system-prompt override for this lane (legacy adapters like the
   * DevStudio lanes carry their own persona instruction). When present it
   * replaces the composed buildGiaSystem prompt; the persona block and tool
   * policy still append so Guardian/gate context is never lost.
   */
  systemPrompt?: string;
}

export interface SwarmPlan {
  tasks: SwarmPlanTask[];
  /** 1-8 lanes at once. Default 4. */
  concurrency?: number;
  /**
   * 'ask': every action prompts as usual (touch nothing).
   * 'auto-read': pre-grant session grants for read-risk tools for this run.
   * 'full': set the existing fullAutonomy flag for the run (restored after).
   * In every profile the kill switch still overrides — see module comment.
   */
  profile: 'ask' | 'auto-read' | 'full';
}

export type SwarmTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface SwarmTaskRecord {
  id: string;
  runId: string;
  prompt: string;
  persona?: string;
  agentId?: string;
  status: SwarmTaskStatus;
  startedAt: number | null;
  endedAt: number | null;
  /** Provider the lane runs against (resolved before dispatch). */
  provider: string;
  error?: string;
  /** Non-fatal degradation, e.g. worktree allocation fell back to shared space. */
  warning?: string;
  /** Path of the task's own worktree, when one was allocated. */
  worktreePath?: string;
  result?: string;
  /** Allow-list enforced for this task, when one applies. */
  toolPolicy?: string[];
}

export interface SwarmRunSummary {
  runId: string;
  done: number;
  failed: number;
  cancelled: number;
  tasks: SwarmTaskRecord[];
}

/**
 * The execution seam. The default implementation runs a full generation
 * through GiaBrain — the same brain the chat path uses, so every lane gets
 * the tool loop, Guardian, the permission gate and the cost choke point.
 * Tests inject a mock executor here instead of mocking the provider graph.
 */
export interface SwarmExecutorRequest {
  prompt: string;
  systemPrompt: string;
  providerId?: string;
  signal?: AbortSignal;
  onThought?: (msg: string) => void;
}

export interface SwarmExecutionResult {
  text: string;
  provider?: string;
  model?: string;
  tokenUsage?: { input: number; output: number };
}

export type SwarmExecutor = (req: SwarmExecutorRequest) => Promise<SwarmExecutionResult>;

export type SwarmEvent =
  | { type: 'run-started'; runId: string; taskIds: string[] }
  | { type: 'task-started'; runId: string; taskId: string }
  | { type: 'task-activity'; runId: string; taskId: string; activity: string }
  | { type: 'task-completed'; runId: string; taskId: string; result: string }
  | { type: 'task-failed'; runId: string; taskId: string; error: string }
  | { type: 'task-cancelled'; runId: string; taskId: string }
  | { type: 'queue-paused'; runId: string; reason: string }
  | { type: 'queue-resumed'; runId: string }
  | { type: 'run-finished'; runId: string; summary: SwarmRunSummary };

/** Worktree seam, backed by the real services/git/worktree.ts by default. */
export interface WorktreeAllocator {
  /** Returns the checkout path on success, or a reason to degrade. */
  allocate(taskId: string, title: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  /** Safe (non-force) teardown; refusals are surfaced, not thrown. */
  release(path: string): Promise<void>;
}

// ── Constants ──────────────────────────────────────────────────────────────

export const SWARM_CONCURRENCY_MIN = 1;
export const SWARM_CONCURRENCY_MAX = 8;
export const SWARM_DEFAULT_CONCURRENCY = 4;

/**
 * Read-risk tool ids whose calls a 'auto-read' profile pre-grants as session
 * grants. Copied from the READ_ONLY_TOOLS set in services/permissions.ts
 * rather than exported from there — permissions.ts is the enforcement
 * surface and warm with concurrent edits; duplicating an id list here is the
 * same deliberate trade A3 made for the Rust gate. Keep in sync.
 */
const READ_ONLY_TOOL_IDS = [
  'filesystem_read', 'list_files', 'web_search', 'read_url', 'browser_navigate',
  'page_info', 'get_environment_info', 'get_user_location', 'search_places',
  'get_directions', 'wikipedia', 'weather', 'define', 'project_context',
  'project_memory_list', 'project_memory_forget', 'task_read', 'note_read',
  'mcp_list_servers', 'mcp_list_tools', 'mcp_server_status', 'mcp_stats',
  'email_list', 'email_read', 'email_search', 'email_status', 'calendar_list_events',
  'calendar_status', 'messaging_status', 'social_list_platforms', 'bible_verse',
  'device_info', 'device_health', 'project_context_list', 'get_temperature',
];

/** Marker prefix so we only ever clear OUR line on the activity strip. */
const STRIP_MARKER = '🧵 Swarm';

// ── Default executor: one GiaBrain generation per lane ─────────────────────

/**
 * The real execution core. GiaBrain.generate is the same call the chat Stop
 * button aborts: `signal` rides BrainRequest.signal into ProviderService's
 * fetches and toolRunner's checks, so cancel(taskId) stops in-flight HTTP and
 * prevents the next tool dispatch. GiaBrain is imported lazily so tests that
 * inject an executor never load the provider graph.
 *
 * Context compaction (W11): this seam takes NO history — a lane is stateless
 * per call — so there is nothing to compact here. The accumulation risk is
 * INSIDE the one generation: the tool loop grows its history with tool
 * output. That loop is GiaBrain's, and GiaBrain.generate now compacts at the
 * top of every iteration (brain/compaction.ts), so a long lane task (web
 * crawls, terminal loops) is covered for free without touching this seam.
 * Custom executors that DO take a history array must apply compactIfNeeded
 * themselves at the same seam (history, resolveActiveContextWindow(),
 * caller-supplied summarize) — the helper is exported for exactly that.
 */
export const defaultSwarmExecutor: SwarmExecutor = async (req) => {
  const GiaBrain = (await import('../GiaBrain')).default;
  const res = await GiaBrain.generate({
    prompt: req.prompt,
    systemPrompt: req.systemPrompt,
    systemPromptMode: 'append',
    providerId: req.providerId || undefined,
    signal: req.signal,
    onThought: req.onThought,
  });
  return {
    text: res.text,
    provider: res.provider,
    model: res.model,
    tokenUsage: res.tokenUsage
      ? { input: res.tokenUsage.input || 0, output: res.tokenUsage.output || 0 }
      : undefined,
  };
};

/** Worktree allocator over the real services/git/worktree.ts API. */
export function createDefaultAllocator(repoRoot: string | null): WorktreeAllocator {
  return {
    async allocate(taskId, title) {
      if (!repoRoot) return { ok: false, error: 'no repository root available for worktree isolation' };
      const result = await createWorktree(repoRoot, taskId, title);
      if (!result.ok || !result.target) return { ok: false, error: result.error || 'worktree allocation failed' };
      return { ok: true, path: result.target.path };
    },
    async release(path) {
      if (!repoRoot) return;
      // Non-force on purpose: a worktree with uncommitted work is the task's
      // work, and the safe removal refuses it instead of destroying it.
      await removeWorktree(repoRoot, path);
    },
  };
}

// ── Prompt + identity composition ──────────────────────────────────────────

interface ResolvedIdentity {
  agentId: string;
  agentName: string;
  agentRole: string;
  agentColor: string;
  agentIcon: string;
  /** Persona/agent instructions appended after the base system prompt. */
  personaBlock: string;
  /** Allow-list from the custom agent record, when it declares one. */
  agentTools?: string[];
}

function resolveIdentity(spec: SwarmPlanTask): ResolvedIdentity {
  if (spec.agentId) {
    const agent = useAgentStore.getState().getAgent(spec.agentId);
    if (agent) {
      return {
        agentId: agent.id,
        agentName: agent.name,
        agentRole: 'Custom agent',
        agentColor: '#8b5cf6',
        agentIcon: agent.icon || 'Bot',
        personaBlock: `\n\nYou are "${agent.name}", a specialized swarm agent.\nPurpose: ${agent.description}\n${agent.systemPrompt}`,
        agentTools: agent.tools.length > 0 ? [...agent.tools] : undefined,
      };
    }
  }

  if (spec.persona) {
    const byName = AGENT_ROLES.find(r => r.name.toLowerCase() === spec.persona!.toLowerCase());
    const byRole = byName ?? AGENT_ROLES.find(r => r.role.toLowerCase() === spec.persona!.toLowerCase());
    if (byRole) {
      return {
        agentId: byRole.name,
        agentName: byRole.name,
        agentRole: byRole.role,
        agentColor: byRole.color,
        agentIcon: byRole.icon,
        personaBlock: `\n\nYou are a swarm agent named ${byRole.name} with the role of ${byRole.role}.\nThinking style: ${byRole.style}\nWork the task from that perspective. Be thorough.`,
      };
    }
    // Free-text persona: carry it verbatim, identity comes from the words.
    return {
      agentId: 'swarm',
      agentName: spec.persona.slice(0, 24),
      agentRole: 'Persona',
      agentColor: '#64748b',
      agentIcon: 'Sparkles',
      personaBlock: `\n\nYou are a swarm agent. Persona: ${spec.persona}. Work the task from that perspective.`,
    };
  }

  return {
    agentId: 'swarm',
    agentName: 'Swarm lane',
    agentRole: 'General',
    agentColor: '#64748b',
    agentIcon: 'Bot',
    personaBlock: '\n\nYou are a swarm agent working one task among several. Focus ONLY on your task; other lanes handle the rest.',
  };
}

function toolPolicyBlock(allowList: string[]): string {
  return `\n\nTOOL RESTRICTION (enforced): you may ONLY call these tools: ${allowList.join(', ')}.` +
    ` Any other tool call violates this task's policy and will abort your task.`;
}

// ── The coordinator ────────────────────────────────────────────────────────

interface SwarmRun {
  runId: string;
  plan: SwarmPlan;
  concurrency: number;
  /** FIFO queue of tasks waiting for a lane. */
  queue: SwarmTaskRecord[];
  records: Map<string, SwarmTaskRecord>;
  specs: Map<string, SwarmPlanTask>;
  controllers: Map<string, AbortController>;
  runningCount: number;
  finished: boolean;
  startedAt: number;
  resolveDone: (summary: SwarmRunSummary) => void;
  /** (S3-13: autonomy save/restore moved to the coordinator — a counter of
   *  active 'full' runs composes overlapping runs and user toggles.) */
  /** This run's latest AgentActivityStrip line (S4-24: keyed per run, so
   *  run A's finishRun can never clear run B's live strip line). */
  stripLine: string | null;
}

export class SwarmCoordinator {
  private runs = new Map<string, SwarmRun>();
  /** Final summaries kept after a run settles, so getRun/synthesize survive
   *  the run's teardown. Bounded — the last N runs only. */
  private finishedRuns = new Map<string, SwarmRunSummary>();
  private static readonly MAX_FINISHED_RUNS = 20;
  private listeners = new Set<(e: SwarmEvent) => void>();
  private executor: SwarmExecutor;
  private allocator: WorktreeAllocator;
  private killSwitchPaused = false;
  /** S3-13: swarm-local pause. The kill switch stays the OWNER's global
   *  stop; the panel's Pause drives this instead of disarming the switch. */
  private localPaused = false;
  /** S3-13: count of active 'full'-profile runs composes overlapping runs. */
  private fullProfileRuns = 0;
  /** S3-18: active 'auto-read' runs — the session grants they minted are
   *  revoked when the LAST one finishes, so 'for this swarm' means exactly
   *  that. The user's own standing grants are untouched (revokeSession
   *  only clears session-scoped entries). */
  private autoReadRuns = 0;
  private fullProfilePrev: boolean | null = null;
  /** User's fullAutonomy intent if they flipped it while a 'full' run was
   *  active — the swarm must never clobber it on finish (was S3-13b). */
  private fullProfileUserTouched: boolean | null = null;
  private unwatchAutonomy: (() => void) | null = null;
  private unwatchTrust: (() => void) | null = null;
  /** Set while one of our lines is on the activity strip. */

  constructor(opts: { executor?: SwarmExecutor; allocator?: WorktreeAllocator } = {}) {
    this.executor = opts.executor ?? defaultSwarmExecutor;
    // The default allocator needs the repo root, which the module wiring (W7)
    // resolves — same pattern useGiaStore.enableWorktree's caller follows.
    this.allocator = opts.allocator ?? createDefaultAllocator(null);
  }

  setAllocator(allocator: WorktreeAllocator) {
    this.allocator = allocator;
  }

  /** Subscribe to swarm events (AgentActivityStrip / Swarm UI in W7). */
  on(listener: (e: SwarmEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: SwarmEvent) {
    for (const l of this.listeners) {
      try { l(e); } catch { /* a broken listener must not kill a lane */ }
    }
  }

  private log(type: 'thought' | 'tool' | 'result' | 'error', content: string) {
    useGiaStore.getState().addConsoleLog({ type, content });
  }

  // ── Starting a run ───────────────────────────────────────────────────────

  startSwarm(plan: SwarmPlan): { runId: string; done: Promise<SwarmRunSummary> } {
    const concurrency = clampConcurrency(plan.concurrency ?? SWARM_DEFAULT_CONCURRENCY);
    const runId = `swarm-${genId()}`;

    const resolveDone = (() => {
      let resolve!: (s: SwarmRunSummary) => void;
      const promise = new Promise<SwarmRunSummary>(r => { resolve = r; });
      return { promise, resolve };
    })();

    const run: SwarmRun = {
      runId, plan, concurrency,
      queue: [], records: new Map(), specs: new Map(), controllers: new Map(),
      runningCount: 0, finished: false, startedAt: Date.now(),
      resolveDone: resolveDone.resolve,
      stripLine: null,
    };
    this.runs.set(runId, run);

    const taskIds: string[] = [];
    for (const spec of plan.tasks) {
      const identity = resolveIdentity(spec);
      // The store's dispatch returns the task id — use it as the record id so
      // the persisted record and the coordinator's record are the SAME record,
      // not two sources of truth. When the caller pre-dispatched (spec.id set,
      // e.g. legacy adapters that already own their store record), skip the
      // dispatch — otherwise the board would show a zombie duplicate.
      const storeId = spec.id
        ? spec.id
        : useAgentTaskStore.getState().dispatch({
        prompt: spec.prompt,
        agentId: identity.agentId,
        agentName: identity.agentName,
        agentRole: identity.agentRole,
        agentColor: identity.agentColor,
        agentIcon: identity.agentIcon,
        providerId: spec.providerId,
      });
      const id = spec.id || storeId;
      const record: SwarmTaskRecord = {
        id, runId,
        prompt: spec.prompt,
        persona: spec.persona,
        agentId: spec.agentId,
        status: 'queued',
        startedAt: null,
        endedAt: null,
        provider: '',
        toolPolicy: spec.tools ?? identity.agentTools,
      };
      run.records.set(id, record);
      run.specs.set(id, spec);
      run.queue.push(record);
      taskIds.push(id);
    }

    this.log('tool', `Swarm ${runId}: ${plan.tasks.length} task(s), ${concurrency} lane(s), profile ${plan.profile}`);
    this.emit({ type: 'run-started', runId, taskIds });

    // Profile wiring. 'ask' touches nothing.
    if (plan.profile === 'full') {
      // fullAutonomy is a global flag with an existing contract (it skips
      // prompts, never the kill switch). S3-13: a COUNTER of active 'full'
      // runs composes overlapping runs, and a watcher records the user's own
      // mid-run flip so finishRun restores to the user's intent, not a stale
      // snapshot (a background run used to silently switch the flag back
      // off under the user's hand).
      if (this.fullProfileRuns === 0) {
        this.fullProfilePrev = useProtocolStore.getState().fullAutonomy;
        this.fullProfileUserTouched = null;
        // The value we are about to write is OURS, not the user's — the
        // watcher must not label the swarm's own set as user intent.
        this.watchAutonomyChanges(true);
      }
      this.fullProfileRuns++;
      useProtocolStore.getState().setFullAutonomy(true);
      this.log('tool', `Swarm ${runId}: FULL ACCESS profile — every tool call runs without prompts. The kill switch still stops everything.`);
    } else if (plan.profile === 'auto-read') {
      if (this.autoReadRuns === 0) this.grantReadProfiles(runId);
      this.autoReadRuns++;
    }

    this.ensureKillSwitchWatch();
    // Sync the pause flag with the actual switch: a stale pause left over from
    // a previous run must not stall this one when the switch is armed again.
    this.killSwitchPaused = !useTrustStore.getState().armed;
    this.pump(run);

    return { runId, done: resolveDone.promise };
  }

  /** 'auto-read': session grants for read-risk tools — they die with the app. */
  private grantReadProfiles(runId: string) {
    const trust = useTrustStore.getState();
    for (const toolId of READ_ONLY_TOOL_IDS) {
      const request: PermissionRequest = classifyToolRequest(toolId, toolId, {});
      trust.grant(request, 'session');
    }
    this.log('tool', `Swarm ${runId}: AUTO-READ profile — session grants pre-granted for ${READ_ONLY_TOOL_IDS.length} read-risk tools; they are revoked when the last auto-read run finishes (S3-18: 'for this swarm' means exactly that).`);
  }

  /** S3-18: retire the auto-read session grants once no auto-read run lives. */
  private maybeRevokeReadProfiles() {
    this.autoReadRuns--;
    if (this.autoReadRuns > 0) return;
    this.autoReadRuns = 0;
    const trust = useTrustStore.getState();
    const revoke = trust.revokeSession ?? trust.revoke;
    for (const toolId of READ_ONLY_TOOL_IDS) {
      revoke(`tool:${toolId}`);
    }
    this.log('tool', "AUTO-READ profile retired — this swarm's read grants were session-scoped and are gone.");
  }

  // ── The lane scheduler ───────────────────────────────────────────────────

  /**
   * FIFO pump: fill up to `concurrency` lanes, one task each. Called after
   * every settle and on resume, so a freed lane pulls the next queued task.
   */
  private pump(run: SwarmRun) {
    if (run.finished) return;

    // Pause only withholds NEW dispatches — a run whose queue is drained and
    // lanes are idle must still settle (finishRun restores the full profile
    // and resolves the done promise), so the check requires pending work.
    if ((this.killSwitchPaused || this.localPaused) && (run.queue.length > 0 || run.runningCount > 0)) {
      this.emit({ type: 'queue-paused', runId: run.runId, reason: 'kill switch disarmed' });
      return;
    }

    while (run.runningCount < run.concurrency) {
      const next = run.queue.shift();
      if (!next) {
        if (run.runningCount === 0) this.finishRun(run);
        return;
      }
      if (next.status !== 'queued') continue; // cancelled while queued
      this.dispatchTask(run, next);
    }
  }

  private dispatchTask(run: SwarmRun, record: SwarmTaskRecord) {
    // Kill switch check BEFORE each dispatch — a profile pre-grants authority,
    // so the armed state is the one thing that must be re-read per task.
    if (!useTrustStore.getState().armed || this.localPaused) {
      // Put it back at the head and pause; re-arm/resume picks up from here.
      run.queue.unshift(record);
      if (!useTrustStore.getState().armed) this.killSwitchPaused = true;
      this.emit({ type: 'queue-paused', runId: run.runId, reason: useTrustStore.getState().armed ? 'swarm paused before dispatch' : 'kill switch disarmed before dispatch' });
      return;
    }

    run.runningCount += 1;
    void this.executeTask(run, record);
  }

  private async executeTask(run: SwarmRun, record: SwarmTaskRecord) {
    const spec = run.specs.get(record.id)!;
    const identity = resolveIdentity(spec);
    const ctrl = new AbortController();
    run.controllers.set(record.id, ctrl);

    // Resolve the provider through the store's real chain (per-task override
    // → per-agent override → best-available) so the record says what ran.
    const provider = spec.providerId || useAgentTaskStore.getState().resolveProvider(record.id) || '';
    record.provider = provider;

    record.status = 'running';
    record.startedAt = Date.now();
    useAgentTaskStore.getState().markRunning(record.id);
    this.emit({ type: 'task-started', runId: run.runId, taskId: record.id });
    this.log('tool', `[${identity.agentName}] starting — ${summarizePrompt(spec.prompt)}`);
    this.updateStrip(run, `${STRIP_MARKER} · ${identity.agentName}: starting…`);

    // Worktree allocation happens BEFORE execution: the lane must run against
    // its own checkout from the first tool call, not from its second prompt.
    if (spec.worktree) {
      try {
        const alloc = await this.allocator.allocate(record.id, spec.prompt);
        if (alloc.ok && alloc.path) {
          record.worktreePath = alloc.path;
          this.log('tool', `[${identity.agentName}] worktree allocated: ${alloc.path}`);
        } else {
          // Degrade to shared space; keep working, but say so on the record.
          record.warning = `Worktree unavailable (${alloc.error || 'unknown reason'}) — running in shared space.`;
          this.log('error', `[${identity.agentName}] ${record.warning}`);
        }
      } catch (e) {
        record.warning = `Worktree allocation error (${e instanceof Error ? e.message : 'unknown'}) — running in shared space.`;
        this.log('error', `[${identity.agentName}] ${record.warning}`);
      }
    }

    const allowList = record.toolPolicy;
    // The base persona is built by the executor itself: defaultSwarmExecutor
    // calls GiaBrain.generate with systemPromptMode 'append', which builds
    // buildGiaSystem(spec.prompt) once and appends the module-specific
    // instructions below. Composing a second full buildGiaSystem here would
    // double the persona for every lane per iteration (REVIEW-2 S2-5), so
    // this carries only the lane's own additions: an adapter's systemPrompt
    // when one was supplied, then the persona block, then the tool policy.
    const systemPrompt = (spec.systemPrompt ? spec.systemPrompt + '\n\n' : '') + identity.personaBlock +
      (allowList && allowList.length > 0 ? toolPolicyBlock(allowList) : '');

    const onThought = (msg: string) => {
      // A cancelled task's in-flight callbacks must not touch its record.
      if (record.status !== 'running') return;
      // Enforcement point 2: GiaBrain announces every parsed tool call here
      // BEFORE ToolExecutionService.execute runs. Anything outside the
      // allow-list aborts the lane pre-execution.
      if (allowList && allowList.length > 0) {
        const m = /^⚙️ Executing (\S+?)\.\.\./.exec(msg);
        if (m && !allowList.includes(m[1])) {
          this.enforceToolPolicy(run, record, ctrl, m[1], allowList);
          return;
        }
      }
      useAgentTaskStore.getState().setActivity(record.id, msg);
      this.emit({ type: 'task-activity', runId: run.runId, taskId: record.id, activity: msg });
      this.updateStrip(run, `${STRIP_MARKER} · ${identity.agentName}: ${msg}`);
    };

    let outcome: SwarmExecutionResult | null = null;
    let failure: string | null = null;
    try {
      outcome = await this.executor({
        prompt: spec.prompt,
        systemPrompt,
        providerId: provider || undefined,
        signal: ctrl.signal,
        onThought,
      });
    } catch (e) {
      // An aborted generation surfaces as AbortError; a cancelled task's
      // rejection lands here and is discarded below — never re-marked.
      failure = e instanceof Error ? e.message : 'Unknown execution error';
    } finally {
      run.controllers.delete(record.id);
    }

    // ── Settle. Single point of lane bookkeeping: the count is decremented
    //    here and only here, so a run stays unfinished until every outcome —
    //    including a cancelled task's late rejection — has actually landed.
    //    The status guard is the late-result guarantee: any resolution
    //    arriving after cancel() (or a mid-flight policy failure) is dropped
    //    without touching the record or the store.
    if (record.status === 'running') {
      if (outcome) {
        record.status = 'done';
        record.result = outcome.text;
        record.endedAt = Date.now();
        useAgentTaskStore.getState().setResult(record.id, outcome.text, outcome.tokenUsage);
        this.log('result', `[${identity.agentName}] done (${formatDuration(record.endedAt - (record.startedAt ?? record.endedAt))})`);
        this.emit({ type: 'task-completed', runId: run.runId, taskId: record.id, result: outcome.text });
        // Deallocation after completion; failure/cancel keep it for inspection.
        if (record.worktreePath) void this.releaseWorktree(record.worktreePath, record);
      } else {
        record.status = 'failed';
        record.error = failure || 'Unknown execution error';
        record.endedAt = Date.now();
        useAgentTaskStore.getState().setFailed(record.id, record.error);
        this.log('error', `[${identity.agentName}] failed: ${record.error}`);
        this.emit({ type: 'task-failed', runId: run.runId, taskId: record.id, error: record.error });
      }
    }

    run.runningCount = Math.max(0, run.runningCount - 1);
    this.pump(run);
  }

  private enforceToolPolicy(
    run: SwarmRun, record: SwarmTaskRecord, ctrl: AbortController, toolId: string, allowList: string[],
  ) {
    if (record.status !== 'running') return;
    record.status = 'failed';
    record.error = `Tool policy violation: "${toolId}" is not in this task's allow-list (${allowList.join(', ')}). The task was aborted before the tool executed.`;
    record.endedAt = Date.now();
    useAgentTaskStore.getState().setFailed(record.id, record.error);
    this.log('error', `Tool policy violation on ${record.id}: ${toolId} not allowed — task aborted.`);
    this.emit({ type: 'task-failed', runId: run.runId, taskId: record.id, error: record.error });
    // The abort is real: signal rides into the execution call (module comment).
    // Lane-slot bookkeeping stays at the settle point, so the run cannot finish
    // (and lose its records) before the aborted generation's rejection lands.
    ctrl.abort();
  }

  private async releaseWorktree(path: string, record: SwarmTaskRecord) {
    try {
      await this.allocator.release(path);
      this.log('tool', `Worktree released: ${path}`);
    } catch (e) {
      record.warning = `${record.warning ? record.warning + ' ' : ''}Worktree cleanup failed: ${e instanceof Error ? e.message : 'unknown'}.`;
    }
  }

  // ── Cancellation ─────────────────────────────────────────────────────────

  /**
   * Cancel one task. Queued: removed without ever starting. Running: the
   * task's AbortController is aborted — the same mechanism as the chat Stop
   * button — the status flips to 'cancelled', and the late result is
   * discarded by the settle guard (never appended).
   */
  cancel(taskId: string): boolean {
    for (const run of this.runs.values()) {
      const record = run.records.get(taskId);
      if (!record) continue;
      const wasRunning = record.status === 'running';
      if (record.status === 'queued') {
        run.queue = run.queue.filter(t => t.id !== taskId);
      } else if (!wasRunning) {
        return false; // already terminal
      }
      record.status = 'cancelled';
      record.endedAt = Date.now();
      useAgentTaskStore.getState().cancel(taskId);
      run.controllers.get(taskId)?.abort();
      run.controllers.delete(taskId);
      this.log('tool', `[${record.persona ?? record.id}] cancelled — generation aborted, late results discarded.`);
      this.emit({ type: 'task-cancelled', runId: run.runId, taskId });
      // runningCount stays as-is on purpose: the settle path owns it, so the
      // run only finishes once the aborted generation's late outcome lands.
      if (wasRunning) this.pump(run);
      return true;
    }
    return false;
  }

  /** Cancel every queued + running task (all runs, or one run when given). */
  cancelAll(runId?: string): void {
    for (const run of this.runs.values()) {
      if (runId && run.runId !== runId) continue;
      for (const record of run.records.values()) {
        if (record.status === 'queued' || record.status === 'running') this.cancel(record.id);
      }
      this.pump(run); // a fully cancelled run settles
    }
  }

  // ── Kill-switch pause ────────────────────────────────────────────────────

  /**
   * The kill switch governs the QUEUE: while disarmed, no new task is
   * dispatched (checked before every dispatch, and via subscription the
   * moment the switch flips). Running tasks are not cancelled here — their
   * tool calls hit the armed check inside toolRunner and get refused, and
   * cancel() remains available for stopping the generations outright.
   */
  private ensureKillSwitchWatch() {
    if (this.unwatchTrust) return;
    this.unwatchTrust = useTrustStore.subscribe((state) => {
      if (!state.armed && this.hasActiveWork()) {
        this.killSwitchPaused = true;
        for (const run of this.runs.values()) {
          if (!run.finished) this.emit({ type: 'queue-paused', runId: run.runId, reason: 'kill switch disarmed' });
        }
      } else if (state.armed && this.killSwitchPaused) {
        this.killSwitchPaused = false;
        for (const run of this.runs.values()) {
          if (!run.finished) {
            this.emit({ type: 'queue-resumed', runId: run.runId });
            this.pump(run);
          }
        }
      }
    });
  }

  private hasActiveWork(): boolean {
    for (const run of this.runs.values()) {
      if (run.finished) continue;
      if (run.queue.length > 0 || run.runningCount > 0) return true;
    }
    return false;
  }

  /** Manual resume (mirrors re-arming the kill switch). */
  /** S3-13: the watcher records any fullAutonomy write that did not come
   *  from the swarm itself — that is the user's live intent, and finishRun
   *  restores to it instead of the pre-run snapshot. */
  private watchAutonomyChanges(swarmWrites: boolean) {
    if (this.unwatchAutonomy) return;
    if (typeof useProtocolStore.subscribe !== 'function') return;
    let lastSwarmWrite = swarmWrites;
    this.unwatchAutonomy = useProtocolStore.subscribe((state) => {
      if (state.fullAutonomy !== lastSwarmWrite) {
        this.fullProfileUserTouched = state.fullAutonomy;
        lastSwarmWrite = state.fullAutonomy;
      }
    });
  }

  /** S3-13: swarm-local pause — holds new dispatches, plans survive, the
   *  trust kill switch is untouched. */
  pause(): void {
    this.localPaused = true;
    for (const run of this.runs.values()) {
      if (!run.finished && (run.queue.length > 0 || run.runningCount > 0)) {
        this.emit({ type: 'queue-paused', runId: run.runId, reason: 'swarm paused' });
      }
    }
  }

  isPaused(): boolean {
    return this.localPaused;
  }

  resume(): void {
    this.localPaused = false;
    this.killSwitchPaused = false;
    for (const run of this.runs.values()) {
      if (!run.finished) {
        this.emit({ type: 'queue-resumed', runId: run.runId });
        this.pump(run);
      }
    }
  }

  // ── Run lifecycle ────────────────────────────────────────────────────────

  private finishRun(run: SwarmRun) {
    if (run.finished) return;
    run.finished = true;
    if (run.plan.profile === 'full') {
      this.fullProfileRuns--;
      if (this.fullProfileRuns <= 0) {
        this.fullProfileRuns = 0;
        this.unwatchAutonomy?.();
        this.unwatchAutonomy = null;
        // Restore only to what the user last meant: a stale snapshot would
        // clobber their mid-run flip in either direction.
        useProtocolStore.getState().setFullAutonomy(
          this.fullProfileUserTouched ?? this.fullProfilePrev ?? false,
        );
      }
    } else if (run.plan.profile === 'auto-read') {
      // S3-18: retire the session grants at the LAST auto-read run's finish.
      this.maybeRevokeReadProfiles();
    }
    if (run.stripLine && useGiaStore.getState().currentTool === run.stripLine) {
      useGiaStore.getState().setCurrentTool(null);
      run.stripLine = null;
    }
    if (!this.hasActiveWork() && this.unwatchTrust) {
      this.unwatchTrust();
      this.unwatchTrust = null;
    }
    const summary = this.summarize(run);
    this.log('result', `Swarm ${run.runId} finished: ${summary.done} done, ${summary.failed} failed, ${summary.cancelled} cancelled.`);
    this.emit({ type: 'run-finished', runId: run.runId, summary });
    run.resolveDone(summary);
    this.runs.delete(run.runId);
    this.finishedRuns.set(run.runId, summary);
    if (this.finishedRuns.size > SwarmCoordinator.MAX_FINISHED_RUNS) {
      const oldest = this.finishedRuns.keys().next().value;
      if (oldest) this.finishedRuns.delete(oldest);
    }
  }

  private summarize(run: SwarmRun): SwarmRunSummary {
    const tasks = Array.from(run.records.values());
    return {
      runId: run.runId,
      done: tasks.filter(t => t.status === 'done').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      cancelled: tasks.filter(t => t.status === 'cancelled').length,
      tasks,
    };
  }

  /** Live run, or the retained final summary once the run has settled. */
  getRun(runId: string): SwarmRunSummary | undefined {
    const run = this.runs.get(runId);
    return run ? this.summarize(run) : this.finishedRuns.get(runId);
  }

  getTasks(runId?: string): SwarmTaskRecord[] {
    const out: SwarmTaskRecord[] = [];
    for (const run of this.runs.values()) {
      if (runId && run.runId !== runId) continue;
      out.push(...run.records.values());
    }
    return out;
  }

  /**
   * Cost for this run, from CostTracker's real summary API scoped to the
   * run's start time. NOTE: CostTracker keys entries by sessionId, not by
   * lane, so exact per-lane attribution is not available with its API today —
   * this returns the run-window spend, and per-lane tagging is filed for
   * REVIEW-2 (task-reports/W6-swarm.md).
   */
  runCost(runId: string): number {
    const run = this.runs.get(runId);
    if (!run) return 0;
    return costTracker.getSummary(run.startedAt).totalCost;
  }

  // ── Synthesis ────────────────────────────────────────────────────────────

  /**
   * Role-based synthesis in the SubAgentManager.synthesize pattern: per-agent
   * sections labelled with role and duration, then a cross-evaluation
   * instruction. Extended for swarms: worktree isolation and failure context
   * are surfaced, because a lane that fell back to shared space or died on a
   * policy violation changes how the main agent should weigh the findings.
   */
  synthesize(runId: string): string {
    // Reads live records first, then the retained final summary — a run that
    // settled between the last result and this call must still synthesize.
    const tasks = this.getTasks(runId).length > 0
      ? this.getTasks(runId)
      : (this.getRun(runId)?.tasks ?? []);
    const completed = tasks.filter(t => t.status === 'done' && t.result);
    const failed = tasks.filter(t => t.status === 'failed');
    const cancelled = tasks.filter(t => t.status === 'cancelled');

    if (completed.length === 0) {
      return 'All swarm tasks failed or were cancelled. Use your own knowledge to respond.';
    }

    let summary = `## Swarm Synthesis\n\n`;
    summary += `${completed.length} task(s) succeeded, ${failed.length} failed, ${cancelled.length} cancelled.\n\n`;

    for (const t of completed) {
      const label = t.persona ?? t.agentId ?? t.id;
      const dur = t.startedAt && t.endedAt ? formatDuration(t.endedAt - t.startedAt) : '?';
      summary += `### ${label} — ${dur}${t.worktreePath ? ` (worktree: ${t.worktreePath})` : ''}\n\n`;
      summary += `${t.result}\n\n---\n\n`;
    }

    if (failed.length > 0) {
      summary += `### Failed lanes\n\n`;
      for (const t of failed) {
        summary += `- ${t.persona ?? t.id}: ${t.error ?? 'unknown error'}\n`;
      }
      summary += `\nTreat failed lanes as gaps in coverage, not as evidence.\n\n`;
    }

    if (cancelled.length > 0) {
      summary += `### Cancelled lanes\n\n${cancelled.map(t => `- ${t.persona ?? t.id}`).join('\n')}\n\n`;
    }

    summary += `### Cross-Evaluation\n\n`;
    summary += `Review all agent findings. Note areas of agreement and disagreement.`;
    summary += ` Findings validated by multiple agents carry more weight.`;
    summary += ` Conflicts should be called out with the reasoning from each side.`;
    summary += `\n\nWeigh the evidence and produce a final answer that synthesizes the best insights.`;

    return summary;
  }

  // ── Activity strip ───────────────────────────────────────────────────────

  /**
   * AgentActivityStrip reads useGiaStore.currentTool — a single line. A swarm
   * is many lanes, so ours carries the swarm marker and the busiest lane's
   * latest activity; the run's finish clears it only if it is still ours.
   */
  private updateStrip(run: SwarmRun, line: string) {
    run.stripLine = line;
    useGiaStore.getState().setCurrentTool(line);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return SWARM_DEFAULT_CONCURRENCY;
  return Math.min(SWARM_CONCURRENCY_MAX, Math.max(SWARM_CONCURRENCY_MIN, Math.floor(n)));
}

function summarizePrompt(prompt: string): string {
  const line = prompt.trim().split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** App-wide singleton — one engine, one queue, one set of task records. */
export const swarmCoordinator = new SwarmCoordinator();
export default swarmCoordinator;
