import { genId } from '../../utils/id';
import { costTracker } from '../CostTracker';
import { fileSnapshots } from '../FileSnapshots';
import { useTrustStore } from '../../store/useTrustStore';
import {
  useTestimonyStore,
  nextAllowedAt,
  type TestimonyCategory,
  type TestimonyMoment,
} from '../../store/useTestimonyStore';
import { queryProvenance, type ProvenanceCitation } from '../brain/provenance';

/**
 * The voice (W13 TESTIMONY) — GIA watches the record and says at most one
 * receipt-backed sentence a day. She says nothing unless something qualifies.
 *
 * Deliberate design choice: the triggers are MECHANICAL, not generated.
 * Every rule reads a real record (the gate audit, the rollouts, CostTracker,
 * FileSnapshots), every line cites its evidence, and no LLM call sits in the
 * path — a watcher that spends tokens to decide whether to watch is neither
 * cheap nor trustworthy. Phrasing via the model is filed as a later
 * refinement; honesty ships first.
 *
 * Priority order = what most needs saying before you ask:
 *   1. gate     — you declined my tool calls; here's what they were
 *   2. failure  — this tool keeps failing; receipts
 *   3. cost     — spend spiked today; receipts
 *   4. revert   — a write of mine was undone; receipts
 */

/** Windows and thresholds. Modest on purpose: a chatty watcher is spam. */
const GATE_MIN_DENIALS = 2;
const FAILURE_MIN_RUNS = 3;
const FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const COST_SPIKE_FACTOR = 2;
const COST_SPIKE_FLOOR_USD = 0.05;
const REVERT_MIN = 1;

/** One rule's finding, before it becomes a moment. */
interface Finding {
  category: TestimonyCategory;
  line: string;
  receipts: string[];
}

function fmtDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtUSD(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

// ── Rule 1: gate denials ────────────────────────────────────────────────

function gateFinding(): Finding | null {
  const { audit } = useTrustStore.getState();
  const denials = audit.filter(
    (e) => e.choice === 'deny' || e.choice === 'blocked',
  );
  if (denials.length < GATE_MIN_DENIALS) return null;
  const receipts = denials
    .slice(0, 5)
    .map((e) => `${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} — ${e.headline} (you declined)`);
  return {
    category: 'gate',
    line: `Before you ask me anything — you declined ${denials.length} of my tool calls recently. Here's what they were. Want the receipts?`,
    receipts,
  };
}

// ── Rule 2: repeated tool failures from the record ──────────────────────

async function failureFinding(): Promise<Finding | null> {
  // One broad probe of the record: failed tool outputs in the window. The
  // search term is the ❌ marker the serializer keeps verbatim, so this reads
  // the record rather than any in-memory state.
  const res = await queryProvenance({ query: '❌', limit: 40 });
  if (res.citations.length === 0) return null;
  // Rollout lines carry no wall-clock timestamps for tool outputs; the file's
  // mtime ordering and the session meta bound recency, so we count per-tool
  // failures across the scanned window and note which session each came from.
  const perTool = new Map<string, { count: number; cites: ProvenanceCitation[] }>();
  for (const c of res.citations) {
    if (c.kind !== 'tool_output' || c.outcome !== 'failed') continue;
    const entry = perTool.get(c.tool ?? 'unknown') ?? { count: 0, cites: [] };
    entry.count++;
    if (entry.cites.length < 3) entry.cites.push(c);
    perTool.set(c.tool ?? 'unknown', entry);
  }
  const worst = [...perTool.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  if (!worst || worst[1].count < FAILURE_MIN_RUNS) return null;
  const [tool, info] = worst;
  return {
    category: 'failure',
    line: `Before you ask me anything — the ${tool} tool has failed ${info.count} times in my recent record. If it's about to matter, check the receipts first.`,
    receipts: info.cites.map((c) => `${c.sessionId} line ${c.line}${c.verified ? '' : ' (UNVERIFIED)'}: ${c.excerpt.split('\n')[0]}`),
  };
}

// ── Rule 3: spend spike ─────────────────────────────────────────────────

function costFinding(now: number): Finding | null {
  const summary = costTracker.getSummary(now - 8 * 24 * 60 * 60 * 1000);
  const today = fmtDay(now);
  const prior = summary.byDay.filter((d) => d.day !== today);
  if (prior.length < 3) return null; // not enough record to claim a spike
  const mean = prior.reduce((s, d) => s + d.cost, 0) / prior.length;
  const todayCost = summary.byDay.find((d) => d.day === today)?.cost ?? 0;
  if (mean <= 0 || todayCost < COST_SPIKE_FLOOR_USD || todayCost < mean * COST_SPIKE_FACTOR) return null;
  const topModel = summary.byModel[0];
  const receipts = [
    ...prior.slice(-5).map((d) => `${d.day}: ${fmtUSD(d.cost)} over ${d.calls} calls`),
    `today (${today}): ${fmtUSD(todayCost)} over ${summary.byDay.find((d) => d.day === today)?.calls ?? 0} calls`,
    topModel ? `top model today: ${topModel.provider}/${topModel.model} at ${fmtUSD(topModel.cost)}` : '',
  ].filter(Boolean);
  return {
    category: 'cost',
    line: `Before you ask me anything — today's API spend is ${fmtUSD(todayCost)}, about ${Math.round(todayCost / mean)}× the daily average. Want the receipts?`,
    receipts,
  };
}

// ── Rule 4: reverted writes ─────────────────────────────────────────────

function revertFinding(now: number): Finding | null {
  const cutoff = now - FAILURE_WINDOW_MS;
  const reverted = fileSnapshots.list().filter((s) => s.reverted && s.timestamp >= cutoff);
  if (reverted.length < REVERT_MIN) return null;
  return {
    category: 'revert',
    line: `Before you ask me anything — ${reverted.length} of my file ${reverted.length === 1 ? 'write was' : 'writes were'} undone recently. The record keeps what happened, not just what worked.`,
    receipts: reverted.slice(0, 5).map((s) => `${new Date(s.timestamp).toISOString().slice(0, 16).replace('T', ' ')} — ${s.path} (reverted)`),
  };
}

// ── The moment engine ───────────────────────────────────────────────────

/**
 * Find the moment worth speaking, if one exists — scanning REGARDLESS of the
 * budget. The budget gates the speaking (maybeSpeakTestimony), not the seeing:
 * a suppressed trigger must still land in the silence ledger, or the ledger
 * would lie about what she noticed. Cost honesty: when muted this still reads
 * the record once per mount (TTL-cached, ≤20 files) — that is the price of a
 * silence ledger that doesn't lie, and it is paid in reads, never writes.
 */
export async function findTestimonyMoment(now: number): Promise<TestimonyMoment | null> {
  const findings: (Finding | null)[] = [gateFinding(), await failureFinding(), costFinding(now), revertFinding(now)];
  const first = findings.find((f) => f !== null);
  if (!first) return null;
  return { id: genId(), category: first.category, line: first.line, receipts: first.receipts, at: now };
}

/**
 * The mount-time entry point: look for a moment, then decide its fate by the
 * budget — spoken (recorded + returned, so the UI renders the card) or silent
 * (filed in the silence ledger so "what did you almost say?" has an answer).
 */
export async function maybeSpeakTestimony(now = Date.now()): Promise<TestimonyMoment | null> {
  const moment = await findTestimonyMoment(now);
  if (!moment) return null;
  const store = useTestimonyStore.getState();
  if (now < nextAllowedAt(store.spokenLog, store.budgetHalved)) {
    store.recordSilent(moment, now);
    return null;
  }
  store.recordSpoken(moment, now);
  return moment;
}
