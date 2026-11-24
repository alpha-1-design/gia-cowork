import { describe, it, expect, beforeEach } from 'vitest';
import { useAmendmentStore, MAX_ACTIVE_CONSTITUTION } from '../useAmendmentStore';
import type { AmendmentRecord } from '../../services/selfbuild/myelin';

/**
 * The amendments ledger — bounded by construction (A3), append-shaped, and
 * the source of truth for both MYELIN (constitution) and MURMURATION (run)
 * rules. Store semantics only; the engine's decisions live in myelin tests.
 */

const record = (overrides: Partial<AmendmentRecord> = {}): AmendmentRecord => ({
  id: overrides.id ?? `amend-${Math.random().toString(36).slice(2, 8)}`,
  scope: overrides.scope ?? 'constitution',
  ruleId: overrides.ruleId ?? 'search-before-fetch',
  ruleText: overrides.ruleText ?? 'Search before fetching.',
  rationale: overrides.rationale ?? 'measured',
  evidence: overrides.evidence ?? { misfiresByTool: {}, retryStorms: 0, unansweredCalls: 0, blindEdits: 0, blindFetches: 0, toolCalls: 0, trustedLines: 0, untrustedLines: 0 },
  objections: overrides.objections ?? [],
  engine: overrides.engine ?? 'test',
  status: overrides.status ?? 'ON_TRIAL',
  createdAt: overrides.createdAt ?? Date.now(),
  trialSessions: overrides.trialSessions,
  trialVerdict: overrides.trialVerdict,
  rollbackReason: overrides.rollbackReason,
  expiredAt: overrides.expiredAt,
});

beforeEach(() => {
  useAmendmentStore.getState().reset();
});

describe('A3 — the active-rule cap is structural', () => {
  it('refuses to attach a fourth active constitution rule', () => {
    for (let i = 0; i < MAX_ACTIVE_CONSTITUTION; i++) {
      useAmendmentStore.getState().append(record({ id: `a${i}`, ruleId: `rule-${i}`, status: 'ACTIVE' }));
    }
    expect(useAmendmentStore.getState().activeConstitution().length).toBe(MAX_ACTIVE_CONSTITUTION);
    useAmendmentStore.getState().append(record({ id: 'overflow', ruleId: 'rule-x', status: 'ACTIVE' }));
    expect(useAmendmentStore.getState().amendments.some((a) => a.id === 'overflow')).toBe(false);
  });

  it('rejected and rolled-back records do not consume the cap', () => {
    useAmendmentStore.getState().append(record({ id: 'dead1', status: 'REJECTED' }));
    useAmendmentStore.getState().append(record({ id: 'dead2', status: 'ROLLED_BACK' }));
    expect(useAmendmentStore.getState().activeConstitution().length).toBe(0);
    useAmendmentStore.getState().append(record({ id: 'live1', status: 'ACTIVE' }));
    expect(useAmendmentStore.getState().activeConstitution().length).toBe(1);
  });
});

describe('run scope — auto-expiry', () => {
  it('expireRunRules retires every live run rule exactly once', () => {
    useAmendmentStore.getState().append(record({ id: 'run1', scope: 'run', ruleId: 'run-rule-1', status: 'ACTIVE' }));
    useAmendmentStore.getState().append(record({ id: 'run2', scope: 'run', ruleId: 'run-rule-2', status: 'ACTIVE' }));
    expect(useAmendmentStore.getState().activeRunRules().length).toBe(2);

    const n = useAmendmentStore.getState().expireRunRules();
    expect(n).toBe(2);
    expect(useAmendmentStore.getState().activeRunRules().length).toBe(0);

    // Idempotent: a second call is a no-op.
    expect(useAmendmentStore.getState().expireRunRules()).toBe(0);
  });

  it('constitution rules are untouched by run expiry', () => {
    useAmendmentStore.getState().append(record({ id: 'c1', status: 'ON_TRIAL' }));
    useAmendmentStore.getState().append(record({ id: 'run1', scope: 'run', status: 'ACTIVE' }));
    useAmendmentStore.getState().expireRunRules();
    expect(useAmendmentStore.getState().amendments.find((a) => a.id === 'c1')?.status).toBe('ON_TRIAL');
  });
});

describe('journal shape', () => {
  it('transition patches the record with the matching id', () => {
    useAmendmentStore.getState().append(record({ id: 'r1', status: 'ON_TRIAL' }));
    useAmendmentStore.getState().transition('r1', { status: 'ACTIVE', trialVerdict: 'promoted' });
    const a = useAmendmentStore.getState().amendments.find((x) => x.id === 'r1');
    expect(a?.status).toBe('ACTIVE');
    expect(a?.trialVerdict).toBe('promoted');
  });

  it('hasActiveOrTrial sees either status, either scope', () => {
    useAmendmentStore.getState().append(record({ id: 'r1', ruleId: 'rr', status: 'REJECTED' }));
    expect(useAmendmentStore.getState().hasActiveOrTrial('rr')).toBe(false);
    useAmendmentStore.getState().append(record({ id: 'r2', scope: 'run', ruleId: 'rr', status: 'ACTIVE' }));
    expect(useAmendmentStore.getState().hasActiveOrTrial('rr')).toBe(true);
  });

  it('cadence counters move independently', () => {
    useAmendmentStore.getState().noteSessionObserved();
    useAmendmentStore.getState().noteSessionObserved();
    expect(useAmendmentStore.getState().sessionsSinceProposal).toBe(2);
    useAmendmentStore.getState().transitionResetCadence();
    expect(useAmendmentStore.getState().sessionsSinceProposal).toBe(0);
  });
});
