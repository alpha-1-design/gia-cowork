import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  onSessionEnd,
  onSwarmRunEnd,
  setCrossExaminer,
  resetCrossExaminer,
  runRuleSuffix,
  SESSIONS_PER_PROPOSAL,
  TRIAL_SESSIONS,
} from '../myelinEngine';
import type { AmendmentDraft, CrossExamResult, CrossExaminer, RolloutLine } from '../myelin';
import { useAmendmentStore } from '../../../store/useAmendmentStore';

/**
 * The MYELIN ∘ MURMURATION orchestrator — WHEN things happen. The core's
 * decisions live in myelin.test.ts; the store's semantics in
 * useAmendmentStore.test.ts. Here: cadence, cross-examination gating,
 * trial watching over sessions, and the run lane's expiry.
 */

const shipAlways: CrossExaminer = async (draft: AmendmentDraft): Promise<CrossExamResult> => ({
  verdict: 'ship',
  objections: [],
  engine: 'test-shipper',
});

const rejectAlways: CrossExaminer = async (draft: AmendmentDraft): Promise<CrossExamResult> => ({
  verdict: 'reject',
  objections: [{ claim: 'evidence too thin', severity: 'blocker' }],
  engine: 'test-rejector',
});

beforeEach(() => {
  useAmendmentStore.getState().reset();
  resetCrossExaminer();
});

/** Rollout entries that will trigger `retry-then-change-approach` (threshold 1). */
type Entry = { line: Extract<RolloutLine, { type: 'tool_call' | 'tool_output' }> };
const retryStormEntries: Entry[] = [
  ...[0, 1, 2].map((i) => ({ line: { type: 'tool_call' as const, id: `c${i}`, tool: 'filesystem_read', args: '{"path":"same.ts"}' } })),
  { line: { type: 'tool_output' as const, id: 'c0', tool: 'filesystem_read', output: '❌ error: boom' } },
  { line: { type: 'tool_output' as const, id: 'c1', tool: 'filesystem_read', output: '❌ error: boom' } },
  { line: { type: 'tool_output' as const, id: 'c2', tool: 'filesystem_read', output: '❌ error: boom' } },
];

describe('cadence gate', () => {
  it('a session under the cadence is observed but never proposes', async () => {
    setCrossExaminer(shipAlways);
    const id = await onSessionEnd(retryStormEntries);
    expect(id).toBeNull();
    expect(useAmendmentStore.getState().sessionsSinceProposal).toBe(1);
  });

  it('the Nth session proposes exactly once', async () => {
    setCrossExaminer(shipAlways);
    for (let i = 0; i < SESSIONS_PER_PROPOSAL - 1; i++) {
      await onSessionEnd(retryStormEntries);
    }
    const id = await onSessionEnd(retryStormEntries);
    expect(id).not.toBeNull();
    const rec = useAmendmentStore.getState().amendments.find((a) => a.id === id);
    expect(rec?.ruleId).toBe('retry-then-change-approach');
    expect(rec?.status).toBe('ON_TRIAL');
  });
});

describe('cross-examination gate (M1 — no unchallenged amendment ships)', () => {
  it('a rejected draft is journaled as REJECTED with the objection, never attached', async () => {
    setCrossExaminer(rejectAlways);
    for (let i = 0; i < SESSIONS_PER_PROPOSAL - 1; i++) await onSessionEnd(retryStormEntries);
    const id = await onSessionEnd(retryStormEntries);
    expect(id).toBeNull(); // only SHIPPED amendments return an id
    const rec = useAmendmentStore.getState().amendments.find((a) => a.ruleId === 'retry-then-change-approach' && a.status === 'REJECTED');
    expect(rec).toBeDefined();
    expect(rec?.objections[0].claim).toBe('evidence too thin');
    expect(useAmendmentStore.getState().activeConstitution().length).toBe(0);
  });

  it('cross-examination THROWING is a reject, not a silent ship', async () => {
    setCrossExaminer(async () => {
      throw new Error('provider down');
    });
    for (let i = 0; i < SESSIONS_PER_PROPOSAL - 1; i++) await onSessionEnd(retryStormEntries);
    const id = await onSessionEnd(retryStormEntries);
    expect(id).toBeNull();
    const rec = useAmendmentStore.getState().amendments.find((a) => a.status === 'REJECTED');
    expect(rec).toBeDefined();
    expect(rec?.objections.some((o) => /unavailable/i.test(o.claim))).toBe(true);
  });
});

describe('trial watching over sessions', () => {
  it('TRIAL_SESSIONS good sessions promote the rule and unlock the changelog', async () => {
    setCrossExaminer(shipAlways);
    for (let i = 0; i < SESSIONS_PER_PROPOSAL; i++) await onSessionEnd(retryStormEntries);
    expect(useAmendmentStore.getState().unlocked).toBe(false);
    // Keep feeding CLEAN sessions (no storms) until the trial window passes.
    const clean: Entry[] = [{ line: { type: 'tool_output' as const, id: 'ok1', tool: 'filesystem_read', output: 'ok' } }];
    for (let i = 0; i < TRIAL_SESSIONS; i++) await onSessionEnd(clean);
    const active = useAmendmentStore.getState().activeConstitution();
    expect(active.some((a) => a.status === 'ACTIVE' && a.trialVerdict === 'promoted')).toBe(true);
    expect(useAmendmentStore.getState().unlocked).toBe(true);
  });
});

describe('MURMURATION — run lane', () => {
  it('a run with storms issues an auto-expiring rule that rides lane prompts until the next run', async () => {
    setCrossExaminer(shipAlways);
    const entries: { line: RolloutLine }[] = retryStormEntries.map((e) => ({ line: e.line }));
    const id = await onSwarmRunEnd(entries);
    expect(id).not.toBeNull();
    expect(runRuleSuffix()).toMatch(/change the approach/i);

    // The next run expires the previous rule BEFORE distilling itself.
    const clean = entries;
    await onSwarmRunEnd([{ line: { type: 'tool_output' as const, id: 'ok', tool: 'filesystem_read', output: 'ok' } }]);
    expect(runRuleSuffix()).toBe('');
    const expired = useAmendmentStore.getState().amendments.filter((a) => a.id === id)[0];
    expect(expired?.status).toBe('ROLLED_BACK');
    expect(expired?.rollbackReason).toMatch(/auto-expires/i);
  });

  it('a clean run issues nothing', async () => {
    const id = await onSwarmRunEnd([{ line: { type: 'tool_output' as const, id: 'ok', tool: 'filesystem_read', output: 'ok' } }]);
    expect(id).toBeNull();
    expect(runRuleSuffix()).toBe('');
  });
});
