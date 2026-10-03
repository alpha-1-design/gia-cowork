import { describe, it, expect } from 'vitest';
import {
  THINKING_LEVELS, THINKING_SPECS, toThinkingLevel, getThinkingSpec,
  thinkingPromptBlock, reasoningTokenBudget, DEFAULT_THINKING_LEVEL,
} from '../system/thinkingLevels';
import { modePromptFor, PLAN_PROMPT, EXAM_PROMPT, ANALYST_PROMPT, CODE_PROMPT, ASK_PROMPT } from '../system/modePrompts';

describe('thinking levels', () => {
  it('offers off, low, medium, high and max', () => {
    expect(THINKING_LEVELS).toEqual(['off', 'low', 'medium', 'high', 'max']);
  });

  it('defaults to medium — enough to be careful without being slow', () => {
    expect(DEFAULT_THINKING_LEVEL).toBe('medium');
  });

  it('gives every level a label, a blurb and an instruction', () => {
    for (const l of THINKING_LEVELS) {
      const s = THINKING_SPECS[l];
      expect(s.id).toBe(l);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.blurb.length).toBeGreaterThan(10);
    }
  });

  it('sends nothing to the prompt when off, rather than an empty instruction', () => {
    expect(thinkingPromptBlock('off')).toBe('');
    expect(reasoningTokenBudget('off')).toBeNull();
  });

  it('changes the instruction as the level rises', () => {
    const low = thinkingPromptBlock('low');
    const max = thinkingPromptBlock('max');
    expect(low).not.toBe(max);
    expect(max.length).toBeGreaterThan(low.length);
  });

  it('scales the token budget with the level', () => {
    const budgets = THINKING_LEVELS.map(l => reasoningTokenBudget(l) ?? 0);
    for (let i = 1; i < budgets.length; i++) {
      expect(budgets[i]).toBeGreaterThan(budgets[i - 1]);
    }
  });

  it('migrates the old boolean without tripling the bill', () => {
    // `true` used to mean "extended thinking". Mapping it to `max` would silently
    // triple what a returning user pays for the setting they already had.
    expect(toThinkingLevel(true)).toBe('high');
    expect(toThinkingLevel(false)).toBe('off');
  });

  it('normalises anything unknown to the default', () => {
    expect(toThinkingLevel('nonsense')).toBe('medium');
    expect(toThinkingLevel(undefined)).toBe('medium');
    expect(toThinkingLevel(null)).toBe('medium');
  });

  it('passes valid levels through untouched', () => {
    for (const l of THINKING_LEVELS) expect(toThinkingLevel(l)).toBe(l);
  });

  it('is safe for a level that does not exist', () => {
    expect(getThinkingSpec('bogus').id).toBe('medium');
  });
});

describe('mode prompts', () => {
  it('gives every mode a prompt with real content', () => {
    for (const m of ['plan', 'ask', 'code', 'exam', 'analyst']) {
      expect(modePromptFor(m).length).toBeGreaterThan(200);
    }
  });

  it('delegates build mode to the builder prompt', () => {
    expect(modePromptFor('build')).toBe('');
  });

  it('PLAN states what to do, not only what is forbidden', () => {
    // The old prompt was purely a permission boundary, so a plan came back as
    // a list of steps rather than a decision the user could approve.
    expect(PLAN_PROMPT).toMatch(/could go wrong|what you are NOT doing|how you will know/i);
    expect(PLAN_PROMPT).toMatch(/asking for approval/i);
  });

  it('ASK forbids tools and demands honesty about uncertainty', () => {
    expect(ASK_PROMPT).toMatch(/No tools/);
    expect(ASK_PROMPT).toMatch(/do not know|not sure/i);
  });

  it('CODE forbids half-finished work and unverified success claims', () => {
    expect(CODE_PROMPT).toMatch(/No TODOs|stub/i);
    expect(CODE_PROMPT).toMatch(/read the output/i);
  });

  it('EXAM never gives the answer first — that is the whole point of tutoring', () => {
    expect(EXAM_PROMPT).toMatch(/Never give the final answer first/i);
    expect(EXAM_PROMPT).toMatch(/hint/i);
  });

  it('ANALYST separates evidence from inference and refuses manufactured consensus', () => {
    expect(ANALYST_PROMPT).toMatch(/inference/i);
    expect(ANALYST_PROMPT).toMatch(/manufacture certainty|manufacture/i);
  });
});