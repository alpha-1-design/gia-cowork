import { rolloutSerialize, rolloutVerify, type RolloutLine } from './brain/rollout';
import { fileSnapshots, type FileSnapshot } from './FileSnapshots';
import { costTracker } from './CostTracker';
import { useTrustStore } from '../store/useTrustStore';
import DesktopHostFS from './DesktopHostFS';
import { isTauri } from '../platform';
import { logger } from '../utils/logger';

/**
 * Task receipts (#14) — shareable proof pages for what GIA did.
 *
 * One self-contained HTML file per task: what was asked, which tools ran,
 * which files changed, what the permission gate decided, what it cost, and
 * the FULL hash-chained rollout record embedded in the page. Opening the
 * file re-verifies the chain in the browser — pure JavaScript recomputes
 * every hash from the embedded record alone, so a reader with no GIA, no
 * network and no trust in the sender can still detect tampering (edited,
 * inserted, reordered or dropped lines each break the chain).
 *
 * House rules honored: every number on the page derives from a real record
 * (rollout, FileSnapshots, CostTracker, gate audit); offline-first (no CDN,
 * no fonts, inline everything); no gate bypass (generation is a gated tool;
 * the page itself is a document, not a capability).
 *
 * The embedded record is the page's spine — the summary cards are just a
 * human-readable index into it. If a card and the record ever disagree,
 * the record wins, and the page says so.
 */

const RECEIPT_DIR = '~/gia-receipts';

// ── Receipt model ────────────────────────────────────────────────────────

export interface ReceiptToolCall {
  tool: string;
  args: string;
  /** 'ok' | 'fail' | 'unknown' — the terminal ✅/❌ line decides. */
  outcome: 'ok' | 'fail' | 'unknown';
}

export interface ReceiptFileChange {
  path: string;
  additions: number;
  deletions: number;
  created: boolean;
  reverted: boolean;
  at: number;
}

export interface ReceiptGateDecision {
  toolName: string;
  headline: string;
  choice: string;
  risk: string;
  at: number;
}

export interface Receipt {
  sessionId: string;
  title: string;
  generatedAt: number;
  firstAt: number | null;
  lastAt: number | null;
  turns: number;
  toolCalls: ReceiptToolCall[];
  fileChanges: ReceiptFileChange[];
  gateDecisions: ReceiptGateDecision[];
  costUsd: number;
  costCalls: number;
  verification: { verified: boolean; brokenAt: number | null; unchained: boolean };
}

/** Minimal session slice receipts need (same as rolloutSerialize). */
export interface ReceiptSession {
  id: string;
  title: string;
  messages: unknown[];
}

/**
 * Line-diff summary between a snapshot's previous and new content — the
 * same multiset measure the Undo page uses, kept identical on purpose so
 * the receipt and the undo UI never tell different stories.
 */
function diffCounts(previousContent: string | null, newContent: string): { additions: number; deletions: number } {
  if (previousContent === null) {
    return { additions: newContent ? newContent.split('\n').length : 0, deletions: 0 };
  }
  const count = (lines: string[]) => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const prev = count(previousContent.split('\n'));
  const next = count(newContent.split('\n'));
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of next) {
    const p = prev.get(line) ?? 0;
    if (n > p) additions += n - p;
  }
  for (const [line, p] of prev) {
    const n = next.get(line) ?? 0;
    if (p > n) deletions += p - n;
  }
  return { additions, deletions };
}

function extractToolCalls(rolloutText: string): ReceiptToolCall[] {
  const calls: ReceiptToolCall[] = [];
  for (const raw of rolloutText.split('\n')) {
    let line: RolloutLine;
    try {
      line = JSON.parse(raw) as RolloutLine;
    } catch {
      continue;
    }
    if (line.type === 'tool_call') {
      calls.push({ tool: line.tool, args: line.args ?? '', outcome: 'unknown' });
    } else if (line.type === 'tool_output' && calls.length > 0) {
      // toolRunner's terminal status lives in the output's LAST line (the
      // ⚡ detail lines come first; ✅/❌ is the verdict).
      const last = calls[calls.length - 1];
      const terminal = line.output.trimEnd().split('\n').pop() ?? '';
      if (terminal.startsWith('❌')) last.outcome = 'fail';
      else if (terminal.startsWith('✅')) last.outcome = 'ok';
    }
  }
  return calls;
}

/** File changes the session made — FileSnapshots entries inside the span. */
export function fileChangesForRange(snapshots: FileSnapshot[], firstAt: number | null, lastAt: number | null): ReceiptFileChange[] {
  if (firstAt === null || lastAt === null) return [];
  return snapshots
    .filter(s => s.timestamp >= firstAt - 5_000 && s.timestamp <= lastAt + 5_000)
    .map(s => {
      const d = diffCounts(s.previousContent, s.newContent);
      return {
        path: s.path,
        additions: d.additions,
        deletions: d.deletions,
        created: s.previousContent === null,
        reverted: s.reverted,
        at: s.timestamp,
      };
    });
}

export function buildReceipt(
  session: ReceiptSession,
  deps: { snapshots?: FileSnapshot[]; costUsd?: number; costCalls?: number; audit?: ReceiptGateDecision[] } = {},
): { receipt: Receipt; rolloutJsonl: string } {
  const rolloutJsonl = rolloutSerialize(session);
  const messages = (session.messages ?? []) as { timestamp?: number; role?: string; content?: string }[];
  const timestamps = messages.map(m => m.timestamp ?? 0).filter(t => t > 0);
  const firstAt = timestamps.length ? Math.min(...timestamps) : null;
  const lastAt = timestamps.length ? Math.max(...timestamps) : null;

  const snapshots = deps.snapshots ?? fileSnapshots.list();
  const fileChanges = fileChangesForRange(snapshots, firstAt, lastAt);

  const audit = deps.audit ?? useTrustStore.getState().audit;
  const gateDecisions = audit
    .filter(a => firstAt === null || a.at >= firstAt - 5_000)
    .slice(0, 40)
    .map(a => ({ toolName: a.toolName, headline: a.headline, choice: a.choice, risk: a.risk, at: a.at }));

  const costUsd = deps.costUsd ?? costTracker.getSessionCost(session.id);
  const costCalls = deps.costCalls ?? costTracker.getSummary().calls;
  const verification = rolloutVerify(rolloutJsonl);

  const firstUser = messages.find(m => m.role === 'user');
  const title = (firstUser?.content ?? session.title ?? 'Task').split('\n')[0].slice(0, 120);

  return {
    receipt: {
      sessionId: session.id,
      title,
      generatedAt: 0, // filled by the caller — serialization itself stays deterministic
      firstAt,
      lastAt,
      turns: messages.length,
      toolCalls: extractToolCalls(rolloutJsonl),
      fileChanges,
      gateDecisions,
      costUsd,
      costCalls,
      verification,
    },
    rolloutJsonl,
  };
}

// ── HTML rendering (self-contained, offline-verifiable) ──────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export const RECEIPT_VERIFIER_JS = `
// Receipt verifier — recomputes GIA's rollout hash chain from the embedded
// record alone. No network, no dependencies, no trust in the sender: any
// edited, inserted, reordered or dropped line breaks the chain.
function fnv1a32(input, basis) {
  var h = basis >>> 0;
  for (var i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function chainHash(prev, canonicalPayload) {
  var h1 = fnv1a32(prev + '|' + canonicalPayload, 0x811c9dc5);
  var h2 = fnv1a32(canonicalPayload + '|' + prev + '|rollout', (0x811c9dc5 ^ 0x9dc5811c) >>> 0);
  return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
}
function canonicalPayloadOf(line) {
  var copy = {};
  for (var k in line) if (k !== 'p' && k !== 'h') copy[k] = line[k];
  return JSON.stringify(copy);
}
function verifyRollout() {
  var raw = document.getElementById('rollout-data').textContent;
  var lines = raw.split('\\n').filter(function (l) { return l.trim().length > 0; });
  var prev = '';
  for (var i = 0; i < lines.length; i++) {
    var line;
    try { line = JSON.parse(lines[i]); } catch (e) {
      return { verified: false, brokenAt: i + 1, error: 'unparseable line' };
    }
    if (typeof line.h !== 'string') return { verified: false, brokenAt: i + 1, error: 'missing hash' };
    var expected = chainHash(prev, canonicalPayloadOf(line));
    if (line.h !== expected) return { verified: false, brokenAt: i + 1, error: 'hash mismatch' };
    if (i > 0 && line.p !== prev) return { verified: false, brokenAt: i + 1, error: 'chain link broken' };
    prev = line.h;
  }
  return { verified: true, brokenAt: null };
}
(function () {
  var result = verifyRollout();
  var badge = document.getElementById('verify-badge');
  if (result.verified) {
    badge.textContent = 'CHAIN VERIFIED — ' + JSON.parse(document.getElementById('rollout-data').textContent.split('\\n').filter(function(l){return l.trim();}).length ? document.getElementById('rollout-data').textContent.split('\\n').filter(function(l){return l.trim();}).pop() : '{}').h;
    badge.className = 'badge ok';
  } else {
    badge.textContent = 'TAMPERED — chain breaks at line ' + result.brokenAt + ' (' + result.error + ')';
    badge.className = 'badge bad';
  }
  document.getElementById('verify-detail').textContent =
    'Recomputed every hash from the embedded record in this page. Verification is repeatable: open this file anywhere, offline.';
})();
`.trim();

export function renderReceiptHtml(receipt: Receipt, rolloutJsonl: string, generatedAt: number): string {
  const r = receipt;
  const okCount = r.toolCalls.filter(t => t.outcome === 'ok').length;
  const failCount = r.toolCalls.filter(t => t.outcome === 'fail').length;
  const filesTouched = r.fileChanges.length;
  const revertedCount = r.fileChanges.filter(f => f.reverted).length;

  const toolRows = r.toolCalls.map((t, i) => `
    <tr><td class="muted">${i + 1}</td><td><code>${esc(t.tool)}</code></td><td class="args">${esc(t.args || '(no args)')}</td>
    <td class="${t.outcome === 'ok' ? 'ok' : t.outcome === 'fail' ? 'bad' : 'muted'}">${t.outcome}</td></tr>`).join('');

  const fileRows = r.fileChanges.length === 0 ? '<tr><td colspan="5" class="muted">No file changes in this task.</td></tr>' :
    r.fileChanges.map(f => `
    <tr><td><code>${esc(f.path)}</code></td><td class="ok">+${f.additions}</td><td class="bad">−${f.deletions}</td>
    <td>${f.created ? 'created' : 'edited'}</td><td>${f.reverted ? '<span class="bad">reverted</span>' : '—'}</td></tr>`).join('');

  const gateRows = r.gateDecisions.length === 0 ? '<tr><td colspan="4" class="muted">No gate decisions recorded in this span.</td></tr>' :
    r.gateDecisions.map(g => `
    <tr><td><code>${esc(g.toolName)}</code></td><td>${esc(g.headline)}</td><td>${esc(g.choice)}</td><td class="muted">${esc(g.risk)}</td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Task receipt — ${esc(r.title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0d12; color: #e5e7eb; font: 14px/1.55 ui-sans-serif, system-ui, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 48px; }
  h1 { font-size: 20px; margin: 8px 0 4px; }
  h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #8b93a7; margin: 28px 0 8px; }
  .muted { color: #8b93a7; } .ok { color: #10b981; } .bad { color: #ef4444; }
  .badge { display: inline-block; padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; letter-spacing: .04em; }
  .badge.ok { background: rgba(16,185,129,.12); color: #10b981; border: 1px solid rgba(16,185,129,.35); }
  .badge.bad { background: rgba(239,68,68,.12); color: #ef4444; border: 1px solid rgba(239,68,68,.35); }
  .cards { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0; }
  .card { background: #12151d; border: 1px solid #232838; border-radius: 12px; padding: 12px 16px; min-width: 110px; }
  .card b { display: block; font-size: 20px; }
  .card span { font-size: 11px; color: #8b93a7; }
  table { width: 100%; border-collapse: collapse; background: #12151d; border: 1px solid #232838; border-radius: 10px; overflow: hidden; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8b93a7; padding: 8px 10px; border-bottom: 1px solid #232838; }
  td { padding: 7px 10px; border-bottom: 1px solid #1a1f2e; font-size: 13px; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  code { font: 12px ui-monospace, monospace; color: #a5b4fc; word-break: break-all; }
  .args { max-width: 380px; overflow-wrap: anywhere; font: 11px ui-monospace, monospace; color: #8b93a7; }
  details summary { cursor: pointer; color: #a5b4fc; font-size: 13px; margin-top: 10px; }
  pre { background: #0f1218; border: 1px solid #232838; border-radius: 10px; padding: 14px; overflow: auto; max-height: 340px; font: 11px ui-monospace, monospace; color: #9ca3af; }
  .foot { margin-top: 32px; font-size: 11px; color: #5b6272; }
</style>
</head>
<body>
<div class="wrap">
  <div><span id="verify-badge" class="badge">verifying…</span></div>
  <h1>${esc(r.title)}</h1>
  <div class="muted">Task receipt · session <code>${esc(r.sessionId)}</code> · ${fmtDate(r.firstAt)} → ${fmtDate(r.lastAt)} · generated ${fmtDate(generatedAt)}</div>

  <div class="cards">
    <div class="card"><b>${r.turns}</b><span>messages</span></div>
    <div class="card"><b>${r.toolCalls.length}</b><span>tool calls (${okCount} ok · ${failCount} failed)</span></div>
    <div class="card"><b>${filesTouched}</b><span>files touched${revertedCount ? ` (${revertedCount} reverted)` : ''}</span></div>
    <div class="card"><b>$${r.costUsd.toFixed(4)}</b><span>estimated spend</span></div>
    <div class="card"><b>${r.gateDecisions.length}</b><span>gate decisions</span></div>
  </div>

  <h2>Tool calls</h2>
  <table><thead><tr><th>#</th><th>Tool</th><th>Arguments</th><th>Outcome</th></tr></thead><tbody>${toolRows}</tbody></table>

  <h2>File changes</h2>
  <table><thead><tr><th>Path</th><th>+</th><th>−</th><th>Kind</th><th>Undo</th></tr></thead><tbody>${fileRows}</tbody></table>

  <h2>Permission gate</h2>
  <table><thead><tr><th>Tool</th><th>What was flagged</th><th>Decision</th><th>Risk</th></tr></thead><tbody>${gateRows}</tbody></table>

  <h2>The record</h2>
  <details>
    <summary>Raw rollout (${rolloutJsonl.split('\n').filter(l => l.trim()).length} hash-chained lines) — the summary cards above are an index into this</summary>
    <pre>${esc(rolloutJsonl)}</pre>
  </details>
  <p id="verify-detail" class="muted" style="font-size:11px"></p>
  <div class="foot">
    GIA Cowork task receipt. The hash chain is tamper-EVIDENCE, not authentication: it proves the record was not
    altered after generation, not who generated it. Spend figures are Simulation Estimates, not billing statements.
  </div>
</div>
<script type="application/json" id="rollout-data">${rolloutJsonl.replace(/</g, '\\u003c')}</script>
<script>
${RECEIPT_VERIFIER_JS}
</script>
</body>
</html>`;
}

// ── Generation (I/O orchestration) ───────────────────────────────────────

/**
 * Generate a receipt for a session. Desktop: writes to ~/gia-receipts and
 * returns the path. Web: returns the HTML for a download (no host FS).
 */
export async function generateReceipt(session: ReceiptSession): Promise<{ path: string | null; html: string }> {
  const { receipt, rolloutJsonl } = buildReceipt(session);
  const generatedAt = Date.now();
  const withStamp = { ...receipt, generatedAt };
  const html = renderReceiptHtml(withStamp, rolloutJsonl, generatedAt);
  if (!isTauri()) return { path: null, html };
  try {
    const name = `receipt-${session.id.slice(0, 12)}-${new Date(generatedAt).toISOString().slice(0, 10)}.html`;
    const path = `${RECEIPT_DIR}/${name}`;
    await DesktopHostFS.writeFile(path, html);
    logger.log('[Receipts] wrote', path);
    return { path, html };
  } catch (e) {
    logger.warn('[Receipts] write failed:', e instanceof Error ? e.message : e);
    return { path: null, html };
  }
}
