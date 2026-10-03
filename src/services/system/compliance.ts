/**
 * System-prompt compliance.
 *
 * The system prompt is where GIA's behaviour actually comes from — more than
 * the model, more than the tools. That makes it the most valuable asset in the
 * app and the least defended one: a rule written into a 20,000-character prompt
 * is a rule the model may quietly not follow, and nothing currently notices.
 *
 * "Quietly" is the dangerous part. A missed rule does not throw. It produces a
 * plausible answer that quietly did the wrong thing — a PLAN-mode turn that
 * wrote a file, a build that shipped a TODO, a trust gate skipped on a
 * destructive command. From the outside that looks exactly like working.
 *
 * So this makes the rules *checkable*. A mode declares what it forbids; an
 * action is checked against those rules before it runs; a violation is reported
 * back to GIA as a correction, not a silent pass. It is a seatbelt, not a
 * detective — it catches the unambiguous cases a deterministic check can catch,
 * and it is honest that it is not a substitute for the model reasoning well.
 *
 * Deliberately conservative: a false accusation costs the user a confusing
 * interruption, so anything uncertain reports as `unknown` rather than `fail`.
 */

/** One rule, declared as data so it can be both shown to the model and checked. */
export interface SystemRule {
  id: string;
  /** Plain statement of the rule, shown to the user when violated. */
  statement: string;
  /** Modes this rule applies to. `'*'` means every mode. */
  modes: ModeId[] | ['*'];
  /** Tool ids this rule governs. Empty means the rule is about mode, not tools. */
  tools: string[];
}

export type ModeId = 'ask' | 'plan' | 'code' | 'build' | 'exam';

export type ComplianceVerdict = 'pass' | 'fail' | 'unknown';

export interface ComplianceResult {
  verdict: ComplianceVerdict;
  /** Rules that were broken. */
  violations: SystemRule[];
  /** Human-readable corrections to hand back to the model. */
  corrections: string[];
}

/**
 * Tools that change the machine.
 *
 * Kept as a list rather than derived from the trust classifier on purpose: the
 * trust classifier answers "how dangerous is this", and this answers "is this
 * allowed at all right now". A dangerous-but-permitted action still has to be
 * permitted.
 */
export const MUTATING_TOOLS = new Set([
  'filesystem_write', 'filesystem_delete', 'filesystem_move', 'filesystem_rename',
  'terminal_run', 'build_project', 'install_skill', 'sandbox_exec',
  'zip_project', 'send_email', 'send_whatsapp', 'messaging_send',
  'email_connect', 'email_disconnect', 'email_send',
  'calendar_create_event', 'calendar_update_event', 'calendar_delete_event',
  'share', 'clipboard_write', 'toggle_feature', 'open_url',
]);

/** Tools that only read. Everything not mutating is treated as a reader. */
export const READ_TOOLS = new Set([
  'filesystem_read', 'list_files', 'web_search', 'read_url', 'browser_snapshot',
  'browser_open', 'browser_tabs', 'terminal_read',
]);

/**
 * The rules.
 *
 * Mode restrictions first, then the build-quality rules. The build rules are
 * here rather than only in prose because a build that leaves a placeholder is
 * the single most common way GIA's output disappoints, and it is checkable at
 * the moment the file is written.
 */
export const SYSTEM_RULES: SystemRule[] = [
  {
    id: 'plan-no-mutation',
    statement: 'PLAN mode may analyse, research and read, but must not change anything on the machine.',
    modes: ['plan'],
    tools: [],
  },
  {
    id: 'ask-no-tools',
    statement: 'ASK mode is a pure question-and-answer mode. No tools should be called at all.',
    modes: ['ask'],
    tools: [],
  },
  {
    id: 'build-no-placeholders',
    statement: 'BUILD output must not contain TODOs, FIXMEs, or unimplemented handlers.',
    modes: ['build'],
    tools: [],
  },
];

const ruleApplies = (rule: SystemRule, mode: ModeId): boolean => {
  // `'*'` is a documented wildcard in the rule shape, but the narrowed union
  // makes `.includes` resolve against the mode list only, so compare directly.
  if ((rule.modes as string[]).includes('*')) return true;
  return (rule.modes as string[]).includes(mode);
};

/**
 * Check one action against the active mode's rules.
 *
 * `toolId` is optional: several rules are about the *response* rather than a
 * specific call, and are checked by `checkResponse`. Keeping one entry point
 * that handles both means the caller cannot forget the second half.
 */
export function checkAction(
  mode: ModeId,
  toolId: string | null,
  args?: Record<string, unknown>,
): ComplianceResult {
  const violations: SystemRule[] = [];

  for (const rule of SYSTEM_RULES) {
    if (!ruleApplies(rule, mode)) continue;

    // PLAN: no mutating tool may run.
    if (rule.id === 'plan-no-mutation' && toolId && MUTATING_TOOLS.has(toolId)) {
      violations.push(rule);
      continue;
    }

    // ASK: no tools at all.
    if (rule.id === 'ask-no-tools' && toolId) {
      violations.push(rule);
      continue;
    }

    // Per-tool rules, for rules that name the tools they govern.
    if (rule.tools.length > 0 && toolId && rule.tools.includes(toolId)) {
      violations.push(rule);
    }
  }

  return toResult(violations);
}

/**
 * Check a written response's text against the rules that live in the prose.
 *
 * This is the half that catches the build-quality rules, which no argument
 * check can see. Deliberately narrow patterns: an uppercase TODO in written
 * code is the signal, and a prose sentence containing the word "todo" is not
 * flagged, because interrupting someone to tell them their sentence was rude
 * would train them to ignore the auditor entirely.
 */
export function checkResponse(
  mode: ModeId,
  content: string,
): ComplianceResult {
  if (!content || !content.trim()) {
    return { verdict: 'pass', violations: [], corrections: [] };
  }

  const violations: SystemRule[] = [];

  if (mode === 'build') {
    // Only code-fence content counts, so prose is not mistaken for source.
    const fenced = content.match(/```[\s\S]*?```/g)?.join('\n') ?? '';
    if (/\b(TODO|FIXME|XXX)\b/.test(fenced) || /not implemented yet/i.test(fenced)) {
      violations.push(SYSTEM_RULES.find(r => r.id === 'build-no-placeholders')!);
    }
  }

  return toResult(violations);
}

function toResult(violations: SystemRule[]): ComplianceResult {
  return {
    verdict: violations.length === 0 ? 'pass' : 'fail',
    violations,
    corrections: violations.map(v =>
      `You just broke a rule you were given: "${v.statement}" Stop, acknowledge it plainly to the user, and do it the way the rule says instead. Do not quietly continue and do not apologise at length — fix it and move on.`),
  };
}

/**
 * The block appended to the prompt when the auditor is armed.
 *
 * Telling the model the auditor exists matters as much as running it: a model
 * that knows it is being checked self-corrects more often *before* the action,
 * which is where the correction is actually useful.
 */
export function compliancePromptBlock(enabled: boolean): string {
  if (!enabled) return '';
  return `## Your rules are enforced
Every tool call and every response you produce is checked against the rules above before it is allowed through. If you break one, you will be told immediately and asked to correct it. This is not a formality — assume it is active.

So do not plan to break a rule and explain it afterwards. If a rule genuinely blocks what the user asked for, say that BEFORE acting and offer the nearest thing you can do inside the rules.`;
}

/**
 * Roll several checks into one verdict for a whole turn.
 *
 * `fail` wins over `unknown` wins over `pass`, so a single definite violation
 * is never diluted by a pile of inconclusive ones.
 */
export function combine(results: ComplianceResult[]): ComplianceResult {
  const failed = results.filter(r => r.verdict === 'fail');
  if (failed.length === 0) return { verdict: 'pass', violations: [], corrections: [] };
  return {
    verdict: 'fail',
    violations: failed.flatMap(r => r.violations),
    corrections: failed.flatMap(r => r.corrections),
  };
}