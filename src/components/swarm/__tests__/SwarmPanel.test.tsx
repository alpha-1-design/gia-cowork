import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SwarmPanel from '../SwarmPanel';
import { useTrustStore } from '../../../store/useTrustStore';

/**
 * SwarmPanel tests.
 *
 * The real SwarmCoordinator loads the whole provider graph, so these tests
 * mock the coordinator module — the same seam-based mocking the coordinator's
 * own tests use — and drive the panel through the API it is allowed to touch:
 * startSwarm, the SwarmEvent stream (via the captured `on` listener),
 * getTasks snapshots, cancel/cancelAll/runCost/synthesize.
 *
 * What is pinned here:
 *   - the panel mounts rows purely from coordinator events + getTasks;
 *   - the per-row ✕ calls coordinator.cancel (the cancel that aborts);
 *   - Cancel all calls cancelAll scoped to the panel's run;
 *   - the profile selector maps straight onto the SwarmPlan profile param;
 *   - the plan parser keeps persona prefixes ("Researcher: …") and passes
 *     plain prompts through untouched;
 *   - the empty state matches the chat empty-state language ("Deploy a
 *     swarm") and the profile default is 'Ask every action';
 *   - beyond the virtualization threshold only a window of rows is rendered.
 */

// ── Fake coordinator (vi.mock is hoisted above everything) ─────────────────

type FakeRecord = {
  id: string;
  runId: string;
  prompt: string;
  persona?: string;
  agentId?: string;
  status: string;
  startedAt: number | null;
  endedAt: number | null;
  provider: string;
  error?: string;
  warning?: string;
  worktreePath?: string;
  result?: string;
  toolPolicy?: string[];
};

const h = vi.hoisted(() => {
  const records: any[] = [];
  const listeners = new Set<(e: any) => void>();
  const emit = (e: any) => { for (const l of Array.from(listeners)) l(e); };
  const fns = {
    startSwarm: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    resume: vi.fn(),
    getTasks: vi.fn(() => records),
    getRun: vi.fn(),
    runCost: vi.fn(() => 0),
    synthesize: vi.fn(() => '## Swarm Synthesis'),
    setAllocator: vi.fn(),
  };
  const swarmCoordinator = {
    ...fns,
    on: (l: (e: any) => void) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
  };
  return { swarmCoordinator, records, listeners, emit, fns };
});

vi.mock('../../../services/swarm/SwarmCoordinator', () => ({
  swarmCoordinator: h.swarmCoordinator,
  createDefaultAllocator: () => ({ allocate: vi.fn(), release: vi.fn() }),
}));

function fakeRecord(over: Partial<FakeRecord>): FakeRecord {
  return {
    id: 't', runId: 'run-1', prompt: 'p', status: 'queued',
    startedAt: null, endedAt: null, provider: '',
    ...over,
  } as FakeRecord;
}

/** Wire startSwarm to seed `n` queued records and emit run-started, exactly
 *  like the real coordinator's synchronous emit-after-dispatch flow. */
function wireStart(n: number, personas: (string | undefined)[] = []) {
  h.fns.startSwarm.mockImplementation(() => {
    h.records.length = 0;
    for (let i = 0; i < n; i++) {
      h.records.push(fakeRecord({ id: `t${i + 1}`, prompt: `task ${i + 1}`, persona: personas[i] }));
    }
    h.emit({ type: 'run-started', runId: 'run-1', taskIds: h.records.map(r => r.id) });
    return {
      runId: 'run-1',
      done: Promise.resolve({ runId: 'run-1', done: 0, failed: 0, cancelled: 0, tasks: [] }),
    };
  });
}

const PLAN_LINE_1 = 'Researcher: find the top 3 competitors';
const PLAN_LINE_2 = 'Fix the flaky CI test';

beforeEach(() => {
  vi.clearAllMocks();
  h.records.length = 0;
  h.fns.getTasks.mockImplementation(() => h.records);
  useTrustStore.setState({ armed: true });
});

// ── Empty state ────────────────────────────────────────────────────────────

describe('SwarmPanel — empty state', () => {
  it('shows the "Deploy a swarm" empty state with the plan call to action', () => {
    render(<SwarmPanel />);
    expect(screen.getByText('Deploy a swarm')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Write the plan/ })).toBeTruthy();
  });

  it('defaults the permission profile to Ask every action', () => {
    render(<SwarmPanel />);
    const ask = screen.getByRole('radio', { name: 'Ask every action' });
    expect(ask.getAttribute('aria-checked')).toBe('true');
    const full = screen.getByRole('radio', { name: 'Full access' });
    expect(full.getAttribute('aria-checked')).toBe('false');
  });
});

// ── Start: plan parsing + plan mapping ─────────────────────────────────────

describe('SwarmPanel — startSwarm plan mapping', () => {
  it('parses persona prefixes and plain prompts into the plan', () => {
    wireStart(2);
    render(<SwarmPanel />);
    fireEvent.change(
      screen.getByPlaceholderText(/One prompt per line/),
      { target: { value: `${PLAN_LINE_1}\n${PLAN_LINE_2}` } },
    );
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));

    expect(h.fns.startSwarm).toHaveBeenCalledTimes(1);
    const plan = h.fns.startSwarm.mock.calls[0][0];
    expect(plan.tasks).toEqual([
      { persona: 'Researcher', prompt: 'find the top 3 competitors' },
      { persona: undefined, prompt: 'Fix the flaky CI test' },
    ]);
    expect(plan.concurrency).toBe(4);
    expect(plan.profile).toBe('ask');
  });

  it('does not treat sentence colons as persona prefixes', () => {
    wireStart(1);
    render(<SwarmPanel />);
    fireEvent.change(
      screen.getByPlaceholderText(/One prompt per line/),
      { target: { value: 'Fix bug: handle the edge case' } },
    );
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    expect(h.fns.startSwarm.mock.calls[0][0].tasks).toEqual([
      { persona: undefined, prompt: 'Fix bug: handle the edge case' },
    ]);
  });

  it('maps the concurrency stepper and profile onto the plan', () => {
    wireStart(1);
    render(<SwarmPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'More lanes' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Auto-allow reads' }));
    fireEvent.change(screen.getByPlaceholderText(/One prompt per line/), { target: { value: 'do it' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));

    const plan = h.fns.startSwarm.mock.calls[0][0];
    expect(plan.concurrency).toBe(5);
    expect(plan.profile).toBe('auto-read');
  });

  it('maps Full access (with its red warning card) onto profile "full"', () => {
    wireStart(1);
    render(<SwarmPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'Full access' }));
    // Same warning language TrustGate shows for full autonomy.
    expect(screen.getByText(/runs every tool call without asking/)).toBeTruthy();
    expect(screen.getByText(/The kill switch still works/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/One prompt per line/), { target: { value: 'go' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    expect(h.fns.startSwarm.mock.calls[0][0].profile).toBe('full');
  });
});

// ── Lane grid from coordinator events ──────────────────────────────────────

describe('SwarmPanel — lane grid', () => {
  it('mounts rows from the run-started event + getTasks snapshot', async () => {
    wireStart(2, ['Researcher']);
    render(<SwarmPanel />);
    fireEvent.change(screen.getByPlaceholderText(/One prompt per line/), { target: { value: 'a\nb' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));

    // Rows render with the persona name and the default lane label. The first
    // seeded record carries a persona (the coordinator resolves one for the
    // lane), the second falls back to the Lane label.
    expect(await screen.findByText('Researcher')).toBeTruthy();
    expect(screen.getByText('Lane 2')).toBeTruthy();
    expect(screen.getAllByText('Queued').length).toBe(2);
  });

  it('follows status + live activity from coordinator events', async () => {
    wireStart(1);
    render(<SwarmPanel />);
    fireEvent.change(screen.getByPlaceholderText(/One prompt per line/), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    await screen.findByText('Lane 1');

    // The coordinator mutates its record, then emits — the panel re-snapshots.
    h.records[0].status = 'running';
    h.records[0].startedAt = Date.now();
    h.emit({ type: 'task-started', runId: 'run-1', taskId: 't1' });
    expect(await screen.findByText('Running')).toBeTruthy();

    h.emit({ type: 'task-activity', runId: 'run-1', taskId: 't1', activity: '⚙️ Executing web_search…' });
    expect(await screen.findByText('⚙️ Executing web_search…')).toBeTruthy();

    h.records[0].status = 'done';
    h.records[0].endedAt = Date.now();
    h.emit({ type: 'task-completed', runId: 'run-1', taskId: 't1', result: 'ok' });
    expect(await screen.findByText('Done')).toBeTruthy();
  });

  it('shows the live run cost from coordinator.runCost', async () => {
    wireStart(1);
    h.fns.runCost.mockReturnValue(0.0125);
    render(<SwarmPanel />);
    fireEvent.change(screen.getByPlaceholderText(/One prompt per line/), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    expect(await screen.findByText('$0.0125')).toBeTruthy();
  });
});

// ── Cancellation ───────────────────────────────────────────────────────────

describe('SwarmPanel — cancellation', () => {
  it('per-row ✕ calls coordinator.cancel with the task id', async () => {
    wireStart(2);
    render(<SwarmPanel />);
    fireEvent.change(screen.getByPlaceholderText(/One prompt per line/), { target: { value: 'a\nb' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Lane 1' }));
    expect(h.fns.cancel).toHaveBeenCalledWith('t1');
  });

  it('Cancel all calls cancelAll scoped to the panel run', async () => {
    wireStart(2);
    render(<SwarmPanel />);
    fireEvent.change(screen.getByPlaceholderText(/One prompt per line/), { target: { value: 'a\nb' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Cancel all/ }));
    expect(h.fns.cancelAll).toHaveBeenCalledWith('run-1');
  });

  it('terminal rows lose their cancel button (nothing left to abort)', async () => {
    wireStart(1);
    render(<SwarmPanel />);
    fireEvent.change(screen.getByPlaceholderText(/One prompt per line/), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    await screen.findByText('Lane 1');

    h.records[0].status = 'cancelled';
    h.records[0].endedAt = Date.now();
    h.emit({ type: 'task-cancelled', runId: 'run-1', taskId: 't1' });
    // The status word and the lane's live label both read 'Cancelled' —
    // assert on either without strict single-match.
    await screen.findAllByText('Cancelled');
    // The row's ✕ is gone; the control bar's 'Cancel all' is a different button.
    expect(screen.queryByRole('button', { name: 'Cancel Lane 1' })).toBeNull();
  });
});

// ── Pause ──────────────────────────────────────────────────────────────────

describe('SwarmPanel — pause (the kill-switch governor)', () => {
  it('Pause disarms the trust store, shows the paused banner, Resume re-arms + resumes', async () => {
    wireStart(2);
    render(<SwarmPanel />);
    fireEvent.change(screen.getByPlaceholderText(/One prompt per line/), { target: { value: 'a\nb' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Pause/ }));

    expect(useTrustStore.getState().armed).toBe(false);
    expect(await screen.findByText(/Queue paused/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    expect(useTrustStore.getState().armed).toBe(true);
    expect(h.fns.resume).toHaveBeenCalled();
  });
});

// ── Details drawer ─────────────────────────────────────────────────────────

describe('SwarmPanel — details drawer', () => {
  it('opens on row click: prompt, workspace, log tail, result + synthesis', async () => {
    wireStart(1);
    render(<SwarmPanel />);
    fireEvent.change(screen.getByPlaceholderText(/One prompt per line/), { target: { value: 'map the market' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    await screen.findByText('Lane 1');

    h.records[0].status = 'done';
    h.records[0].startedAt = Date.now() - 5000;
    h.records[0].endedAt = Date.now();
    h.records[0].result = 'Found 3 competitors.';
    h.records[0].worktreePath = '/repo/.gia/worktrees/t1';
    h.emit({ type: 'task-completed', runId: 'run-1', taskId: 't1', result: 'Found 3 competitors.' });

    fireEvent.click(screen.getByText('Lane 1'));
    expect(await screen.findByRole('dialog', { name: 'Lane details' })).toBeTruthy();
    expect(screen.getByText('map the market')).toBeTruthy();
    expect(screen.getByText('/repo/.gia/worktrees/t1')).toBeTruthy();
    expect(screen.getByText('Found 3 competitors.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Copy synthesis/ }));
    expect(h.fns.synthesize).toHaveBeenCalledWith('run-1');
  });

  it('shows "Shared space" when the lane has no worktree', async () => {
    wireStart(1);
    render(<SwarmPanel />);
    fireEvent.change(screen.getByPlaceholderText(/One prompt per line/), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    fireEvent.click(await screen.findByText('Lane 1'));
    expect(await screen.findByText('Shared space')).toBeTruthy();
  });
});

// ── Virtualization ─────────────────────────────────────────────────────────

describe('SwarmPanel — virtualization', () => {
  it('renders only a window of rows once the list passes the threshold', async () => {
    // 120 lanes arrive via the event stream — no typing needed.
    render(<SwarmPanel />);
    for (let i = 0; i < 120; i++) {
      h.records.push(fakeRecord({ id: `t${i + 1}`, prompt: `task ${i + 1}` }));
    }
    h.emit({ type: 'run-started', runId: 'run-1', taskIds: h.records.map(r => r.id) });

    await screen.findByText('Lane 1');
    const rendered = document.querySelectorAll('[data-lane-row]').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(120);
  });

  it('switches BotAvatar idle motion off in dense grids (>50 rows)', async () => {
    render(<SwarmPanel />);
    for (let i = 0; i < 80; i++) {
      h.records.push(fakeRecord({ id: `t${i + 1}`, prompt: `task ${i + 1}` }));
    }
    h.emit({ type: 'run-started', runId: 'run-1', taskIds: h.records.map(r => r.id) });
    await screen.findByText('Lane 1');
    // Every rendered avatar must have idle motion disabled.
    const avatars = document.querySelectorAll('[data-bot-motion]');
    expect(avatars.length).toBeGreaterThan(0);
    avatars.forEach(a => expect(a.getAttribute('data-bot-motion')).toBe('off'));
  });
});
