import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTestimonyStore } from '../../../store/useTestimonyStore';
import { maybeSpeakTestimony } from '../voice';
import type { ProvenanceCitation } from '../../brain/provenance';

/**
 * The voice's rule engine and budget decision, with the record edges mocked:
 * provenance (the rollouts), CostTracker, FileSnapshots. The trust store is
 * the real store driven via setState, since gate denials are exactly the kind
 * of state the real app produces. What we own here: which rule fires, in what
 * order, with receipts — and what happens when the budget says no.
 */

// ── Mock edges ──────────────────────────────────────────────────────────

const provenanceResult = { citations: [] as ProvenanceCitation[], filesScanned: 0, unverifiedFiles: [], enveloped: '' };
vi.mock('../../brain/provenance', () => ({
  queryProvenance: async () => provenanceResult,
  clearProvenanceCache: () => {},
}));

const costState = { byDay: [] as { day: string; cost: number; calls: number }[], byModel: [] as { provider: string; model: string; cost: number }[] };
vi.mock('../../CostTracker', () => ({
  costTracker: { getSummary: () => costState },
}));

const snapshots: { path: string; timestamp: number; reverted: boolean }[] = [];
vi.mock('../../FileSnapshots', () => ({
  fileSnapshots: { list: () => snapshots },
}));

import { useTrustStore } from '../../../store/useTrustStore';

// ── Helpers ─────────────────────────────────────────────────────────────

const NOW = 1_760_000_000_000; // 2025-10-09-ish; arbitrary but real

function failedCitation(tool: string, session = 's1'): ProvenanceCitation {
  return {
    sessionId: session, path: `~/gia-rollouts/rollout-${session}.jsonl`, line: 3,
    hash: 'abc', verified: true, kind: 'tool_output', at: null, tool,
    excerpt: `❌ ${tool} failed`, outcome: 'failed',
  };
}

beforeEach(() => {
  useTestimonyStore.setState({ spokenLog: [], silenceLog: [], budgetHalved: false, unlockStage: 'dormant' });
  useTrustStore.setState({ audit: [], armed: true });
  provenanceResult.citations = [];
  costState.byDay = [];
  costState.byModel = [];
  snapshots.length = 0;
});

describe('voice rules', () => {
  it('says NOTHING when nothing qualifies — silence is a first-class state', async () => {
    expect(await maybeSpeakTestimony(NOW)).toBeNull();
    expect(useTestimonyStore.getState().silenceLog).toHaveLength(0);
  });

  it('gate denials speak first, with the declined headlines as receipts', async () => {
    useTrustStore.setState({
      audit: [
        { id: 'a1', toolId: 'filesystem_write', toolName: 'filesystem_write', risk: 'high', choice: 'deny', scope: 'fs:src/x', headline: 'Write src/x.ts', at: NOW - 1000 },
        { id: 'a2', toolId: 'filesystem_write', toolName: 'filesystem_write', risk: 'high', choice: 'blocked', scope: 'fs:src/y', headline: 'Write src/y.ts', at: NOW - 2000 },
      ],
    });
    const spoken = await maybeSpeakTestimony(NOW);
    expect(spoken).not.toBeNull();
    expect(spoken!.category).toBe('gate');
    expect(spoken!.receipts.length).toBeGreaterThanOrEqual(2);
    expect(spoken!.receipts.join(' ')).toContain('you declined');
  });

  it('repeated failures of one tool speak, citing the record', async () => {
    provenanceResult.citations = [
      failedCitation('terminal_run'), failedCitation('terminal_run'), failedCitation('terminal_run'),
    ];
    const spoken = await maybeSpeakTestimony(NOW);
    expect(spoken!.category).toBe('failure');
    expect(spoken!.line).toContain('terminal_run');
    expect(spoken!.line).toContain('3 times');
  });

  it('one or two failures do NOT qualify — a chatty watcher is spam', async () => {
    provenanceResult.citations = [failedCitation('terminal_run'), failedCitation('terminal_run')];
    expect(await maybeSpeakTestimony(NOW)).toBeNull();
  });

  it('a spend spike speaks with per-day receipts', async () => {
    const today = new Date(NOW).toISOString().slice(0, 10);
    costState.byDay = [
      { day: shiftDay(today, -3), cost: 0.1, calls: 10 },
      { day: shiftDay(today, -2), cost: 0.1, calls: 10 },
      { day: shiftDay(today, -1), cost: 0.1, calls: 10 },
      { day: today, cost: 0.5, calls: 40 },
    ];
    costState.byModel = [{ provider: 'openai', model: 'gpt-x', cost: 0.4 }];
    const spoken = await maybeSpeakTestimony(NOW);
    expect(spoken!.category).toBe('cost');
    expect(spoken!.receipts.join(' ')).toContain(today);
  });

  it('normal spend does NOT speak', async () => {
    const today = new Date(NOW).toISOString().slice(0, 10);
    costState.byDay = [
      { day: shiftDay(today, -2), cost: 0.1, calls: 10 },
      { day: shiftDay(today, -1), cost: 0.1, calls: 10 },
      { day: today, cost: 0.11, calls: 11 },
    ];
    expect(await maybeSpeakTestimony(NOW)).toBeNull();
  });

  it('a reverted write speaks — the record keeps what happened, not just what worked', async () => {
    snapshots.push({ path: '~/app/config.json', timestamp: NOW - 1000, reverted: true });
    const spoken = await maybeSpeakTestimony(NOW);
    expect(spoken!.category).toBe('revert');
    expect(spoken!.receipts[0]).toContain('config.json');
  });
});

describe('the budget decision', () => {
  function gateAudit() {
    useTrustStore.setState({
      audit: [
        { id: 'a1', toolId: 't', toolName: 't', risk: 'high' as const, choice: 'deny' as const, scope: 's', headline: 'h1', at: NOW },
        { id: 'a2', toolId: 't', toolName: 't', risk: 'high' as const, choice: 'deny' as const, scope: 's2', headline: 'h2', at: NOW },
      ],
    });
  }

  it('a trigger inside the quiet period is SILENCED, not lost', async () => {
    gateAudit();
    const first = await maybeSpeakTestimony(NOW);
    expect(first).not.toBeNull(); // spoken: fresh ledger
    // Same trigger, one hour later: the budget mutes it, and the ledger keeps it.
    const second = await maybeSpeakTestimony(NOW + 60 * 60 * 1000);
    expect(second).toBeNull();
    const ledger = useTestimonyStore.getState().silenceLog;
    expect(ledger).toHaveLength(1);
    expect(ledger[0].category).toBe('gate');
    expect(useTestimonyStore.getState().spokenLog).toHaveLength(1);
  });

  it('"not now" keeps the voice quiet for twice as long', async () => {
    gateAudit();
    await maybeSpeakTestimony(NOW);
    useTestimonyStore.getState().halfBudget();
    // 25h after speaking: past the normal 24h quiet, inside the doubled one.
    const later = await maybeSpeakTestimony(NOW + 25 * 60 * 60 * 1000);
    expect(later).toBeNull();
    expect(useTestimonyStore.getState().silenceLog.length).toBe(1);
    // A spoken moment resets the halving, so the NEXT window is normal again.
    const spokenAgain = await maybeSpeakTestimony(NOW + 49 * 60 * 60 * 1000);
    expect(spokenAgain).not.toBeNull();
  });
});

function shiftDay(isoDay: string, delta: number): string {
  return new Date(new Date(isoDay).getTime() + delta * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
