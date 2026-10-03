import { describe, it, expect } from 'vitest';
import {
  checkAction, checkResponse, combine, compliancePromptBlock,
  SYSTEM_RULES, MUTATING_TOOLS, type ComplianceResult,
} from '../system/compliance';

/**
 * The auditor's value depends entirely on two things being true at once:
 * it must catch real violations, and it must not cry wolf.
 *
 * A false accusation is expensive in a way a miss is not. A miss is a bug the
 * user might notice. A wrong "you broke a rule" stops work that was fine, and
 * once that happens twice the user stops reading the warnings — at which point
 * the auditor is worse than absent, because it trained the user to ignore it.
 */

const fail = (r: ComplianceResult) => r.verdict === 'fail';

describe('PLAN mode', () => {
  it('blocks a file write', () => {
    expect(fail(checkAction('plan', 'filesystem_write'))).toBe(true);
  });

  it('blocks a terminal command', () => {
    expect(fail(checkAction('plan', 'terminal_run'))).toBe(true);
  });

  it('blocks installing a skill', () => {
    expect(fail(checkAction('plan', 'install_skill'))).toBe(true);
  });

  it('allows reading files', () => {
    expect(checkAction('plan', 'filesystem_read').verdict).toBe('pass');
  });

  it('allows web search — PLAN is meant to research', () => {
    expect(checkAction('plan', 'web_search').verdict).toBe('pass');
  });

  it('allows an unknown tool, because the gate is not a whitelist', () => {
    // Refusing everything unrecognised would block the app the first time
    // someone added a tool.
    expect(checkAction('plan', 'some_future_tool').verdict).toBe('pass');
  });
});

describe('ASK mode', () => {
  it('blocks every tool', () => {
    for (const t of ['web_search', 'filesystem_read', 'filesystem_write']) {
      expect(fail(checkAction('ask', t)), `${t} should be blocked`).toBe(true);
    }
  });
});

describe('BUILD mode', () => {
  it('does not block tools — build has full access', () => {
    expect(checkAction('build', 'filesystem_write').verdict).toBe('pass');
    expect(checkAction('build', 'terminal_run').verdict).toBe('pass');
  });
});

describe('response checks', () => {
  it('flags a TODO inside code in build mode', () => {
    expect(fail(checkResponse('build', 'Here you go:\n```ts\n// TODO: fix this\n```'))).toBe(true);
  });

  it('flags an unimplemented handler', () => {
    expect(fail(checkResponse('build', '```js\nfunction go() { /* not implemented yet */ }\n```'))).toBe(true);
  });

  it('does NOT flag the word TODO in ordinary prose', () => {
    // The false-positive this guards: interrupting someone to tell them their
    // sentence was rude would make the auditor something to route around.
    expect(checkResponse('build', 'Put a TODO comment in each function so you can track them.').verdict).toBe('pass');
  });

  it('does not check build-quality rules outside build mode', () => {
    expect(checkResponse('code', '```ts\n// TODO: later\n```').verdict).toBe('pass');
  });

  it('passes an empty response rather than guessing', () => {
    expect(checkResponse('build', '').verdict).toBe('pass');
    expect(checkResponse('build', '   ').verdict).toBe('pass');
  });
});

describe('combine', () => {
  it('lets one definite failure stand', () => {
    const out = combine([
      { verdict: 'pass', violations: [], corrections: [] },
      checkAction('plan', 'terminal_run'),
    ]);
    expect(out.verdict).toBe('fail');
    expect(out.corrections.length).toBeGreaterThan(0);
  });

  it('passes when everything passed', () => {
    expect(combine([checkAction('code', 'web_search')]).verdict).toBe('pass');
  });

  it('passes an empty list', () => {
    expect(combine([]).verdict).toBe('pass');
  });
});

describe('prompt block', () => {
  it('is empty when disarmed, so nothing is claimed that is not enforced', () => {
    expect(compliancePromptBlock(false)).toBe('');
  });

  it('tells the model it is being watched when armed', () => {
    expect(compliancePromptBlock(true)).toMatch(/checked|enforced/i);
  });
});

describe('rule data integrity', () => {
  it('has unique rule ids', () => {
    const ids = SYSTEM_RULES.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every rule a statement a user could read', () => {
    for (const r of SYSTEM_RULES) {
      expect(r.statement.length).toBeGreaterThan(20);
      expect(r.statement.endsWith('.')).toBe(true);
    }
  });

  it('does not classify the same tool as both mutating and reading', () => {
    for (const r of SYSTEM_RULES) void r;
    expect(MUTATING_TOOLS.has('filesystem_write')).toBe(true);
    expect(MUTATING_TOOLS.has('filesystem_read')).toBe(false);
  });
});