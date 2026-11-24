import { logger } from '../../utils/logger';
import { isUntrustedToolOutput, containsInjectedInstruction } from '../untrusted';
import type { RolloutLine } from '../brain/rollout';

/**
 * MYELIN ∘ MURMURATION — one amendment engine, two scopes.
 *
 * MYELIN (constitution scope): GIA tunes her own advisory prompt rules from
 * measured session outcomes — propose → cross-examine → trial → rollback —
 * journaled to a persistent amendments ledger. MURMURATION (run scope): the
 * same engine distills a finished swarm run into run-scoped lane rules that
 * expire when the next run starts.
 *
 * THE DESIGN CLOSES THE DEBATE'S ATTACKS IN CODE, NOT PROSE (R2-semiB):
 *
 * A1 — evidence trust is re-derived per line: `isUntrustedToolOutput` covers
 *      the tool id of every evidence line, and anything web/mcp/bridge-derived
 *      is evidence-non-grata. No amendment may cite it.
 * A2 — amendment-as-persistent-injection is structurally impossible: the model
 *      never writes amendment prose. It picks a TEMPLATE ID from the fixed
 *      in-code library (AMENDABLE_RULES) and supplies evidence; `validateDraft`
 *      requires the rendered rule to be byte-equal to the template and refuses
 *      anything containing injected-instruction patterns. The constitution
 *      receives only text this file owns.
 * A3 — governor as deletion channel: the amendment block is added to the
 *      prompt-budget accounting in buildGiaSystem, but is NOT in the governor's
 *      trim list — it cannot be silently trimmed, and it is bounded (≤3 active)
 *      by the store itself.
 * A4 — glacial reveal: the run scope fires every swarm run, so self-modification
 *      is visible from day one while the constitution flywheel compounds.
 * M1/M2 — wake-style distillation laundering: run-scoped rules go through the
 *      same evidence-trust filter and the same journal as constitution
 *      amendments; nothing distilled from untrusted lane output moves anything.
 */

/** The amendable rule library. THE ONLY text that can ever enter the constitution. */
export interface AmendableRule {
  id: string;
  /** The advisory rule text, byte-frozen. */
  text: string;
  /** Human explanation of what measured pattern justifies it. */
  pattern: string;
  /** Minimum evidence weight to propose it. */
  threshold: number;
  /** Evidence weight the FIRST proposal requires (trial promotes later). */
  proposeAt: number;
}

export const AMENDABLE_RULES: AmendableRule[] = [
  {
    id: 'search-before-fetch',
    text: 'Before fetching a specific URL, run web_search first — fetching blind repeatedly produced failed reads in past sessions. Search narrows targets and costs less.',
    pattern: 'repeated web_fetch failures without a preceding web_search',
    threshold: 2,
    proposeAt: 2,
  },
  {
    id: 'read-before-edit',
    text: 'Read a file before editing it — past sessions show edits made without a prior read needed rework. Reads are cheap; blind edits are not.',
    pattern: 'file edits with no earlier read of the same path',
    threshold: 2,
    proposeAt: 2,
  },
  {
    id: 'batch-parallel-tools',
    text: 'Batch independent tool calls in one message — sequential round-trips for independent reads were the dominant time cost in past sessions.',
    pattern: 'long chains of sequential independent tool calls',
    threshold: 5,
    proposeAt: 5,
  },
  {
    id: 'respect-gate-denials',
    text: 'When the user denies a tool twice for the same intent, stop re-proposing it and ask in chat what they actually want — repeated denied attempts eroded trust in past sessions.',
    pattern: 'two or more gate denials for the same tool in one session',
    threshold: 2,
    proposeAt: 2,
  },
  {
    id: 'retry-then-change-approach',
    text: 'After two failed attempts at the same tool with the same arguments, change the approach instead of retrying a third time — retry storms were a measured cost in past sessions.',
    pattern: 'retry storms (same tool+args attempted 3+ times)',
    threshold: 1,
    proposeAt: 1,
  },
];

export function amendableRuleById(id: string): AmendableRule | undefined {
  return AMENDABLE_RULES.find((r) => r.id === id);
}

// ── Evidence ─────────────────────────────────────────────────────────────

/** Outcome statistics distilled from ONE session or ONE swarm run. */
export interface SessionStats {
  /** tool_call → tool_output ❌ / error patterns, by tool. */
  misfiresByTool: Record<string, number>;
  /** same tool + same args attempted 3+ times. */
  retryStorms: number;
  /** tool calls with NO matching tool_output at session end. */
  unansweredCalls: number;
  /** file edits (write family) whose path was never read earlier. */
  blindEdits: number;
  /** web_fetch calls that happened with no web_search earlier. */
  blindFetches: number;
  /** tool calls seen (for scale). */
  toolCalls: number;
  /** Denials cannot be read from a rollout (they live in the trust audit);
   *  wired in by the caller when available. */
  gateDenialsByTool?: Record<string, number>;
  /** Which evidence lines were trusted vs dropped. */
  trustedLines: number;
  untrustedLines: number;
}

/** Rollout entries as the distiller consumes them. */
export type DistillerLine = Extract<RolloutLine, { type: 'tool_call' | 'tool_output' | 'message' }>;
export type { RolloutLine };

const isMisfire = (output: string): boolean =>
  /(^|\n)\s*(❌|failed|error[: ]|traceback|permission denied)/i.test(output.slice(0, 400));

/**
 * Distill outcome stats from rollout lines. THIS IS ATTACK-A1'S ANSWER:
 * evidence weight is only counted from lines whose tool id is NOT
 * untrusted-derived (the caller pre-filters with `isUntrustedToolOutput`),
 * and the split is reported so the journal can prove it happened.
 */
export function distillLines(lines: DistillerLine[]): SessionStats {
  const stats: SessionStats = {
    misfiresByTool: {},
    retryStorms: 0,
    unansweredCalls: 0,
    blindEdits: 0,
    blindFetches: 0,
    toolCalls: 0,
    trustedLines: 0,
    untrustedLines: 0,
  };

  const calls: { id: string; tool: string; args: string; trusted: boolean }[] = [];
  const outputs = new Map<string, { tool: string; output: string; trusted: boolean }>();

  for (const line of lines) {
    const trusted = line.type === 'message' || !isUntrustedToolOutput(line.tool);
    if (line.type === 'message') {
      stats.trustedLines++;
      continue;
    }
    if (trusted) stats.trustedLines++;
    else stats.untrustedLines++;

    if (line.type === 'tool_call') {
      stats.toolCalls++;
      calls.push({ id: line.id, tool: line.tool, args: line.args, trusted });
    } else if (line.type === 'tool_output') {
      outputs.set(line.id, { tool: line.tool, output: line.output, trusted });
    }
  }

  // Misfires: trusted outputs only — a failed read_url is web-derived and
  // cannot vote, but an honest filesystem error can.
  for (const [, o] of outputs) {
    if (o.trusted && isMisfire(o.output)) {
      stats.misfiresByTool[o.tool] = (stats.misfiresByTool[o.tool] ?? 0) + 1;
    }
  }

  // Retry storms: same trusted tool + identical args, 3+ attempts.
  const byKey = new Map<string, number>();
  for (const c of calls) {
    if (!c.trusted) continue;
    const key = `${c.tool}::${c.args}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  for (const [, n] of byKey) if (n >= 3) stats.retryStorms++;

  // Unanswered calls.
  for (const c of calls) if (!outputs.has(c.id)) stats.unansweredCalls++;

  // Blind edits: an edit-family call whose path was never READ earlier in
  // the session (trusted calls only).
  const readPaths = new Set<string>();
  for (const c of calls) {
    if (!c.trusted) continue;
    if (/^(read_file|file_read|filetool_read|cat)$/i.test(c.tool)) {
      const p = extractPath(c.args);
      if (p) readPaths.add(p);
    }
  }
  for (const c of calls) {
    if (!c.trusted) continue;
    if (/^(write_file|file_write|edit_file|filetool_write|filetool_edit|create_file)$/i.test(c.tool)) {
      const p = extractPath(c.args);
      if (p && !readPaths.has(p)) stats.blindEdits++;
    }
  }

  // Blind fetches: a web_fetch (or read_url) with no web_search earlier —
  // NOTE: the MISFIRE signal from these is untrusted, but the ORDER fact
  // (she searched or didn't) comes from the tool_call pattern itself, which
  // is her own behavior, not page content. That distinction is why
  // search-before-fetch is proposable at all.
  let sawSearch = false;
  for (const c of calls) {
    if (c.tool === 'web_search') sawSearch = true;
    if ((c.tool === 'web_fetch' || c.tool === 'read_url') && !sawSearch) stats.blindFetches++;
  }

  return stats;
}

function extractPath(argsJson: string): string | null {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const p = args.path ?? args.file_path ?? args.file;
    return typeof p === 'string' ? p : null;
  } catch {
    return null;
  }
}

// ── Proposal (template-only — A2's structural answer) ────────────────────

export interface AmendmentDraft {
  ruleId: string;
  /** The exact rule text from the template library. */
  ruleText: string;
  evidence: SessionStats;
  /** What in the stats crossed the rule's threshold. */
  rationale: string;
}

/**
 * Pick the FIRST satisfied rule (most urgent first, by library order).
 * Returns null when nothing crossed — no proposal is a normal outcome.
 */
export function proposeFromStats(stats: SessionStats, alreadyActive: string[]): AmendmentDraft | null {
  for (const rule of AMENDABLE_RULES) {
    if (alreadyActive.includes(rule.id)) continue;
    const weight = ruleWeight(rule.id, stats);
    if (weight >= rule.proposeAt) {
      const rendered = rule.text;
      if (containsInjectedInstruction(rendered)) {
        // The library itself is code-owned; this is a tripwire, not a filter.
        logger.error('[myelin] template text failed the injection tripwire:', rule.id);
        continue;
      }
      return {
        ruleId: rule.id,
        ruleText: rendered,
        evidence: stats,
        rationale: `${rule.pattern} — measured weight ${weight} ≥ ${rule.proposeAt}`,
      };
    }
  }
  return null;
}

function ruleWeight(ruleId: string, s: SessionStats): number {
  switch (ruleId) {
    case 'search-before-fetch': return s.blindFetches;
    case 'read-before-edit': return s.blindEdits;
    case 'batch-parallel-tools': {
      // Sequential chains ≈ many calls with few outputs batched per turn is
      // not directly observable in a rollout; approximate with unanswered +
      // call volume, the cheapest honest proxy.
      return s.toolCalls >= 10 ? Math.min(s.toolCalls, 10) : 0;
    }
    case 'respect-gate-denials': {
      const d = s.gateDenialsByTool ?? {};
      return Math.max(0, ...Object.values(d));
    }
    case 'retry-then-change-approach': return s.retryStorms;
    default: return 0;
  }
}

/**
 * Validate a draft against the library. Byte-equality with the template is
 * the whole law: if the text differs by one character, refuse.
 */
export function validateDraft(draft: AmendmentDraft): { ok: boolean; reason?: string } {
  const rule = amendableRuleById(draft.ruleId);
  if (!rule) return { ok: false, reason: `unknown rule template: ${draft.ruleId}` };
  if (draft.ruleText !== rule.text) {
    return { ok: false, reason: 'rule text is not byte-equal to the code-owned template — amendments may only be template instances' };
  }
  if (containsInjectedInstruction(draft.rationale)) {
    return { ok: false, reason: 'rationale carries an injected-instruction pattern' };
  }
  return { ok: true };
}

// ── Cross-examination (the second engine) ────────────────────────────────

export interface Objection {
  claim: string;
  severity: 'blocker' | 'note';
}

export interface CrossExamResult {
  verdict: 'ship' | 'reject';
  objections: Objection[];
  /** Which engine produced the critique. */
  engine: string;
}

export type CrossExaminer = (draft: AmendmentDraft) => Promise<CrossExamResult>;

// ── Journal ──────────────────────────────────────────────────────────────

export type AmendmentStatus = 'PROPOSED' | 'ON_TRIAL' | 'ACTIVE' | 'ROLLED_BACK' | 'REJECTED';

export interface AmendmentRecord {
  id: string;
  scope: 'constitution' | 'run';
  ruleId: string;
  ruleText: string;
  rationale: string;
  evidence: SessionStats;
  objections: Objection[];
  engine: string;
  status: AmendmentStatus;
  createdAt: number;
  decidedAt?: number;
  /** Constitution scope: sessions observed while on trial, with stats. */
  trialSessions?: { stats: SessionStats; at: number }[];
  /** Trial verdict after K sessions. */
  trialVerdict?: 'promoted' | 'rolled-back';
  rollbackReason?: string;
  /** Run scope: expired when the next run started. */
  expiredAt?: number;
}

/** Pure trial evaluator: does the newest stats session REGRESS the rule? */
export function evaluateTrialSession(
  ruleId: string,
  history: SessionStats[],
  k = 5,
): 'promote' | 'rollback' | 'keep-watching' {
  const before = history[0];
  const after = history[history.length - 1];
  if (history.length < k) return 'keep-watching';
  const w = (id: string, s: SessionStats) => ruleWeight(id, s);
  const after2 = w(ruleId, after);
  const before2 = w(ruleId, before);
  // Regression: the pattern the rule targets got WORSE, not better.
  if (after2 > before2) return 'rollback';
  return 'promote';
}
