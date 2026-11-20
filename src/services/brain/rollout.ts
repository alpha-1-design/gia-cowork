/**
 * Rollout-style session persistence — a JSONL session transcript.
 *
 * Mirrors the CONCEPT of Codex's rollout recorder (codex-rs/rollout): one
 * JSON object per line, first line is session metadata, subsequent lines are
 * the ordered history (messages, tool calls, tool outputs), optionally closed
 * by a summary line. The file is append-friendly and line-tolerant by
 * construction: a crash mid-write only damages the LAST line, so a reader
 * that drops an invalid final line and skips invalid middle lines can always
 * recover every earlier turn. That property — not byte-level compatibility
 * with Codex's Rust format — is what we adopt (R1 #4).
 *
 * Where the data comes from: GIA messages already carry an ordered
 * `segments` array (src/utils/streamParser.ts) in which tool activity is
 * stored as `type: 'tool'` segments whose content is the toolRunner.ts
 * emoji-prefixed lifecycle log ("🧠 tool → args", "⚡ Executing: …",
 * "✅/❌ …"). We recover discrete tool_call / tool_output lines from those
 * fields where present, instead of changing toolRunner's flow. Plain
 * `thoughts`-only messages (no segments) still serialize as one message line.
 *
 * Serialization is pure and deterministic: no Date.now(), no store access,
 * no randomness — same session in, same JSONL out. I/O goes through
 * DesktopHostFS (Tauri host filesystem); on web the write/read are null
 * no-ops, matching the platform pattern other services use.
 */

import { APP_VERSION } from '../../config/appVersion';
import DesktopHostFS from '../DesktopHostFS';

/** Format marker in the meta line. Bump when the line union changes shape. */
const ROLLOUT_FORMAT = 'gia-rollout-2' as const;

/** Directory rollouts are written to, under the workspace root (home by default). */
const ROLLOUT_DIR = '~/gia-rollouts';

/**
 * Long fields (message bodies, args, outputs) are clipped so one giant tool
 * output cannot dominate the file or a reader's memory. The marker records
 * what was lost so replay knows the text is incomplete, not short.
 */
const MAX_FIELD_CHARS = 8192;

/**
 * Hash-chain fields (gia-rollout-2). Every serialized line carries `p` — the
 * previous line's hash — and `h` — its own hash over `p` plus the canonical
 * payload (the same object WITHOUT the hash fields, so verification can
 * recompute it). The meta line is the chain genesis: `p` is the empty string.
 *
 * What this buys: tamper-EVIDENCE, not authentication. A reader can detect
 * that a line was inserted, edited, reordered or dropped (each breaks the
 * chain at that point), which is the difference between a record and a
 * recollection. It cannot stop a determined editor who recomputes the whole
 * chain — a chain without a stored secret is exactly as strong as its
 * recompute, and we say so rather than implying more.
 */
interface HashFields {
  /** Hash of the previous line; '' on the first (meta) line. */
  p?: string;
  /** Hash of this line: chainHash(p, canonical payload without p/h). */
  h?: string;
}

/** One JSON object per line, discriminated by `type`. */
export type RolloutLine =
  | {
      type: 'meta';
      format: typeof ROLLOUT_FORMAT;
      sessionId: string;
      appVersion: string;
      /** ISO timestamp of the first message, or null for an empty session. */
      createdAt: string | null;
    }
  | {
      type: 'message';
      id: string;
      role: string;
      content: string;
      timestamp?: number;
    }
  | {
      type: 'tool_call';
      id: string;
      tool: string;
      args: string;
    }
  | {
      type: 'tool_output';
      id: string;
      tool: string;
      output: string;
    }
  | {
      type: 'summary';
      counts: {
        messages: number;
        toolCalls: number;
        toolOutputs: number;
      };
    };

/** The meta line is always the first line of a well-formed rollout. */
export type RolloutMeta = Extract<RolloutLine, { type: 'meta' }>;

// ── Hash chain ──────────────────────────────────────────────────────────
//
// FNV-1a 32-bit is tiny, deterministic and dependency-free; two independent
// passes (different mixing order and one salt) give a 64-bit equivalent so
// two distinct edits landing on the same h1 do not silently cancel. This is
// an integrity chain for a local record — right tool for the job, and the
// comment above says exactly what it is not.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a32(input: string, basis: number): number {
  let h = basis >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** 16-hex-char digest over the previous hash and the canonical payload. */
export function chainHash(prev: string, canonicalPayload: string): string {
  const h1 = fnv1a32(`${prev}|${canonicalPayload}`, FNV_OFFSET);
  const h2 = fnv1a32(`${canonicalPayload}|${prev}|rollout`, FNV_OFFSET ^ 0x9dc5811c);
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** The line's own payload without the hash fields — what the chain hashes. */
function canonicalPayloadOf(line: Record<string, unknown>): string {
  const { p: _p, h: _h, ...payload } = line;
  return JSON.stringify(payload);
}

/**
 * Verify a rollout's hash chain against the file as written, operating on
 * the RAW lines — a line that parse would skip still belongs to the chain,
 * so verification runs before (not after) tolerance drops anything.
 *
 * `unchained` is not a failure: gia-rollout-1 files carry no hashes, and a
 * chain cannot be checked where none was written. `brokenAt` is the 1-based
 * physical line number where the chain first fails (a wrong `p` means a
 * line was inserted/reordered; a wrong `h` means it was edited).
 */
export interface RolloutVerification {
  verified: boolean;
  brokenAt: number | null;
  unchained: boolean;
}

export function rolloutVerify(text: string): RolloutVerification {
  const rawLines = text.split('\n').filter((l) => l.trim().length > 0);
  let prev: string | null = null;
  let sawHash = false;
  for (let i = 0; i < rawLines.length; i++) {
    let line: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawLines[i]);
      if (typeof parsed !== 'object' || parsed === null) return { verified: false, brokenAt: i + 1, unchained: false };
      line = parsed as Record<string, unknown>;
    } catch {
      // A torn line is already accounted for as a truncated tail by parse;
      // for the chain it is simply a break at that point.
      return { verified: false, brokenAt: i + 1, unchained: false };
    }
    if (typeof line.h !== 'string') {
      // No hash on any line so far → an older, un-chained file.
      if (!sawHash) continue;
      // Mixed: a hashed prefix followed by an unhashed line is a break.
      return { verified: false, brokenAt: i + 1, unchained: false };
    }
    sawHash = true;
    if (i === 0) {
      if (typeof line.type !== 'string' || line.type !== 'meta') {
        return { verified: false, brokenAt: 1, unchained: false };
      }
      prev = '';
    }
    const expected = chainHash(prev ?? '', canonicalPayloadOf(line));
    if (line.h !== expected) return { verified: false, brokenAt: i + 1, unchained: false };
    if (i > 0 && line.p !== prev) return { verified: false, brokenAt: i + 1, unchained: false };
    prev = line.h as string;
  }
  if (!sawHash) return { verified: false, brokenAt: null, unchained: true };
  return { verified: true, brokenAt: null, unchained: false };
}

/** Tolerant parse result. Never throws on file content. */
export interface RolloutParseResult {
  meta: RolloutMeta | null;
  /** Valid history lines (message / tool_call / tool_output / summary) in order. */
  messages: RolloutLine[];
  stats: {
    /** Total non-empty lines scanned (including dropped ones). */
    lines: number;
    /** Invalid lines that were NOT last — skipped and counted. */
    skipped: number;
    /** True when the last non-empty line was invalid and dropped as a partial write. */
    truncatedLastLine: boolean;
  };
}

/** Clip a long field, preserving the fact that content was dropped. */
function clip(text: string, limit = MAX_FIELD_CHARS): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}…[clipped: ${omitted} more chars]`;
}

/**
 * Recover the tool invocation (name + args) from a tool segment's content.
 * toolRunner's start line is "🧠 <tool> → <args…>"; when the arrow convention
 * is missing (older messages) we fall back to the whole first line as args
 * and the segment's toolName field for the tool.
 */
function extractToolCall(segment: {
  id: string;
  content: string;
  toolName?: string;
}): Extract<RolloutLine, { type: 'tool_call' }> | null {
  const lines = segment.content.split('\n');
  const first = lines[0] ?? '';
  const startMatch = first.match(/^🧠\s+(.+?)\s+→\s*([\s\S]*)$/);
  const tool = startMatch ? startMatch[1] : segment.toolName;
  if (!tool) return null;
  const args = startMatch ? startMatch[2] : first;
  return { type: 'tool_call', id: segment.id, tool, args: clip(args) };
}

/**
 * Recover the tool output (execution details + terminal status line) from a
 * tool segment. Only lines that carry output — the ⚡ detail lines and the
 * ✅/❌ terminal line — are kept; the 🧠 start line is the call, not the
 * result. A segment still 'running' has no output line yet, and we emit none.
 */
function extractToolOutput(segment: {
  id: string;
  content: string;
  toolName?: string;
  toolStatus?: string;
}): Extract<RolloutLine, { type: 'tool_output' }> | null {
  if (segment.toolStatus === 'running') return null;
  const outLines = segment.content
    .split('\n')
    .filter((l) => /^(⚡|✅|❌)/.test(l));
  if (outLines.length === 0) return null;
  const tool = segment.toolName ?? segment.content.split('\n')[0]?.match(/^🧠\s+(.+?)\s+→/)?.[1];
  if (!tool) return null;
  return { type: 'tool_output', id: segment.id, tool, output: clip(outLines.join('\n')) };
}

/** The minimal message shape the serializer consumes. */
type MessageLike = { id: string; role: string; content: string; timestamp?: number; segments?: unknown[] };

/** Structural check — does this unknown entry look like a stored Message? */
function looksLikeMessage(m: unknown): m is MessageLike {
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof (m as { id?: unknown }).id === 'string' &&
    typeof (m as { role?: unknown }).role === 'string' &&
    typeof (m as { content?: unknown }).content === 'string'
  );
}

/** Depth-first walk over the session's message tree (MessageNode has children). */
function* walkMessages(entries: unknown[]): Generator<MessageLike> {
  for (const entry of entries) {
    // MessageNode: { message, children } — walk the node, then its branches.
    const node = entry as { message?: unknown; children?: unknown[] };
    if (typeof node === 'object' && node !== null && looksLikeMessage(node.message)) {
      yield node.message as MessageLike;
      if (Array.isArray(node.children)) {
        yield* walkMessages(node.children);
      }
    } else if (looksLikeMessage(entry)) {
      // Flat stored Message.
      yield entry as MessageLike;
    }
    // Anything else is not message-shaped; silently skipped — serialize is
    // for well-formed store data, parse is the tolerant side.
  }
}

/**
 * Serialize a session to JSONL. Pure: no I/O, no clock, deterministic.
 * Accepts flat `Message[]` or the store's `MessageNode[]` tree — both are
 * just "an array of message-ish things" as far as this function cares.
 */
export function rolloutSerialize(session: { id: string; messages: unknown[] }): string {
  const lines: RolloutLine[] = [];
  let firstTimestamp: number | undefined;
  let messageCount = 0;
  let toolCallCount = 0;
  let toolOutputCount = 0;

  for (const msg of walkMessages(session.messages)) {
    if (firstTimestamp === undefined) firstTimestamp = msg.timestamp;
    messageCount++;
    lines.push({
      type: 'message',
      id: msg.id,
      role: msg.role,
      content: clip(msg.content),
      ...(msg.timestamp !== undefined ? { timestamp: msg.timestamp } : {}),
    });
    for (const segment of Array.isArray(msg.segments) ? msg.segments : []) {
      const seg = segment as { id?: unknown; content?: unknown; toolName?: unknown; toolStatus?: unknown };
      if (
        typeof seg !== 'object' ||
        seg === null ||
        typeof seg.id !== 'string' ||
        typeof seg.content !== 'string'
      ) {
        continue;
      }
      // Only tool segments become discrete rollout lines; thinking/text
      // segments are already represented by their parent message content.
      if ((seg as { type?: unknown }).type !== 'tool') continue;
      const toolSeg = {
        id: seg.id,
        content: seg.content,
        toolName: typeof seg.toolName === 'string' ? seg.toolName : undefined,
        toolStatus: typeof seg.toolStatus === 'string' ? seg.toolStatus : undefined,
      };
      const call = extractToolCall(toolSeg);
      if (call) {
        toolCallCount++;
        lines.push(call);
      }
      const output = extractToolOutput(toolSeg);
      if (output) {
        toolOutputCount++;
        lines.push(output);
      }
    }
  }

  const meta: RolloutMeta = {
    type: 'meta',
    format: ROLLOUT_FORMAT,
    sessionId: session.id,
    appVersion: APP_VERSION,
    createdAt: firstTimestamp !== undefined ? new Date(firstTimestamp).toISOString() : null,
  };
  lines.push({ type: 'summary', counts: { messages: messageCount, toolCalls: toolCallCount, toolOutputs: toolOutputCount } });

  // Chain the payloads in file order: meta first, then history, then summary.
  // Each line's `h` covers `p` plus the payload without the hash fields, so a
  // reader can recompute the whole chain from the file alone.
  const ordered: Record<string, unknown>[] = [meta as unknown as Record<string, unknown>, ...lines];
  const out: string[] = [];
  let prev = '';
  for (const payload of ordered) {
    const h = chainHash(prev, canonicalPayloadOf(payload));
    out.push(JSON.stringify({ ...payload, p: prev, h }));
    prev = h;
  }
  return out.join('\n');
}

/** Minimal shape validation for one parsed line. */
function isRolloutLine(value: unknown): value is RolloutLine {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { type?: unknown };
  switch (v.type) {
    case 'meta':
    case 'message':
    case 'tool_call':
    case 'tool_output':
    case 'summary':
      // Tolerant by design: we only discriminate on `type`, so a line of an
      // older format missing optional fields still parses.
      return true;
    default:
      return false;
  }
}

/**
 * Parse a rollout file tolerantly. Invalid lines in the middle are skipped
 * and counted; an invalid LAST line is treated as a partial write (the
 * crash-damaged tail) and dropped separately. Never throws on content.
 */
export function rolloutParse(text: string): RolloutParseResult {
  const rawLines = text.split('\n').filter((l) => l.trim().length > 0);
  const stats = { lines: rawLines.length, skipped: 0, truncatedLastLine: false };
  const messages: RolloutLine[] = [];
  let meta: RolloutMeta | null = null;

  rawLines.forEach((raw, i) => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      if (i === rawLines.length - 1) stats.truncatedLastLine = true;
      else stats.skipped++;
      return;
    }
    if (!isRolloutLine(value)) {
      // Valid JSON but not a rollout line: same split as above — the last
      // line may be a half-written object whose JSON still happens to parse
      // only in exotic cases; treat non-last garbage as skippable noise.
      if (i === rawLines.length - 1) stats.truncatedLastLine = true;
      else stats.skipped++;
      return;
    }
    if (value.type === 'meta') {
      if (meta === null) meta = value as RolloutMeta;
      return; // Only the first meta line counts; later ones are duplicates.
    }
    messages.push(value);
  });

  return { meta, messages, stats };
}

/** One parsed history line plus the physical line number it came from. */
export interface RolloutEntry {
  line: RolloutLine;
  /** 1-based physical line number in the file text. */
  physicalLine: number;
}

/**
 * Parse with physical provenance: same tolerance as `rolloutParse`, but each
 * surviving history line carries its 1-based physical line number so a
 * citation can point at the exact line in the file (skipped lines do NOT
 * shift the numbering — physical means physical).
 */
export function rolloutParseWithLines(text: string): { meta: RolloutMeta | null; entries: RolloutEntry[] } {
  const rawLines = text.split('\n');
  const entries: RolloutEntry[] = [];
  let meta: RolloutMeta | null = null;
  rawLines.forEach((raw, i) => {
    if (!raw.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRolloutLine(value)) return;
    if (value.type === 'meta') {
      if (meta === null) meta = value as RolloutMeta;
      return;
    }
    entries.push({ line: value, physicalLine: i + 1 });
  });
  return { meta, entries };
}

/** Sanitize a session id into a safe filename component. */
function safeSessionId(sessionId: string): string {
  // No dots: a session id like "../../evil" must not contribute traversal
  // or extension tricks to the filename (the `rollout-` prefix already
  // blocks traversal, but defense in depth is one character away).
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'session';
}

/** Canonical path for a session's rollout file (Tauri expands `~`). */
export function rolloutPathFor(sessionId: string): string {
  return `${ROLLOUT_DIR}/rollout-${safeSessionId(sessionId)}.jsonl`;
}

/**
 * Write a rollout to the host filesystem. Non-Tauri (web): null no-op,
 * matching how other services degrade outside the desktop shell.
 */
export async function rolloutWrite(sessionId: string, text: string): Promise<string | null> {
  try {
    const { isTauri } = await import('../../platform');
    if (!isTauri()) return null;
    const path = rolloutPathFor(sessionId);
    await DesktopHostFS.writeFile(path, text);
    return path;
  } catch {
    // Host FS unavailable or failed — rollout persistence is best-effort;
    // the in-memory store remains the source of truth.
    return null;
  }
}

/**
 * Read a rollout file. Non-Tauri (web): null no-op. Returns the raw text —
 * callers run it through `rolloutParse`, which owns all tolerance.
 */
export async function rolloutRead(path: string): Promise<string | null> {
  try {
    const { isTauri } = await import('../../platform');
    if (!isTauri()) return null;
    return await DesktopHostFS.readFile(path);
  } catch {
    return null;
  }
}
