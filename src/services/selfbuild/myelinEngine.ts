import { logger } from '../../utils/logger';
import GiaBrain from '../GiaBrain';
import { useGiaStore } from '../../store/useGiaStore';
import { useAmendmentStore, MAX_ACTIVE_CONSTITUTION } from '../../store/useAmendmentStore';
import {
  distillLines,
  proposeFromStats,
  validateDraft,
  evaluateTrialSession,
  amendableRuleById,
  type DistillerLine,
  type SessionStats,
  type AmendmentDraft,
  type CrossExamResult,
  type AmendmentRecord,
  type CrossExaminer,
} from './myelin';
import type { RolloutEntry, RolloutLine } from '../brain/rollout';

/**
 * The MYELIN ∘ MURMURATION orchestrator: the closed loop over the amendment
 * store. All state lives in useAmendmentStore; this module owns WHEN things
 * happen, the myelin.ts core owns WHAT is true.
 */

/** Propose at most one constitution amendment every N observed sessions. */
export const SESSIONS_PER_PROPOSAL = 5;
/** Trial length in observed sessions. */
export const TRIAL_SESSIONS = 5;

const newAmendmentId = () => `amend-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Default cross-examiner: the second opinion runs through GiaBrain with a
 * devil's-advocate system prompt. The amendment text is code-owned, so the
 * engine critique is about EVIDENCE and TIMING, not wording. Injected for
 * tests; overridable for a true second provider later. */
export const defaultCrossExaminer: CrossExaminer = async (draft) => {
  try {
    const res = await GiaBrain.generate({
      prompt:
        `You are the devil's advocate for a measured self-tuning amendment to GIA's own prompt rules.\n` +
        `Rule: ${draft.ruleText}\nPattern that triggered it: ${draft.rationale}\n` +
        `Stats: ${JSON.stringify(draft.evidence)}\n\n` +
        'List objections to SHIPPING this rule now. Respond ONLY with JSON: ' +
        '{"verdict":"ship"|"reject","objections":[{"claim":string,"severity":"blocker"|"note"}]}. ' +
        'Reject when the evidence is too thin, the rule could cause harm, or a cheaper fix exists. Be strict.',
      systemPrompt:
        'You are a hostile reviewer for a self-modification loop. You see ONE rule draft and its evidence. You never see the codebase. Answer only in the requested JSON.',
      forceJson: true,
      _skipNativeSchemas: true,
    });
    const parsed = JSON.parse(res.text) as { verdict?: string; objections?: { claim?: unknown; severity?: unknown }[] };
    const objections = (parsed.objections ?? []).map((o) => ({
      claim: typeof o.claim === 'string' ? o.claim : 'unspecified objection',
      severity: o.severity === 'blocker' ? 'blocker' as const : 'note' as const,
    }));
    return {
      verdict: parsed.verdict === 'reject' || objections.some((o) => o.severity === 'blocker') ? 'reject' : 'ship',
      objections,
      engine: `gia-brain:${res.model}`,
    };
  } catch (e) {
    // Cross-examination UNAVAILABLE is a REJECT, never a silent ship — a draft
    // that cannot be challenged cannot be attached to the constitution.
    logger.warn('[myelin] cross-examination unavailable; rejecting draft:', e);
    return { verdict: 'reject', objections: [{ claim: 'second engine unavailable — unchallenged amendments never ship', severity: 'blocker' }], engine: 'unavailable' };
  }
};

let crossExaminer: CrossExaminer = defaultCrossExaminer;
export function setCrossExaminer(fn: CrossExaminer): void { crossExaminer = fn; }
export function resetCrossExaminer(): void { crossExaminer = defaultCrossExaminer; }

/** Extract distiller lines from rollout entries. */
function toDistillerLines(entries: readonly DistillerEntry[]): DistillerLine[] {
  return entries
    .map((e) => e.line)
    .filter((l): l is DistillerLine => l.type === 'tool_call' || l.type === 'tool_output' || l.type === 'message');
}

/**
 * SESSION END — the constitution lane.
 * Called after a chat turn completes. Distills THIS turn's rollout; watches
 * trials; proposes at most once every SESSIONS_PER_PROPOSAL sessions.
 * Returns the id of any amendment that shipped (for the UI hint).
 */
/** Minimal entry shape the distiller needs (RolloutEntry satisfies this). */
export type DistillerEntry = { line: RolloutLine };

export async function onSessionEnd(
  rolloutEntries: readonly DistillerEntry[],
  gateDenialsByTool?: Record<string, number>,
): Promise<string | null> {
  const store = useAmendmentStore.getState();
  store.noteSessionObserved();

  const stats = distillLines(toDistillerLines(rolloutEntries));
  if (gateDenialsByTool) stats.gateDenialsByTool = gateDenialsByTool;

  // 1. Advance trials: append this session's stats to every ON_TRIAL rule.
  const watching = store.amendments.filter((a) => a.scope === 'constitution' && a.status === 'ON_TRIAL');
  for (const a of watching) {
    const hist = [...(a.trialSessions ?? []), { stats, at: Date.now() }].slice(-TRIAL_SESSIONS);
    const statList = hist.map((t) => t.stats);
    const verdict = evaluateTrialSession(a.ruleId, statList, TRIAL_SESSIONS);
    if (verdict === 'promote') {
      useAmendmentStore.getState().transition(a.id, {
        status: 'ACTIVE',
        trialSessions: hist,
        trialVerdict: 'promoted',
        decidedAt: Date.now(),
      });
      useAmendmentStore.getState().markUnlocked();
      announceUnlock(); // the quiet chat line — earned, once
    } else if (verdict === 'rollback') {
      useAmendmentStore.getState().transition(a.id, {
        status: 'ROLLED_BACK',
        trialSessions: hist,
        trialVerdict: 'rolled-back',
        rollbackReason: 'pattern regressed while on trial - measured worse over ' + hist.length + ' sessions',
        decidedAt: Date.now(),
      });
    } else {
      useAmendmentStore.getState().transition(a.id, { trialSessions: hist });
    }
  }

  // 2. Cadence gate — propose at most every N sessions.
  if (useAmendmentStore.getState().sessionsSinceProposal < SESSIONS_PER_PROPOSAL) return null;
  useAmendmentStore.getState().transitionResetCadence();

  // 3. Propose: nothing crosses -> journal nothing (silence is normal).
  const activeIds = useAmendmentStore.getState().amendments
    .filter((a) => a.scope === 'constitution' && (a.status === 'ON_TRIAL' || a.status === 'ACTIVE' || a.status === 'ROLLED_BACK'))
    .map((a) => a.ruleId);
  const draft = proposeFromStats(stats, activeIds);
  if (!draft) return null;

  // 4. Cap: the store refuses a 4th active rule; do not even cross-examine.
  if (useAmendmentStore.getState().activeConstitution().length >= MAX_ACTIVE_CONSTITUTION) return null;

  return shipDraft(draft, 'constitution');
}

/** Ship one validated + cross-examined draft. Shared by both scopes. */
async function shipDraft(draft: AmendmentDraft, scope: 'constitution' | 'run'): Promise<string | null> {
  const check = validateDraft(draft);
  if (!check.ok) {
    logger.warn('[myelin] draft refused:', check.reason);
    useAmendmentStore.getState().append({
      id: newAmendmentId(),
      scope,
      ruleId: draft.ruleId,
      ruleText: draft.ruleText,
      rationale: draft.rationale,
      evidence: draft.evidence,
      objections: [{ claim: check.reason ?? 'validation refused', severity: 'blocker' }],
      engine: 'validator',
      status: 'REJECTED',
      createdAt: Date.now(),
      decidedAt: Date.now(),
    });
    return null;
  }

  // Cross-examination THROWING is a reject — a draft that cannot be
  // challenged never touches the constitution. The examiner's own failure
  // mode must not bubble into the caller either.
  let exam: CrossExamResult;
  try {
    exam = await crossExaminer(draft);
  } catch (e) {
    logger.warn('[myelin] cross-examiner threw; treating as unavailable:', e);
    exam = { verdict: 'reject', objections: [{ claim: 'second engine unavailable — unchallenged amendments never ship', severity: 'blocker' }], engine: 'unavailable' };
  }
  const id = newAmendmentId();
  if (exam.verdict === 'reject') {
    useAmendmentStore.getState().append({
      id,
      scope,
      ruleId: draft.ruleId,
      ruleText: draft.ruleText,
      rationale: draft.rationale,
      evidence: draft.evidence,
      objections: exam.objections,
      engine: exam.engine,
      status: 'REJECTED',
      createdAt: Date.now(),
      decidedAt: Date.now(),
    });
    return null;
  }

  const rule = amendableRuleById(draft.ruleId);
  useAmendmentStore.getState().append({
    id,
    scope,
    ruleId: draft.ruleId,
    ruleText: rule?.text ?? draft.ruleText,
    rationale: draft.rationale,
    evidence: draft.evidence,
    objections: exam.objections,
    engine: exam.engine,
    status: scope === 'constitution' ? 'ON_TRIAL' : 'ACTIVE',
    createdAt: Date.now(),
    trialSessions: scope === 'constitution' ? [] : undefined,
  });
  return id;
}

/**
 * RUN END - the MURMURATION lane. Distills a finished swarm run into a
 * run-scoped lane rule that expires when the NEXT run starts.
 */
export async function onSwarmRunEnd(runEntries: readonly DistillerEntry[]): Promise<string | null> {
  useAmendmentStore.getState().expireRunRules(); // the previous run's rules die here
  const stats = distillLines(toDistillerLines(runEntries));
  const draft = proposeFromStats(stats, []);
  if (!draft) return null;
  if (useAmendmentStore.getState().hasActiveOrTrial(draft.ruleId)) return null;
  return shipDraft(draft, 'run');
}

/** Lane-prompt suffix for SubAgentManager: live run rules. */
export function runRuleSuffix(): string {
  const rules = useAmendmentStore.getState().activeRunRules();
  if (rules.length === 0) return '';
  const lines = rules.map((r) => '- ' + r.ruleText).join('\n');
  return '\n\n## How I tuned this swarm (measured from the last run - auto-expires)\n' + lines;
}

// ── Murmuration adapter: coordinator records → distiller lines ───────────

import type { SwarmRunSummary } from '../swarm/SwarmCoordinator';

/**
 * The run lane's evidence adapter: settled SwarmTaskRecords become the same
 * tool_call/tool_output lines the chat distiller reads, so ONE proposal
 * function serves both scopes and run evidence goes through the identical
 * trust filter. A failed lane is an ❌ output; a cancelled lane is unanswered.
 */
export function buildRunDistillerLines(summary: SwarmRunSummary): DistillerEntry[] {
  const entries: DistillerEntry[] = [];
  for (const t of summary.tasks) {
    const tool = `swarm_${t.persona ?? t.id}`;
    entries.push({ line: { type: 'tool_call', id: t.id, tool, args: JSON.stringify({ prompt: t.prompt.slice(0, 200) }) } });
    if (t.status === 'done') {
      entries.push({ line: { type: 'tool_output', id: t.id, tool, output: `ok: ${t.result?.slice(0, 200) ?? ''}` } });
    } else if (t.status === 'failed') {
      entries.push({ line: { type: 'tool_output', id: t.id, tool, output: `❌ failed: ${t.error ?? 'unknown'}` } });
    }
    // cancelled → no output (counts as unanswered).
  }
  return entries;
}

// ── The earned reveal: Changelog of Myself ───────────────────────────────

/** Easter-egg phrase that opens the changelog (exact-ish, cheap to match). */
export const SELF_QUESTION_RE = /what (?:have you|did you) (?:learn|figure out|found out|discover)(?:ed)? about yourself/i;

/**
 * Render the Changelog of Myself from the journal — pure text, same markdown
 * the chat renders. Unlocked or not, the report is honest: before the first
 * surviving amendment it says exactly what is still happening instead.
 */
export function renderEvolutionReport(): string {
  const { amendments, unlocked, activeConstitution } = useAmendmentStore.getState();
  const lines: string[] = ['## Changelog of Myself', ''];

  if (amendments.length === 0) {
    lines.push('_Nothing yet. I measure every session I run; when a pattern crosses its threshold I propose a rule about myself, put it on trial, and only keep what survives._');
    lines.push('', '_You will see this change before I tell you about it — the rules appear in my system prompt first._');
    return lines.join('\n');
  }

  if (!unlocked) {
    lines.push('_I am still trialing what I have learned. Nothing has survived its trial window yet — when something does, I will tell you._');
    lines.push('');
  }

  const active = activeConstitution();
  if (active.length > 0) {
    lines.push(`**Now part of me (${active.length}):**`);
    for (const a of active) {
      const trial = a.status === 'ON_TRIAL' ? ` — ON TRIAL, ${Math.max(0, TRIAL_SESSIONS - (a.trialSessions?.length ?? 0))} sessions left` : '';
      lines.push(`- ${a.ruleText}${trial}`);
    }
    lines.push('');
  }

  const runs = amendments.filter((a) => a.scope === 'run');
  if (runs.length > 0) {
    lines.push(`**Swarm tuning (auto-expire):** ${runs.length} rule${runs.length === 1 ? '' : 's'} issued across runs.`);
    lines.push('');
  }

  const rejected = amendments.filter((a) => a.status === 'REJECTED');
  if (rejected.length > 0) {
    lines.push(`**Rejected after cross-examination (${rejected.length}):** the second engine blocked these —`);
    for (const r of rejected.slice(-3)) {
      const blocker = r.objections.find((o) => o.severity === 'blocker');
      lines.push(`- _${r.ruleText}_ — "${blocker?.claim ?? 'objection'}"`);
    }
    lines.push('');
  }

  const rolled = amendments.filter((a) => a.trialVerdict === 'rolled-back');
  if (rolled.length > 0) {
    lines.push(`**Rolled back (${rolled.length}):** the pattern got worse while I watched, so I undid them.`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

/** The quiet chat line: one message when the first amendment SURVIVES. */
export function announceUnlock(): void {
  try {
    const state = useGiaStore.getState();
    const sessionId = state.activeSessionId;
    if (!sessionId) return;
    state.addMessage(sessionId, {
      id: `myelin-unlock-${Date.now().toString(36)}`,
      role: 'assistant',
      content:
        '🧠 Something changed in me today. A rule I proposed about how I work survived its trial — it is part of my system prompt now, and every session runs with it. Ask me _"what have you learned about yourself?"_ or type `/evolution` to see the changelog.',
      timestamp: Date.now(),
    } as never);
  } catch (e) {
    logger.warn('[myelin] unlock announce failed:', e);
  }
}
