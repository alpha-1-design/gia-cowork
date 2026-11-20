import { describe, it, expect, beforeEach } from 'vitest';
import { useTestimonyStore, nextAllowedAt, QUIET_MS } from '../useTestimonyStore';

/**
 * The testimony ledger — budget, halving, silence audit, unlock. The voice's
 * rule engine and its budget DECISIONS are voice.test.ts's subject (mocked
 * records); this file owns the ledger semantics.
 */

beforeEach(() => {
  useTestimonyStore.setState({
    spokenLog: [],
    silenceLog: [],
    budgetHalved: false,
    unlockStage: 'dormant',
  });
});

const NOW = 1_700_000_000_000;

function moment(overrides: Partial<{ id: string; category: 'gate'; line: string; receipts: string[] }> = {}) {
  return {
    id: overrides.id ?? 'm1',
    category: overrides.category ?? ('gate' as const),
    line: overrides.line ?? 'Before you ask me anything — two tool calls were declined.',
    receipts: overrides.receipts ?? ['receipt 1'],
  };
}

describe('testimony ledger — budget', () => {
  it('a spoken moment unlocks the voice and resets the halving', () => {
    useTestimonyStore.getState().halfBudget();
    expect(useTestimonyStore.getState().budgetHalved).toBe(true);
    useTestimonyStore.getState().recordSpoken(moment(), NOW);
    expect(useTestimonyStore.getState().budgetHalved).toBe(false);
    expect(useTestimonyStore.getState().unlockStage).toBe('revealed');
  });

  it('nextAllowedAt: never-spoken is allowed immediately, then 24h', () => {
    expect(nextAllowedAt([], false)).toBe(0);
    useTestimonyStore.getState().recordSpoken(moment(), NOW);
    expect(nextAllowedAt(useTestimonyStore.getState().spokenLog, false)).toBe(NOW + QUIET_MS);
  });

  it('"not now" doubles the quiet period', () => {
    useTestimonyStore.getState().recordSpoken(moment(), NOW);
    useTestimonyStore.getState().halfBudget();
    expect(nextAllowedAt(useTestimonyStore.getState().spokenLog, true)).toBe(NOW + QUIET_MS * 2);
  });

  it('the silence ledger records what was suppressed, in full', () => {
    useTestimonyStore.getState().recordSilent(moment({ id: 's1', line: 'almost said this' }), NOW);
    const ledger = useTestimonyStore.getState().silenceLog;
    expect(ledger).toHaveLength(1);
    expect(ledger[0].line).toBe('almost said this');
    expect(ledger[0].at).toBe(NOW);
  });

  it('spoken and silenced moments never cross-contaminate', () => {
    useTestimonyStore.getState().recordSpoken(moment({ id: 'a' }), NOW);
    useTestimonyStore.getState().recordSilent(moment({ id: 'b' }), NOW);
    const s = useTestimonyStore.getState();
    expect(s.spokenLog.map((m) => m.id)).toEqual(['a']);
    expect(s.silenceLog.map((m) => m.id)).toEqual(['b']);
  });

  it('clearLedgers returns the feature to dormant — a reset that resets honestly', () => {
    useTestimonyStore.getState().recordSpoken(moment(), NOW);
    useTestimonyStore.getState().recordSilent(moment({ id: 'b' }), NOW);
    useTestimonyStore.getState().halfBudget();
    useTestimonyStore.getState().clearLedgers();
    const s = useTestimonyStore.getState();
    expect(s.spokenLog).toEqual([]);
    expect(s.silenceLog).toEqual([]);
    expect(s.budgetHalved).toBe(false);
    expect(s.unlockStage).toBe('dormant');
  });
});
