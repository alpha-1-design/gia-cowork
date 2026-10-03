import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPrice,
  computeCost,
  isLocalProvider,
  formatCost,
  costTracker,
} from '../CostTracker';

describe('CostTracker pricing', () => {
  it('resolves exact model prices', () => {
    expect(getPrice('openai', 'gpt-4o-mini')).toEqual({ input: 0.15, output: 0.6 });
    expect(getPrice('anthropic', 'claude-sonnet-4-5')).toEqual({ input: 3, output: 15 });
  });

  it('prefers the longest matching key so gpt-4o-mini does not resolve as gpt-4o', () => {
    const mini = getPrice('openai', 'gpt-4o-mini');
    const full = getPrice('openai', 'gpt-4o');
    expect(mini.input).toBeLessThan(full.input);
  });

  it('matches prefixed aggregator ids (anthropic/claude-...)', () => {
    const price = getPrice('openrouter', 'anthropic/claude-sonnet-4');
    expect(price.input).toBe(3);
    expect(price.output).toBe(15);
  });

  it('costs local inference at zero', () => {
    for (const p of ['ollama', 'lmstudio', 'local-llm']) {
      expect(isLocalProvider(p)).toBe(true);
      expect(getPrice(p, 'llama3.2')).toEqual({ input: 0, output: 0 });
      expect(computeCost(p, 'llama3.2', 1_000_000, 1_000_000)).toBe(0);
    }
  });

  it('costs :free routed models at zero', () => {
    expect(computeCost('openrouter', 'google/gemma-3-27b-it:free', 100_000, 50_000)).toBe(0);
    expect(computeCost('opencode', 'deepseek-v4-flash-free', 100_000, 50_000)).toBe(0);
  });

  it('falls back to a provider default rather than reporting free for unknown models', () => {
    // Under-reporting cost is the failure mode that makes this feature useless.
    expect(computeCost('openai', 'some-unreleased-model-9000', 1_000_000, 0)).toBeGreaterThan(0);
  });

  it('computes cost from per-million rates', () => {
    // 1M input at $0.15/M + 1M output at $0.60/M = $0.75
    expect(computeCost('openai', 'gpt-4o-mini', 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
    expect(computeCost('openai', 'gpt-4o-mini', 1_000, 1_000)).toBeCloseTo(0.00075, 6);
  });

  it('treats negative or missing token counts as zero', () => {
    expect(computeCost('openai', 'gpt-4o-mini', -100, -100)).toBe(0);
    expect(computeCost('openai', 'gpt-4o-mini', 0, 0)).toBe(0);
  });
});

describe('CostTracker recording', () => {
  beforeEach(() => {
    costTracker.clear();
  });

  it('records and aggregates spend by model and provider', () => {
    costTracker.record('openai', 'gpt-4o-mini', 1_000_000, 0, 's1');
    costTracker.record('openai', 'gpt-4o-mini', 1_000_000, 0, 's1');
    costTracker.record('ollama', 'llama3.2', 5_000_000, 5_000_000, 's1');

    const summary = costTracker.getSummary();
    expect(summary.calls).toBe(3);
    expect(summary.totalCost).toBeCloseTo(0.3, 6);
    expect(summary.totalTokens).toBe(12_000_000);
    expect(summary.localTokens).toBe(10_000_000);
    expect(summary.localCalls).toBe(1);

    const openai = summary.byProvider.find(p => p.provider === 'openai');
    expect(openai?.cost).toBeCloseTo(0.3, 6);
    expect(openai?.calls).toBe(2);

    const ollama = summary.byProvider.find(p => p.provider === 'ollama');
    expect(ollama?.cost).toBe(0);
  });

  it('scopes spend to a session', () => {
    costTracker.record('openai', 'gpt-4o-mini', 1_000_000, 0, 's1');
    costTracker.record('openai', 'gpt-4o-mini', 1_000_000, 0, 's2');
    expect(costTracker.getSessionCost('s1')).toBeCloseTo(0.15, 6);
    expect(costTracker.getSessionCost('s2')).toBeCloseTo(0.15, 6);
    expect(costTracker.getSessionCost('s3')).toBe(0);
  });

  it('ignores negative token counts from a bad provider response', () => {
    costTracker.record('openai', 'gpt-4o-mini', -50, -50, 's1');
    expect(costTracker.getSummary().totalCost).toBe(0);
  });

  it('clears history', () => {
    costTracker.record('openai', 'gpt-4o-mini', 1000, 1000, 's1');
    costTracker.clear();
    expect(costTracker.getSummary().calls).toBe(0);
  });
});

describe('formatCost', () => {
  it('keeps precision at small amounts instead of rounding to zero', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.00042)).toBe('$0.0004');
    expect(formatCost(0.1234)).toBe('$0.123');
    expect(formatCost(12.3456)).toBe('$12.35');
  });
});
