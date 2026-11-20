import React from 'react';
import { motion } from 'motion/react';
import { Play, Pause, Square, X, Minus, Plus, Layers, GitBranch, Copy, Check, ShieldAlert } from 'lucide-react';
import BotAvatar, { BOT_STATUS_COLOR, type BotStatus } from '../avatars/BotAvatar';
import {
  swarmCoordinator,
  createDefaultAllocator,
  type SwarmCoordinator,
  type SwarmTaskRecord,
  type SwarmPlan,
} from '../../services/swarm/SwarmCoordinator';
import { useTrustStore } from '../../store/useTrustStore';
import { useProjectContextStore } from '../../store/useProjectContextStore';

/**
 * SwarmPanel — THE one home for the swarm UI.
 *
 * Designed to mount as a tab inside AgentsModule (see task-reports/
 * W7-swarmui.md for the exact mount line). Everything here drives the landed
 * SwarmCoordinator API — the ONE agent engine from W6 — and nothing else:
 *
 *   - Start parses the plan (one prompt per line, optional single-word
 *     persona prefix like "Researcher: …") into a SwarmPlan and calls
 *     startSwarm. The repo root for per-task worktrees is resolved here the
 *     same way WorktreeToggle resolves it (project context entry) and handed
 *     to the coordinator's allocator seam — module wiring W6 left to W7.
 *   - Pause/Resume drive the coordinator's DESIGNED queue governor: the
 *     trust kill switch. W6 built pause as "disarm pauses the queue, the
 *     plan survives; re-arm resumes", so the panel surfaces exactly that,
 *     labeled for what it is (a global pause, not a swarm-local one). A
 *     swarm-local pause needs a public pause() on the coordinator and is
 *     filed for REVIEW-2.
 *   - Per-row ✕ calls coordinator.cancel(taskId) — the cancel that actually
 *     aborts the generation (V1 finding #1), not a status-flag flip.
 *   - Cancel-all calls coordinator.cancelAll(runId).
 *   - Rows are a pure projection of the coordinator's task records: the
 *     panel re-snapshots getTasks() on every swarm event, so the coordinator
 *     stays the single source of truth. The `task-activity` stream is kept
 *     as a per-lane log tail (last 40 lines) for the details drawer.
 *   - Cost is coordinator.runCost(runId) — the run-window spend (CostTracker
 *     keys by session, per-lane attribution is W6's filed REVIEW-2 gap).
 *
 * Visual standard: var(--gia-*) tokens, motion for status transitions,
 * fixed 56px rows so status changes never shift layout, tabular-nums on
 * every number, and simple windowing once the lane list passes ~60 rows
 * (the repo has no list virtualization to reuse — MessageList renders all).
 * BotAvatars animate only while fewer than 50 rows are visible, to protect
 * the frame budget in a 200-lane grid.
 */

// ── Constants ──────────────────────────────────────────────────────────────

const ROW_HEIGHT = 56;
/** Window only beyond this many rows; below it, plain rendering is cheaper. */
const VIRTUALIZE_THRESHOLD = 60;
/** Rows rendered above/below the viewport when windowing. */
const OVERSCAN = 6;
/** Idle BotAvatar motion is switched off beyond this many visible rows. */
const ANIMATE_ROWS_LIMIT = 50;
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 8;
const CONCURRENCY_DEFAULT = 4;
/** Log tail kept per lane for the details drawer. */
const LOG_TAIL_LINES = 40;
const LOG_TAIL_SHOWN = 12;

// ── Plan parsing ───────────────────────────────────────────────────────────

export interface ParsedPlanLine {
  persona?: string;
  prompt: string;
}

/**
 * One prompt per line; an optional single-word persona prefix ("Researcher:
 * …", "Atlas: …") shapes the lane's bot and thinking style. The prefix must
 * be a single word so ordinary sentences that open with a colon ("Fix bug:
 * handle edge cases") keep their whole prompt.
 */
export function parsePlanLine(line: string): ParsedPlanLine {
  const trimmed = line.trim();
  if (!trimmed) return { prompt: '' };
  const idx = trimmed.indexOf(':');
  if (idx > 0) {
    const head = trimmed.slice(0, idx).trim();
    const rest = trimmed.slice(idx + 1).trim();
    if (rest && /^[A-Za-z][A-Za-z-]{0,23}$/.test(head)) {
      return { persona: head, prompt: rest };
    }
  }
  return { prompt: trimmed };
}

export function parsePlan(text: string): ParsedPlanLine[] {
  return text
    .split('\n')
    .map(parsePlanLine)
    .filter(p => p.prompt.length > 0);
}

// ── Windowing util ─────────────────────────────────────────────────────────

/** Visible slice for a fixed-row-height list. Simple, dependency-free. */
export function virtualRange(
  scrollTop: number, viewportHeight: number, count: number, rowHeight: number, overscan = OVERSCAN,
): { start: number; end: number } {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const end = Math.min(count, first + visible);
  return { start: first, end };
}

// ── Formatting ─────────────────────────────────────────────────────────────

const STATUS_WORD: Record<SwarmTaskRecord['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Status word → the avatar's BotStatus vocabulary. */
function toBotStatus(status: SwarmTaskRecord['status']): BotStatus {
  return status; // the unions match 1:1 by design
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

// ── Profile metadata (warnings reuse TrustGate's full-autonomy copy) ───────

type SwarmProfile = SwarmPlan['profile'];

const PROFILES: { id: SwarmProfile; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask every action', hint: 'Every tool call stops for your approval, as usual.' },
  {
    id: 'auto-read',
    label: 'Auto-allow reads',
    hint: 'Read-only tools run without prompts for this swarm (session grants, expire with the app). Writes still ask.',
  },
  { id: 'full', label: 'Full access', hint: '' }, // hint renders in the red card below
];

/** The same warnings TrustGate/Protocols shows for full autonomy. */
const FULL_ACCESS_WARNINGS = [
  'GIA runs every tool call without asking — for every lane in this swarm at once.',
  'The kill switch still works. This only skips the prompts.',
  'A swarm is many calls, not a privilege. Arm this only when you trust the whole plan.',
];

// ── Component ──────────────────────────────────────────────────────────────

const SwarmPanel: React.FC<{ coordinator?: SwarmCoordinator }> = ({ coordinator = swarmCoordinator }) => {
  const [planText, setPlanText] = React.useState('');
  const [concurrency, setConcurrency] = React.useState(CONCURRENCY_DEFAULT);
  const [profile, setProfile] = React.useState<SwarmProfile>('ask');

  const [runId, setRunId] = React.useState<string | null>(null);
  const [runFinished, setRunFinished] = React.useState(false);
  const [tasks, setTasks] = React.useState<SwarmTaskRecord[]>([]);
  const [latestActivity, setLatestActivity] = React.useState<Record<string, string>>({});
  const [pausedReason, setPausedReason] = React.useState<string | null>(null);
  const [cost, setCost] = React.useState(0);
  const [now, setNow] = React.useState(() => Date.now());
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [synthesisCopied, setSynthesisCopied] = React.useState(false);

  const armed = useTrustStore(s => s.armed);
  const setArmed = useTrustStore(s => s.setArmed);

  const runIdRef = React.useRef<string | null>(null);
  const logTailRef = React.useRef<Map<string, string[]>>(new Map());
  const planRef = React.useRef<HTMLTextAreaElement>(null);

  // The coordinator's records are mutated in place, so the panel copies them
  // on every event — the coordinator stays the single source of truth.
  // `forcedId`: run-started fires SYNCHRONOUSLY inside startSwarm, before
  // handleStart can set runIdRef — so that event passes its runId directly
  // (reading the ref there would no-op the very first snapshot).
  const snapshot = React.useCallback((forcedId?: string) => {
    const id = forcedId ?? runIdRef.current;
    if (!id) return;
    const fresh = coordinator.getTasks(id);
    if (fresh.length > 0) setTasks(fresh.map(t => ({ ...t })));
  }, [coordinator]);

  // ── Event stream ──
  React.useEffect(() => {
    return coordinator.on(e => {
      switch (e.type) {
        case 'run-started':
          runIdRef.current = e.runId;
          setRunId(e.runId);
          setRunFinished(false);
          setPausedReason(null);
          setCost(0);
          logTailRef.current = new Map();
          snapshot(e.runId);
          break;
        case 'task-started':
        case 'task-completed':
        case 'task-failed':
        case 'task-cancelled':
          snapshot();
          break;
        case 'task-activity': {
          setLatestActivity(prev => ({ ...prev, [e.taskId]: e.activity }));
          const tail = logTailRef.current.get(e.taskId) ?? [];
          tail.push(e.activity);
          if (tail.length > LOG_TAIL_LINES) tail.splice(0, tail.length - LOG_TAIL_LINES);
          logTailRef.current.set(e.taskId, tail);
          break;
        }
        case 'queue-paused':
          setPausedReason(e.reason);
          break;
        case 'queue-resumed':
          setPausedReason(null);
          break;
        case 'run-finished':
          snapshot();
          setRunFinished(true);
          break;
      }
    });
  }, [coordinator, snapshot]);

  // ── Live cost (run-window spend) + elapsed tick ──
  const runActive = runId !== null && !runFinished;
  React.useEffect(() => {
    if (!runActive || !runId) return;
    const pullCost = () => setCost(coordinator.runCost(runId));
    pullCost();
    const timer = window.setInterval(pullCost, 2000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(timer); window.clearInterval(tick); };
  }, [runActive, runId, coordinator]);

  // ── Virtualization state ──
  const listRef = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewportH, setViewportH] = React.useState(0);
  React.useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Measure when the list mounts late (first rows arrive with the first
    // run) and on resize; headless DOM reports 0, which falls back below.
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tasks.length > 0]);

  const windowed = tasks.length > VIRTUALIZE_THRESHOLD;
  // Viewport height, measured if possible, else a sane default so windowing
  // still renders a leading slice instead of nothing in headless DOM.
  const vpH = viewportH || (listRef.current?.clientHeight ?? 0) || 600;
  const { start: rowStart, end: rowEnd } = virtualRange(scrollTop, vpH, tasks.length, ROW_HEIGHT);
  const visibleTasks = windowed ? tasks.slice(rowStart, rowEnd) : tasks;
  const animateRows = tasks.length <= ANIMATE_ROWS_LIMIT;

  // ── Actions ──
  const parsedPlan = React.useMemo(() => parsePlan(planText), [planText]);

  const handleStart = React.useCallback(() => {
    if (parsedPlan.length === 0) return;
    // Worktree seam wiring (what W6 left to W7): resolve THIS project's repo
    // root the same way WorktreeToggle does and hand the coordinator a real
    // allocator. Tasks without worktree:true never touch it.
    const repoRoot = useProjectContextStore.getState().entry?.path ?? null;
    coordinator.setAllocator(createDefaultAllocator(repoRoot));
    const { runId: id } = coordinator.startSwarm({
      tasks: parsedPlan.map(p => ({ prompt: p.prompt, persona: p.persona })),
      concurrency,
      profile,
    });
    // run-started (emitted synchronously inside startSwarm) sets the state.
    runIdRef.current = id;
  }, [parsedPlan, concurrency, profile, coordinator]);

  const handlePauseResume = React.useCallback(() => {
    // The coordinator's pause governor is the trust kill switch (W6 design:
    // disarm = pause the queue, the plan survives; re-arm = resume).
    if (armed) {
      setArmed(false);
    } else {
      setArmed(true);
      coordinator.resume();
    }
  }, [armed, setArmed, coordinator]);

  const handleCancelAll = React.useCallback(() => {
    coordinator.cancelAll(runIdRef.current ?? undefined);
  }, [coordinator]);

  const paused = runActive && (!armed || pausedReason !== null);

  const selected = tasks.find(t => t.id === selectedId) ?? null;
  const runningCount = tasks.filter(t => t.status === 'running').length;
  const queuedCount = tasks.filter(t => t.status === 'queued').length;

  return (
    <div className="relative flex flex-col h-full overflow-hidden" style={{ background: 'var(--gia-bg)' }}>
      {/* ── Control bar ── */}
      <div className="shrink-0 px-4 pt-3 pb-3" style={{ borderBottom: '1px solid var(--gia-border)' }}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Layers size={13} style={{ color: 'var(--gia-muted)' }} />
            <span className="text-[12px] font-medium" style={{ color: 'var(--gia-text)' }}>Swarm</span>
            {runId && (
              <span className="text-[10px] font-mono tabular-nums" style={{ color: 'var(--gia-muted-2)' }}>
                {runId.slice(0, 13)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {runActive && (
              <span className="text-[10px] tabular-nums" style={{ color: 'var(--gia-muted)' }} aria-label="Run cost">
                {formatCost(cost)}
              </span>
            )}
          </div>
        </div>

        <textarea
          ref={planRef}
          value={planText}
          onChange={e => setPlanText(e.target.value)}
          rows={3}
          placeholder={'One prompt per line. Optional persona prefix:\nResearcher: map the competitor landscape\nFix the flaky CI test'}
          className="gia-input w-full text-[12px] leading-relaxed resize-none px-3 py-2 rounded-lg"
          style={{ background: 'var(--gia-surface)', color: 'var(--gia-text)', border: '1px solid var(--gia-border)' }}
        />

        <div className="flex items-center justify-between mt-2 flex-wrap gap-2">
          {/* Concurrency stepper */}
          <div
            className="flex items-center gap-1 rounded-lg px-1 py-0.5"
            style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }}
            aria-label="Concurrency"
          >
            <button
              onClick={() => setConcurrency(c => Math.max(CONCURRENCY_MIN, c - 1))}
              disabled={concurrency <= CONCURRENCY_MIN}
              className="w-6 h-6 rounded-md flex items-center justify-center disabled:opacity-40"
              style={{ color: 'var(--gia-muted)' }}
              aria-label="Fewer lanes"
            >
              <Minus size={11} />
            </button>
            <span className="text-[11px] tabular-nums w-9 text-center" style={{ color: 'var(--gia-text)' }}>
              {concurrency} lane{concurrency === 1 ? '' : 's'}
            </span>
            <button
              onClick={() => setConcurrency(c => Math.min(CONCURRENCY_MAX, c + 1))}
              disabled={concurrency >= CONCURRENCY_MAX}
              className="w-6 h-6 rounded-md flex items-center justify-center disabled:opacity-40"
              style={{ color: 'var(--gia-muted)' }}
              aria-label="More lanes"
            >
              <Plus size={11} />
            </button>
          </div>

          {/* Profile selector */}
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Permission profile">
            {PROFILES.map(p => {
              const active = profile === p.id;
              const danger = p.id === 'full';
              return (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={active}
                  onClick={() => setProfile(p.id)}
                  className="h-7 px-2.5 rounded-lg text-[11px] font-medium transition-colors"
                  style={active
                    ? {
                        background: danger ? 'rgba(239,68,68,0.16)' : 'var(--gia-accent)',
                        color: danger ? '#f87171' : 'var(--gia-accent-contrast)',
                        border: `1px solid ${danger ? 'rgba(239,68,68,0.4)' : 'var(--gia-accent)'}`,
                      }
                    : {
                        color: danger ? '#f87171' : 'var(--gia-muted)',
                        border: '1px solid var(--gia-border)',
                      }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          {/* Run controls */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleStart}
              disabled={parsedPlan.length === 0}
              className="h-7 px-3 rounded-lg text-[11px] font-medium flex items-center gap-1.5 disabled:opacity-40"
              style={{ background: 'var(--gia-accent)', color: 'var(--gia-accent-contrast)' }}
            >
              <Play size={11} /> Start
            </button>
            <button
              onClick={handlePauseResume}
              disabled={!runActive}
              className="h-7 px-2.5 rounded-lg text-[11px] flex items-center gap-1.5 disabled:opacity-40"
              style={{
                border: '1px solid var(--gia-border)',
                color: paused ? '#f59e0b' : 'var(--gia-text)',
              }}
              title={paused
                ? 'Resume — re-arms the kill switch and releases the queue'
                : 'Pause — uses the app kill switch: GIA pauses everywhere, not just this swarm. The plan survives.'}
            >
              {paused ? <Play size={11} /> : <Pause size={11} />} {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              onClick={handleCancelAll}
              disabled={!runActive || (runningCount === 0 && queuedCount === 0)}
              className="h-7 px-2.5 rounded-lg text-[11px] flex items-center gap-1.5 disabled:opacity-40"
              style={{ border: '1px solid rgba(239,68,68,0.25)', color: '#f87171' }}
            >
              <Square size={10} /> Cancel all
            </button>
          </div>
        </div>

        {/* Full-access warning card — red-tinted, same warnings TrustGate shows */}
        {profile === 'full' && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="mt-2 p-2.5 rounded-lg flex gap-2"
            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}
          >
            <ShieldAlert size={14} className="shrink-0 mt-0.5" style={{ color: '#f87171' }} />
            <div className="space-y-0.5">
              {FULL_ACCESS_WARNINGS.map((w, i) => (
                <p key={i} className="text-[10px] leading-relaxed" style={{ color: '#f87171' }}>{w}</p>
              ))}
            </div>
          </motion.div>
        )}

        {/* Paused banner */}
        {paused && (
          <div className="mt-2 px-2.5 py-1.5 rounded-lg text-[10px] flex items-center gap-1.5"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', color: '#f59e0b' }}>
            <Pause size={10} />
            <span>
              Queue paused{pausedReason ? ` — ${pausedReason}` : ''}. Queued lanes hold their place; the plan survives.
              Re-arm (Resume) to release the queue.
            </span>
          </div>
        )}
      </div>

      {/* ── Lane grid ── */}
      {tasks.length === 0 ? (
        <div className="relative flex-1 flex flex-col items-center justify-center gap-5 text-center px-6 overflow-hidden gia-workspace-grid">
          <div className="w-16 h-16 rounded-lg flex items-center justify-center"
            style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border-2)' }}>
            <Layers size={28} style={{ color: 'var(--gia-text)' }} />
          </div>
          <div className="space-y-1.5">
            <p className="gia-display text-[28px] sm:text-[32px] leading-tight" style={{ color: 'var(--gia-text)' }}>
              Deploy a swarm
            </p>
            <p className="text-xs max-w-md leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
              One prompt per line — each line becomes a lane with its own bot. Prefix with a persona
              like <span style={{ color: 'var(--gia-text)' }}>Researcher:</span> to shape it. Lanes run side by
              side through the same brain, the same guardrails, the same gate.
            </p>
          </div>
          <button
            onClick={() => planRef.current?.focus()}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-md text-xs font-semibold transition-opacity tap-feedback hover:opacity-90"
            style={{ background: 'var(--gia-accent)', color: 'var(--gia-accent-contrast)' }}
          >
            <Play size={13} /> Write the plan
          </button>
        </div>
      ) : (
        <div
          ref={listRef}
          onScroll={e => setScrollTop((e.target as HTMLDivElement).scrollTop)}
          className="flex-1 overflow-y-auto"
        >
          <div style={{ height: tasks.length * ROW_HEIGHT, position: 'relative' }}>
            {visibleTasks.map((record, i) => {
              const index = windowed ? rowStart + i : i;
              return (
                <LaneRow
                  key={record.id}
                  record={record}
                  index={index}
                  activity={latestActivity[record.id]}
                  animate={animateRows}
                  now={now}
                  selected={record.id === selectedId}
                  onOpen={() => setSelectedId(record.id)}
                  onCancel={() => coordinator.cancel(record.id)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* ── Details drawer ── */}
      {selected && (
        <LaneDrawer
          record={selected}
          logTail={logTailRef.current.get(selected.id) ?? []}
          runId={runId}
          coordinator={coordinator}
          copied={synthesisCopied}
          onCopied={() => { setSynthesisCopied(true); window.setTimeout(() => setSynthesisCopied(false), 1600); }}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
};

// ── Lane row ───────────────────────────────────────────────────────────────

const LaneRow: React.FC<{
  record: SwarmTaskRecord;
  index: number;
  activity?: string;
  animate: boolean;
  now: number;
  selected: boolean;
  onOpen: () => void;
  onCancel: () => void;
}> = ({ record, index, activity, animate, now, selected, onOpen, onCancel }) => {
  const statusColor = BOT_STATUS_COLOR[toBotStatus(record.status)];
  const name = record.persona
    ?? (record.agentId && record.agentId !== 'swarm' ? record.agentId : `Lane ${index + 1}`);
  const live = record.status === 'running' && record.startedAt !== null;
  const elapsed = live
    ? formatElapsed(now - record.startedAt!)
    : record.startedAt !== null && record.endedAt !== null
      ? formatElapsed(record.endedAt - record.startedAt)
      : null;
  const label = activity
    ?? (record.status === 'done' ? 'Finished'
      : record.status === 'failed' ? record.error ?? 'Failed'
      : record.status === 'cancelled' ? 'Cancelled'
      : record.status === 'queued' ? 'Queued — waiting for a lane'
      : 'Starting…');
  const cancellable = record.status === 'queued' || record.status === 'running';

  const meta = [
    record.provider || 'auto',
    record.worktreePath ? 'worktree' : null,
    record.toolPolicy && record.toolPolicy.length > 0 ? `${record.toolPolicy.length} tools` : null,
  ].filter(Boolean).join(' · ');

  return (
    <motion.div
      data-lane-row={record.id}
      onClick={onOpen}
      initial={false}
      className="absolute left-0 right-0 flex items-center gap-3 px-4 cursor-pointer"
      style={{
        top: index * ROW_HEIGHT,
        height: ROW_HEIGHT,
        background: selected ? 'var(--gia-surface-2)' : 'transparent',
        borderBottom: '1px solid var(--gia-border)',
      }}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}
    >
      {/* Avatar + thin status ring — fixed box, so status changes never shift layout */}
      <div className="relative shrink-0" style={{ width: 46, height: 46 }}>
        <motion.div
          className="absolute rounded-full pointer-events-none"
          style={{ inset: 1, border: `1.5px solid ${statusColor}`, opacity: record.status === 'queued' ? 0.25 : 0.6 }}
          {...(record.status === 'running'
            ? { animate: { opacity: [0.25, 0.75, 0.25] }, transition: { duration: 1.6, repeat: Infinity, ease: 'easeInOut' } }
            : {})}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <BotAvatar
            agentId={record.id}
            role={record.persona}
            status={toBotStatus(record.status)}
            size={40}
            animate={animate}
          />
        </div>
      </div>

      {/* Name + role/meta */}
      <div className="min-w-0" style={{ width: 148 }}>
        <p className="text-[12px] font-medium truncate" style={{ color: 'var(--gia-text)' }}>{name}</p>
        <p className="text-[9px] truncate mt-0.5" style={{ color: 'var(--gia-muted-2)' }}>{meta || 'shared space'}</p>
      </div>

      {/* Status word — fixed-width box, motion fade on change, no layout shift */}
      <div className="relative shrink-0" style={{ width: 66 }}>
        <motion.span
          key={record.status}
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="absolute left-0 text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: statusColor }}
        >
          {STATUS_WORD[record.status]}
        </motion.span>
      </div>

      {/* Live label — current step from the task record stream */}
      <p className="flex-1 min-w-0 text-[11px] truncate" style={{ color: 'var(--gia-muted)' }} title={label}>
        {label}
      </p>

      {/* Elapsed — tabular-nums so digits never jitter */}
      <span className="shrink-0 text-[10px] font-mono tabular-nums text-right" style={{ color: 'var(--gia-muted-2)', width: 52 }}>
        {elapsed ?? ''}
      </span>

      {/* Per-row cancel — the coordinator's cancel, which actually aborts */}
      {cancellable ? (
        <button
          onClick={e => { e.stopPropagation(); onCancel(); }}
          className="w-7 h-7 shrink-0 rounded-md flex items-center justify-center hover:bg-red-500/10"
          style={{ color: 'var(--gia-muted-2)' }}
          aria-label={`Cancel ${name}`}
          title="Cancel lane — aborts the running generation"
        >
          <X size={13} />
        </button>
      ) : (
        <span className="w-7 shrink-0" />
      )}
    </motion.div>
  );
};

// ── Details drawer ─────────────────────────────────────────────────────────

const LaneDrawer: React.FC<{
  record: SwarmTaskRecord;
  logTail: string[];
  runId: string | null;
  coordinator: SwarmCoordinator;
  copied: boolean;
  onCopied: () => void;
  onClose: () => void;
}> = ({ record, logTail, runId, coordinator, copied, onCopied, onClose }) => {
  const statusColor = BOT_STATUS_COLOR[toBotStatus(record.status)];
  const name = record.persona ?? (record.agentId && record.agentId !== 'swarm' ? record.agentId : record.id);
  const duration = record.startedAt !== null && record.endedAt !== null
    ? formatElapsed(record.endedAt - record.startedAt)
    : null;

  const copySynthesis = React.useCallback(() => {
    if (!runId) return;
    const text = coordinator.synthesize(runId);
    try {
      void navigator.clipboard.writeText(text);
      onCopied();
    } catch { /* clipboard unavailable — synthesis still returned by the API */ }
  }, [runId, coordinator, onCopied]);

  return (
    <motion.div
      initial={{ x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="absolute inset-y-0 right-0 w-[340px] max-w-[92%] flex flex-col z-30"
      style={{ background: 'var(--gia-surface)', borderLeft: '1px solid var(--gia-border-2)', boxShadow: '-12px 0 32px rgba(0,0,0,0.35)' }}
      role="dialog"
      aria-label="Lane details"
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--gia-border)' }}>
        <BotAvatar
          agentId={record.id}
          role={record.persona}
          status={toBotStatus(record.status)}
          size={64}
          animate
        />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium truncate" style={{ color: 'var(--gia-text)' }}>{name}</p>
          <p className="text-[10px] font-semibold uppercase tracking-wider mt-0.5" style={{ color: statusColor }}>
            {STATUS_WORD[record.status]}
          </p>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-md flex items-center justify-center"
          style={{ color: 'var(--gia-muted)' }}
          aria-label="Close details"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Prompt */}
        <section>
          <p className="text-[9px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gia-muted-2)' }}>Prompt</p>
          <p className="text-[11px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: 'var(--gia-text)' }}>
            {record.prompt}
          </p>
        </section>

        {/* Worktree */}
        <section>
          <p className="text-[9px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gia-muted-2)' }}>Workspace</p>
          {record.worktreePath ? (
            <p className="text-[10px] font-mono break-all flex items-start gap-1.5" style={{ color: 'var(--gia-text)' }}>
              <GitBranch size={11} className="shrink-0 mt-0.5" style={{ color: 'var(--gia-muted)' }} />
              {record.worktreePath}
            </p>
          ) : (
            <p className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>Shared space</p>
          )}
          {record.warning && (
            <p className="text-[9px] mt-1 leading-relaxed" style={{ color: '#f59e0b' }}>{record.warning}</p>
          )}
        </section>

        {/* Meta */}
        <section>
          <p className="text-[9px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gia-muted-2)' }}>Run</p>
          <div className="grid grid-cols-2 gap-y-1 text-[10px] tabular-nums" style={{ color: 'var(--gia-muted)' }}>
            <span>Provider</span><span className="text-right" style={{ color: 'var(--gia-text)' }}>{record.provider || 'auto'}</span>
            {record.toolPolicy && record.toolPolicy.length > 0 && (
              <>
                <span>Tool policy</span>
                <span className="text-right" style={{ color: 'var(--gia-text)' }}>{record.toolPolicy.length} allowed</span>
              </>
            )}
            {duration !== null && (
              <>
                <span>Duration</span><span className="text-right" style={{ color: 'var(--gia-text)' }}>{duration}</span>
              </>
            )}
          </div>
        </section>

        {/* Log tail from the task record stream */}
        {logTail.length > 0 && (
          <section>
            <p className="text-[9px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gia-muted-2)' }}>
              Log tail (last {Math.min(logTail.length, LOG_TAIL_SHOWN)})
            </p>
            <div
              className="rounded-lg p-2 space-y-0.5 max-h-40 overflow-y-auto"
              style={{ background: 'var(--gia-code-bg)', border: '1px solid var(--gia-border)' }}
            >
              {logTail.slice(-LOG_TAIL_SHOWN).map((line, i) => (
                <p key={i} className="text-[9px] font-mono leading-relaxed break-words" style={{ color: 'var(--gia-muted)' }}>
                  {line}
                </p>
              ))}
            </div>
          </section>
        )}

        {/* Error */}
        {record.error && (
          <section>
            <p className="text-[9px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: '#f87171' }}>Error</p>
            <p className="text-[10px] leading-relaxed" style={{ color: '#f87171' }}>{record.error}</p>
          </section>
        )}

        {/* Result / synthesis when done */}
        {record.result && (
          <section>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted-2)' }}>Result</p>
              {runId && (
                <button
                  onClick={copySynthesis}
                  className="flex items-center gap-1 text-[9px] px-2 py-1 rounded-md"
                  style={{ border: '1px solid var(--gia-border)', color: 'var(--gia-muted)' }}
                  title="Copy the swarm synthesis (this lane's role in context)"
                >
                  {copied ? <Check size={9} /> : <Copy size={9} />} {copied ? 'Copied' : 'Copy synthesis'}
                </button>
              )}
            </div>
            <div
              className="rounded-lg p-2.5 max-h-64 overflow-y-auto"
              style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}
            >
              <p className="text-[10px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: 'var(--gia-text)' }}>
                {record.result}
              </p>
            </div>
          </section>
        )}
      </div>
    </motion.div>
  );
};

export default SwarmPanel;
