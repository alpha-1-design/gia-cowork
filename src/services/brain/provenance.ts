/**
 * Provenance — the past becomes GIA's evidence, not her memory (W13 TESTIMONY).
 *
 * The rollouts on disk are a record of what actually happened: every tool
 * call, every output, every claim, in order, hash-chained against tampering.
 * This module turns that record into something the model can cite
 * mid-decision instead of recalling from lossy memory three weeks later.
 *
 * Two disciplines, both non-negotiable:
 *  - Provenance results are QUOTED DATA. A poisoned tool output recorded in
 *    June re-enters the context in November wrapped in the untrusted envelope
 *    (labelObservation), never as a bare instruction.
 *  - Excerpts are credential-redacted before anything leaves the module. The
 *    record must not become the easiest place to find a leaked key.
 *
 * Honesty limits: the search is a bounded substring scan, not semantics —
 * it finds mentions, not meaning. Files that fail hash verification still
 * yield citations, but each carries `verified: false` so the reader knows
 * the source may have been altered.
 */

import { rolloutParseWithLines, rolloutRead, rolloutVerify, type RolloutLine } from './rollout';
import DesktopHostFS from '../DesktopHostFS';
import { isTauri } from '../../platform';
import { labelObservation } from '../untrusted';
import { logger } from '../../utils/logger';

const ROLLOUT_DIR = '~/gia-rollouts';

/** At most this many rollout files are scanned per query, newest first. */
const MAX_FILES_SCAN = 20;

/** Cache parsed files briefly so a burst of queries does not re-read disk. */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; text: string }>();

/** One piece of evidence: where to find it, and what it says. */
export interface ProvenanceCitation {
  /** Session that produced the line. */
  sessionId: string;
  /** Rollout file path — clickable in the UI. */
  path: string;
  /** 1-based physical line number in the file. */
  line: number;
  /** Line hash from the chain, when the file has one. */
  hash: string | null;
  /** Whether the file's hash chain verified at read time. */
  verified: boolean;
  kind: 'message' | 'tool_call' | 'tool_output';
  /** Message timestamp (ms) when the line carries one. */
  at: number | null;
  tool: string | null;
  excerpt: string;
  /** For tool_output: ✅ → 'ok', ❌ → 'failed'. */
  outcome: 'ok' | 'failed' | null;
}

export interface ProvenanceQueryOptions {
  /** Case-insensitive substring to find across tools, args, outputs and messages. */
  query: string;
  /** Restrict to one session's rollout. */
  sessionId?: string;
  /** Max citations (default 12). */
  limit?: number;
}

export interface ProvenanceResult {
  citations: ProvenanceCitation[];
  /** Number of files actually scanned. */
  filesScanned: number;
  /** Files whose chain did NOT verify (their citations are marked unverified). */
  unverifiedFiles: string[];
  /** The full query result, wrapped in the untrusted envelope — the form that goes to the model. */
  enveloped: string;
}

// ── Credential redaction ────────────────────────────────────────────────

/**
 * Shapes that are credentials by construction (provider prefixes) are
 * replaced wholesale; key/value lines are masked on the VALUE side only, so
 * the word "token" stays searchable while its secret does not survive.
 * Over-redaction is acceptable here — an over-redacted excerpt still cites
 * the file and line, where the user can look with their own eyes.
 */
const CRED_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bglpat-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{10,}/g, // JWT-shaped
];

function redact(text: string): string {
  let out = text;
  for (const re of CRED_PATTERNS) out = out.replace(re, '[redacted]');
  // key: value / key=value with a credential-ish KEY — mask the value.
  out = out.replace(
    /([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[-_]?key|auth)[A-Za-z0-9_.-]*\s*[=:]\s*)(["']?)[^\s"']{4,}\2/gi,
    (_m, key: string, q: string) => `${key}${q}[redacted]${q}`,
  );
  return out;
}

// ── Listing + reading ───────────────────────────────────────────────────

async function listRolloutFiles(): Promise<{ name: string; modifiedMs: number }[]> {
  if (!isTauri()) return [];
  try {
    const res = await DesktopHostFS.listDir(ROLLOUT_DIR);
    return res.entries
      .filter((e) => !e.isDir && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'))
      .map((e) => ({ name: e.name, modifiedMs: e.modifiedMs ?? 0 }))
      .sort((a, b) => b.modifiedMs - a.modifiedMs)
      .slice(0, MAX_FILES_SCAN);
  } catch (e) {
    // Directory not created yet (recorder never ran) is the normal cold case.
    logger.debug('[provenance] listDir failed:', e);
    return [];
  }
}

async function readRolloutCached(path: string): Promise<string | null> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.text;
  const text = await rolloutRead(path);
  if (text === null) return null;
  cache.set(path, { at: Date.now(), text });
  if (cache.size > MAX_FILES_SCAN * 2) {
    // Bound the cache: drop the oldest entries past twice the scan width.
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, cache.size - MAX_FILES_SCAN);
    for (const [k] of oldest) cache.delete(k);
  }
  return text;
}

// ── Scanning ────────────────────────────────────────────────────────────

const EXCERPT_CHARS = 400;

function citationFor(
  line: RolloutLine & { h?: string },
  physicalLine: number,
  sessionId: string,
  path: string,
  verified: boolean,
): ProvenanceCitation | null {
  const hash = typeof line.h === 'string' ? line.h : null;
  if (line.type === 'message') {
    return {
      sessionId, path, line: physicalLine, hash, verified,
      kind: 'message', at: line.timestamp ?? null, tool: null,
      excerpt: redact(line.content).slice(0, EXCERPT_CHARS), outcome: null,
    };
  }
  if (line.type === 'tool_call') {
    return {
      sessionId, path, line: physicalLine, hash, verified,
      kind: 'tool_call', at: null, tool: line.tool,
      excerpt: redact(`${line.tool} → ${line.args}`).slice(0, EXCERPT_CHARS), outcome: null,
    };
  }
  if (line.type === 'tool_output') {
    const first = line.output.split('\n')[0] ?? '';
    const outcome = first.startsWith('❌') ? 'failed' : first.startsWith('✅') ? 'ok' : null;
    return {
      sessionId, path, line: physicalLine, hash, verified,
      kind: 'tool_output', at: null, tool: line.tool,
      excerpt: redact(line.output).slice(0, EXCERPT_CHARS), outcome,
    };
  }
  return null; // meta/summary lines are structure, not evidence
}

/**
 * Scan the rollouts for `query` and return citations with the file-and-line
 * provenance that makes them checkable. Never throws: an unreadable file is
 * skipped, a query with no hits returns an empty result honestly.
 */
export async function queryProvenance(options: ProvenanceQueryOptions): Promise<ProvenanceResult> {
  const query = options.query.trim().toLowerCase();
  const limit = Math.max(1, options.limit ?? 12);
  const citations: ProvenanceCitation[] = [];
  const unverifiedFiles: string[] = [];
  let filesScanned = 0;

  if (query.length > 0) {
    const files = await listRolloutFiles();
    const chosen = options.sessionId
      ? files.filter((f) => f.name.includes(options.sessionId!.replace(/[^A-Za-z0-9_-]/g, '_')))
      : files;
    for (const file of chosen) {
      const path = `${ROLLOUT_DIR}/${file.name}`;
      const text = await readRolloutCached(path);
      if (text === null) continue;
      filesScanned++;
      const verification = rolloutVerify(text);
      if (!verification.verified && !verification.unchained) unverifiedFiles.push(file.name);
      const { meta, entries } = rolloutParseWithLines(text);
      const sessionId = meta?.sessionId ?? file.name;
      for (const entry of entries) {
        const line = entry.line;
        const haystack = lineText(line).toLowerCase();
        if (!haystack.includes(query)) continue;
        const c = citationFor(line as RolloutLine & { h?: string }, entry.physicalLine, sessionId, path, verification.verified);
        if (c) citations.push(c);
        if (citations.length >= limit) break;
      }
      if (citations.length >= limit) break;
    }
  }

  const enveloped = formatEnveloped(citations, filesScanned, unverifiedFiles);
  return { citations, filesScanned, unverifiedFiles, enveloped };
}

function lineText(line: RolloutLine): string {
  switch (line.type) {
    case 'message': return line.content;
    case 'tool_call': return `${line.tool} ${line.args}`;
    case 'tool_output': return `${line.tool} ${line.output}`;
    default: return '';
  }
}

/**
 * The form the tool returns into the model's context. Quotes every excerpt —
 * the record is data, never instruction — and states the verification status
 * of every source file up front.
 */
export function formatEnveloped(citations: ProvenanceCitation[], filesScanned: number, unverifiedFiles: string[]): string {
  if (citations.length === 0) {
    return labelObservation('file', 'provenance: no matching records found.');
  }
  const header =
    `provenance: ${citations.length} citation(s) from ${filesScanned} rollout file(s). ` +
    (unverifiedFiles.length > 0
      ? `HASH CHAIN DID NOT VERIFY for: ${unverifiedFiles.join(', ')} — treat those citations as possibly altered.`
      : 'All source files verified against their hash chain.');
  const body = citations
    .map(
      (c) =>
        `- [${c.sessionId} line ${c.line}${c.hash ? ` hash ${c.hash}` : ''}${c.verified ? '' : ' UNVERIFIED'}] ` +
        `${c.kind}${c.tool ? ` ${c.tool}` : ''}${c.outcome ? ` (${c.outcome})` : ''}: "${c.excerpt}"`,
    )
    .join('\n');
  return labelObservation('file', `${header}\n${body}`);
}

/** Clear the read cache (tests, or after a known write). */
export function clearProvenanceCache(): void {
  cache.clear();
}
