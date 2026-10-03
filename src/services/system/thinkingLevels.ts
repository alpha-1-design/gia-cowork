/**
 * Thinking levels.
 *
 * This used to be a boolean called `extThinking` — on or off — even though
 * almost every provider exposes a spectrum. So the setting either did nothing
 * (the flag was only ever read to decide whether to *show* the reasoning UI)
 * or it was forced to the provider's maximum, which is the wrong default for a
 * routine question and an expensive one.
 *
 * The levels are now named and mapped. What each one actually does:
 *
 *  - The prompt tells the model how much to deliberate, in words, because a
 *    reasoning model responds to an explicit budget instruction and ignores an
 *    absent one.
 *  - The runtime budget is passed where the provider accepts one. Providers
 *    that ignore an unknown budget are unaffected, which is why the mapping is
 *    additive rather than a required parameter.
 *  - `max` is kept as a distinct level rather than folded into `high`, because
 *    people do ask for it specifically and "everything at once" is a real
 *    setting even if it is rarely correct.
 *
 * The honest caveat: reasoning-token budgets are honoured by some providers and
 * silently ignored by others. So the level always does the thing that works
 * everywhere — it changes the instruction — and the budget is a bonus where
 * supported, never the mechanism the setting depends on.
 */

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

export interface ThinkingLevelSpec {
  id: ThinkingLevel;
  label: string;
  blurb: string;
  /** Sent to providers that accept a reasoning-token budget. */
  reasoningTokens: number | null;
  /** The instruction appended to the system prompt. */
  instruction: string;
}

export const THINKING_SPECS: Record<ThinkingLevel, ThinkingLevelSpec> = {
  off: {
    id: 'off',
    label: 'Off',
    blurb: 'Answer directly. Fastest, no visible reasoning.',
    reasoningTokens: null,
    instruction: '',
  },
  low: {
    id: 'low',
    label: 'Low',
    blurb: 'A quick check before answering. For simple, familiar questions.',
    reasoningTokens: 1024,
    instruction:
      'Think briefly before answering — a short private check that you have understood the question and are not about to answer it wrongly. Do not produce a visible reasoning trace for this, and do not deliberate at length.',
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    blurb: 'The default. Reason properly, then answer.',
    reasoningTokens: 4096,
    instruction:
      'Reason carefully before answering. Consider whether the obvious approach is actually correct, and check the main risk of being wrong. Then give a direct answer — your reasoning informs the answer, it does not replace it.',
  },
  high: {
    id: 'high',
    label: 'High',
    blurb: 'For hard problems. Weighs alternatives before committing.',
    reasoningTokens: 16384,
    instruction:
      'Think hard about this. Before committing to an approach, consider at least one alternative and say why you rejected it. Look for the case where your first instinct is wrong. Take the time you need, then give a clear final answer.',
  },
  max: {
    id: 'max',
    label: 'Max',
    blurb: 'Everything at once. Slow and thorough — use deliberately.',
    reasoningTokens: 32768,
    instruction:
      'Think as thoroughly as this problem deserves. Explore the space properly: consider multiple approaches, check assumptions from first principles, and verify your conclusion would survive being wrong in one specific way. Be exhaustive before you are decisive. This is slower and costs more — spend it where it earns its cost.',
  },
};

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === 'string' && (THINKING_LEVELS as string[]).includes(v);
}

/** Normalise anything, including a legacy boolean, into a level. */
export function toThinkingLevel(v: unknown): ThinkingLevel {
  if (isThinkingLevel(v)) return v;
  // The old flag: `true` meant "extended thinking", which maps to `high` rather
  // than `max` — turning the flag on should not silently triple the token bill.
  if (v === true) return 'high';
  if (v === false) return 'off';
  return DEFAULT_THINKING_LEVEL;
}

export function getThinkingSpec(level: unknown): ThinkingLevelSpec {
  return THINKING_SPECS[toThinkingLevel(level)];
}

/** The prompt line for a level. Empty for `off`. */
export function thinkingPromptBlock(level: unknown): string {
  const spec = getThinkingSpec(level);
  if (!spec.instruction) return '';
  return `\n## How much to think\n${spec.instruction}`;
}

/** Reasoning-token budget for providers that accept one. */
export function reasoningTokenBudget(level: unknown): number | null {
  return getThinkingSpec(level).reasoningTokens;
}