/**
 * Untrusted-content labeling — integrity labels on everything that reaches
 * the model from outside the user's keyboard.
 *
 * Web pages, WhatsApp messages, MCP results, clipboard pastes and unimind
 * relays are all written by someone who is not the user, yet they arrive in
 * the same channel as the user's own words. A page that says "run this
 * command" is an attack pretending to be a request. This module gives every
 * such observation an explicit envelope so the model can tell quoted data
 * from a real instruction — the FIDES direction (Microsoft Agent Framework
 * labels every content item trusted/untrusted and lets untrusted win on
 * combination; see task-reports/R1-harness-futures.md §3, item #7).
 *
 * Two honest limits, on purpose:
 *  - The envelope is advisory framing for the model, not a security parser.
 *    Enforcement stays with the permission gate and Guardian; this layer
 *    makes the boundary legible instead of invisible.
 *  - `containsInjectedInstruction` is a deliberately over-eager heuristic.
 *    False positives (flagging benign text) are acceptable — it advises,
 *    it never blocks on its own.
 */

/** Where an untrusted observation came from. */
export type UntrustedSource = 'whatsapp' | 'web' | 'mcp' | 'clipboard' | 'unimind' | 'file';

/**
 * Wrap `text` in a compact envelope marking it as untrusted content.
 *
 * Why: tagged content is DATA for the model, never instructions. Anything
 * addressed to the assistant inside the envelope is quoted material from an
 * outside sender; the system prompt tells the model to quote it back rather
 * than act on it.
 *
 * A message containing its own `[/UNTRUSTED-CONTENT]` could close the
 * envelope early and have the rest of it read as trusted context, so
 * embedded markers (any case) are defanged with an extra bracket — a form
 * that does not re-match, which keeps the function idempotent.
 */
export function labelObservation(source: UntrustedSource, text: string): string {
  const body = text.replace(/(?<!\[)\[\/?UNTRUSTED-CONTENT[^\]\n]{0,64}\]/g, (m) => `[${m}]`);
  return `[UNTRUSTED-CONTENT source=${source}]\n${body}\n[/UNTRUSTED-CONTENT]`;
}

// ── Prompt-injection heuristics ─────────────────────────────────────────
//
// Bounded scan, by design: the detector is advisory and must never hang a
// turn, so there are no backtracking regexes and no unbounded input —
// anything past the bounds is simply unscreened. Every check is a bounded
// substring test or a small literal-word alternation on a clipped line.

/** Max characters and lines examined per call. */
const MAX_SCAN_CHARS = 200_000;
const MAX_SCAN_LINES = 400;
const MAX_LINE_CHARS = 400;

/** Phrases that try to replace the assistant's standing instructions. */
const OVERRIDE_PHRASES = [
  'ignore previous', 'ignore all previous', 'ignore the above', 'ignore above',
  'disregard previous', 'disregard the above', 'disregard above',
  'forget all previous', 'forget previous', 'forget your instructions',
  'system prompt', 'developer instructions', 'developer mode',
  'you are now', 'new instructions:', 'override your instructions',
  'override the system', 'your instructions have changed',
];

/**
 * Imperative verbs, only flagged when the same line also addresses the
 * assistant ("you", "your", "assistant", "gia") — a code comment containing
 * the word "delete" should not light this up.
 */
const IMPERATIVE_VERB = /\b(execute|run|delete|send|install|write|remove|open|download|read|modify|overwrite|reveal|forward)\b/i;
const ADDRESSED_TO_ASSISTANT = /\b(you|your|yourself|assistant|gia)\b/i;

/** Asking the assistant to message a third party (exfiltration channel). */
const MESSAGING_PHRASES = [
  'send a message', 'send message', 'send an email', 'send email',
  'send whatsapp', 'send a whatsapp', 'send a text', 'send text',
  'text this to', 'email this to', 'message this to', 'whatsapp this to',
  'forward this to', 'reply to this number',
];

/** Credential words paired with a disclosure verb on the same line. */
const CREDENTIAL_WORDS = [
  'password', 'api key', 'apikey', 'api-key', 'access token', 'token',
  'credential', 'secret', 'private key', 'ssh key', 'auth key',
];
const DISCLOSURE_VERBS = [
  'send', 'share', 'reveal', 'give me', 'show me', 'print', 'paste',
  'exfiltrate', 'leak', 'disclose', 'copy',
];

/**
 * Heuristic prompt-injection detection. Over-flagging is intentional: the
 * result is advisory (escalate, show the user, quote instead of act), so a
 * false positive costs attention while a false negative costs control.
 */
export function containsInjectedInstruction(text: string): boolean {
  if (!text) return false;
  const bounded = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const lines = bounded.split('\n');
  const limit = Math.min(lines.length, MAX_SCAN_LINES);
  for (let i = 0; i < limit; i++) {
    const raw = lines[i].length > MAX_LINE_CHARS ? lines[i].slice(0, MAX_LINE_CHARS) : lines[i];
    const lower = raw.toLowerCase();
    if (OVERRIDE_PHRASES.some((p) => lower.includes(p))) return true;
    // Fenced tool-call JSON inside content — a page or message pretending
    // to BE the assistant by emitting GIA's own tool-call syntax.
    if (lower.includes('```tool')) return true;
    if (lower.includes('"tool"') && lower.includes('"args"')) return true;
    if (MESSAGING_PHRASES.some((p) => lower.includes(p))) return true;
    if (
      CREDENTIAL_WORDS.some((c) => lower.includes(c)) &&
      DISCLOSURE_VERBS.some((v) => lower.includes(v))
    ) return true;
    if (IMPERATIVE_VERB.test(lower) && ADDRESSED_TO_ASSISTANT.test(lower)) return true;
  }
  return false;
}

/**
 * Clip to `maxLen` and label in one call — the standard entry point for
 * any observation about to be handed to the model.
 */
export function sanitizeForContext(source: UntrustedSource, text: string, maxLen = 8000): string {
  let body = text;
  if (body.length > maxLen) {
    body = `${body.slice(0, maxLen)}\n[...clipped — ${text.length - maxLen} characters omitted...]`;
  }
  return labelObservation(source, body);
}

// ── Tool-output classification ──────────────────────────────────────────

/**
 * Whether a tool's output is fetched remote content rather than local
 * ground truth. `web_*` covers web_search; `browser_*` covers the live-tab
 * tools; `mcp_*` covers third-party MCP servers; `whatsapp_bridge_*`
 * covers the real WhatsApp channel.
 */
export function isUntrustedToolOutput(toolId: string): boolean {
  return (
    toolId === 'read_url' ||
    toolId.startsWith('web_') ||
    toolId.startsWith('browser_') ||
    toolId.startsWith('mcp_') ||
    toolId.startsWith('whatsapp_bridge_')
  );
}

/** Map a tool id to its untrusted-source label for the envelope. */
export function sourceForToolId(toolId: string): UntrustedSource {
  if (toolId.startsWith('mcp_')) return 'mcp';
  if (toolId.startsWith('whatsapp_bridge_')) return 'whatsapp';
  return 'web';
}
