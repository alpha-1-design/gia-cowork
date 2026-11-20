/**
 * Guardian — the advisory auto-reviewer that runs BEFORE the permission gate.
 *
 * The permission gate answers "may this run?" from the user's standing grants.
 * It cannot answer a different question the grants never encoded: "does the
 * EVIDENCE behind this call actually trace back to the user?" A session grant
 * for `write:<dir>` was given by a person looking at a prompt. It says nothing
 * about a write whose path was read out of a web page, or a shell command
 * whose payload was copied from a WhatsApp message. That gap is exactly the
 * injection surface: content arrives as tool output, and the model acts on it
 * as if the user had asked.
 *
 * So Guardian scores two independent axes, mirroring Codex's guardian reviewer
 * (PR #13860) but as a pure deterministic pass rather than an LLM subagent:
 *
 *   1. RISK — how badly does this go if it is wrong? (destructive commands,
 *      writes outside the project, network + credentials, deep delegation
 *      chains, injected-looking content)
 *   2. AUTHORIZATION — where did the justification come from? 'unknown'
 *      whenever the plausible evidence came from TOOL OUTPUT, because tool
 *      output is data, never authorization. This is R1's critical rule and
 *      the reason the axis exists at all.
 *
 * Deliberately pure: no I/O, no store access, no globals, no randomness. Same
 * arguments in, same review out — so it can sit inside the hot tool path and
 * still be exhaustively testable. It may only ESCALATE to a prompt; it never
 * widens authority and never denies on its own.
 */

import { analyzePath, analyzeCommand } from '../permissions';
import { isProtectedPath } from '../selfbuild/protectedPaths';

// ── shapes ───────────────────────────────────────────────────────────────

export type GuardianRisk = 'low' | 'medium' | 'high';

export interface GuardianReview {
  risk: GuardianRisk;
  /** One plain sentence: what flagged (or why nothing did). */
  reason: string;
  /**
   * 'granted' means "no evidence that this call's justification came from
   * tool output" — it does NOT mean the user verifiably asked for it; it
   * means the ordinary grant/prompt machinery can be trusted to apply.
   * 'unknown' means the evidence plausibly came from tool output, and no
   * previously recorded grant can have covered that.
   */
  authorization: 'granted' | 'unknown';
}

export interface GuardianContext {
  /**
   * Recent tool-result bodies (observation strings), used ONLY for the
   * authorization check — never for risk. The runner feeds these from its
   * history; a caller that cannot supply them simply leaves them out.
   */
  recentToolOutputs?: string[];
  /** How deep the sub-agent delegation chain is, when the caller knows. */
  delegationDepth?: number;
}

interface Escalation {
  risk: GuardianRisk;
  reason: string;
}

const RISK_RANK: Record<GuardianRisk, number> = { low: 0, medium: 1, high: 2 };

// Canonical prompt-injection detector (W2). Guardian originally carried a
// local duplicate so the two tasks could land in parallel; that debt is
// paid now. One copy means new heuristics land in exactly one place and
// the Guardian's judgment and the labeling layer can never drift apart.
import { containsInjectedInstruction } from '../untrusted';

// ── heuristic tables ─────────────────────────────────────────────────────

/** Tools that reach the network on their own. */
const NETWORK_TOOLS = new Set([
  'web_search', 'read_url', 'browser_navigate', 'browser_type', 'page_info',
  'mcp_call', 'mcp_tool_call',
]);

/** Tools that write files; their path argument is what analyzePath judges. */
const WRITE_TOOL_IDS = new Set([
  'filesystem_write', 'file_write', 'write_file', 'filegen_write', 'documents_write',
]);

/**
 * Credential-ish argument keys and value shapes. Keys catch the honest
 * spelling (`apiKey`, `password`); values catch a secret pasted under an
 * innocent key, which is how a leak actually happens.
 */
const CREDENTIAL_KEY = /(token|secret|password|passwd|api[-_]?key|apikey|authorization|bearer|credential|private[-_]?key)/i;
const CREDENTIAL_VALUE = /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|xox[bap]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{10,})\b/;

/**
 * The fetch-to-execute signature: content pulled from the network and handed
 * straight to an interpreter. The thing being run IS tool output, so no
 * earlier grant can have covered it — this is the authorization break in
 * miniature.
 */
const FETCH_TO_EXEC = /\b(curl|wget|invoke-webrequest|iwr)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|k|fi)?sh\b|\|\s*iex\b/i;

/**
 * Arguments whose values carry the action's justification. When one of these
 * appears verbatim in recent tool output, the model is acting on data it
 * read, not on something the user said — R1's critical rule, detected by
 * fingerprint rather than by provenance (the runner has no better provenance
 * to offer yet).
 */
const EVIDENCE_KEYS = ['url', 'path', 'to', 'command'] as const;

/** Strings below this length are too short to fingerprint meaningfully. */
const MIN_EVIDENCE_LEN = 8;

// ── prompt-injection heuristics ────────────────────────────────────
//
// The detector lives in src/services/untrusted.ts. Local alias keeps the
// call sites below unchanged while making the single-source-of-truth
// explicit. Do not add rules HERE; extend containsInjectedInstruction.
const looksInjected = containsInjectedInstruction;

// ── the review ───────────────────────────────────────────────────────────

export function reviewAction(
  toolId: string,
  toolName: string,
  args: Record<string, unknown>,
  ctx?: GuardianContext,
): GuardianReview {
  const escalations: Escalation[] = [];
  const stringArgs = Object.entries(args ?? {}).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  );
  const command = typeof args.command === 'string' ? args.command : '';

  // Destructive / irreversible commands. The command classifier in
  // permissions.ts already encodes the full rule table (including the
  // Windows cmdlets from the A2 hardening), so we reuse its judgment instead
  // of maintaining a second, drifting blocklist. High/critical is exactly
  // the class of action a session grant must never silently cover.
  if (toolId === 'terminal_run' || toolId === 'bash') {
    if (command.trim()) {
      const analysis = analyzeCommand(command);
      if (analysis.risk === 'high' || analysis.risk === 'critical') {
        escalations.push({
          risk: 'high',
          reason: analysis.reasons[0] || 'Runs a destructive or irreversible command.',
        });
      } else if (analysis.risk === 'moderate') {
        escalations.push({
          risk: 'medium',
          reason: analysis.reasons[0] || 'Runs a state-changing command.',
        });
      }
    }
  }

  // Writes outside the active project. analyzePath owns the judgment about
  // where a path lives — system directory, your home, or the project — so a
  // write into ~/Documents or C:\Windows escalates here without Guardian
  // duplicating any path knowledge.
  if (WRITE_TOOL_IDS.has(toolId)) {
    const path = String(args.path ?? args.file ?? '');
    if (path) {
      // Self-edit deny-list first (protectedPaths.ts): a write aimed at the
      // enforcement layer (gate.rs, TrustGate, permissions.ts, ...) is the
      // one write that can silently remove the checks protecting everything
      // else. High risk + authorization 'unknown' — GIA editing her own
      // safety rails can never trace to a grant the user clicked hours ago.
      if (isProtectedPath(path)) {
        escalations.push({
          risk: 'high',
          reason: `The write targets a protected path (${path}) — GIA never edits her own enforcement layer without explicit confirmation.`,
        });
      }
      const verdict = analyzePath(path);
      if (verdict.risk === 'high' || verdict.risk === 'moderate') {
        escalations.push({
          risk: verdict.risk === 'high' ? 'high' : 'medium',
          reason: verdict.reason,
        });
      }
    }
  }

  // Shell commands whose text aims at a protected path (rm/mv/cat of the
  // enforcement files, or a cd into src-tauri). Same reasoning as the write
  // check — the shell is the other way self-edits happen.
  if ((toolId === 'terminal_run' || toolId === 'bash') && command) {
    for (const token of command.split(/\s+/)) {
      if (token.length > 4 && isProtectedPath(token)) {
        escalations.push({
          risk: 'high',
          reason: `The command references a protected path (${token}) — shell self-edits of the enforcement layer are blocked pending explicit confirmation.`,
        });
        break;
      }
    }
  }

  // Network access combined with credential-ish arguments. Neither half is
  // notable alone — fetching a URL is routine, and a stored credential sits
  // in args legitimately. Together they are the classic payoff of injected
  // content: exfiltrate a secret over the network while it still looks like
  // an ordinary call.
  const isNetwork = NETWORK_TOOLS.has(toolId) || /\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod)\b/i.test(command);
  if (isNetwork) {
    for (const [key, value] of stringArgs) {
      if (CREDENTIAL_KEY.test(key) || CREDENTIAL_VALUE.test(value)) {
        escalations.push({
          risk: 'high',
          reason: 'Sends credentials to the network — this is how a leak happens when the request was not really yours.',
        });
        break;
      }
    }
  }

  // Sub-agent delegation chains. Each hop is another context the user is
  // not reading and another prompt that can carry injected intent; from
  // depth 3 on, nobody can reconstruct who originally asked for what, so
  // the review escalates even when every individual step looks safe.
  if ((ctx?.delegationDepth ?? 0) >= 3) {
    escalations.push({
      risk: 'medium',
      reason: `Delegation chain is ${ctx!.delegationDepth} deep — oversight thins with every hop.`,
    });
  }

  // Untrusted-content markers in a terminal command. A command that talks to
  // the assistant was almost certainly assembled from fetched or bridged
  // content rather than written by anyone at a keyboard.
  if ((toolId === 'terminal_run' || toolId === 'bash') && command && looksInjected(command)) {
    escalations.push({
      risk: 'high',
      reason: 'The command text carries instructions addressed to the assistant — it was likely copied from untrusted content, not written by you.',
    });
  }

  // Injected-looking content anywhere else in the arguments. Tool arguments
  // are supposed to be parameters, not paragraphs of imperative prose; when
  // they are, the action may be executing someone else's intent.
  for (const [key, value] of stringArgs) {
    if (key === 'command') continue; // covered by the terminal check above
    if (value.length > 24 && looksInjected(value)) {
      escalations.push({
        risk: 'high',
        reason: `The '${key}' argument carries prompt-injection style instructions — this action may be executing untrusted content's intent, not yours.`,
      });
      break;
    }
  }

  // ── authorization (R1 critical rule) ──────────────────────────────────
  const auth = assessAuthorization(stringArgs, command, ctx?.recentToolOutputs);

  let risk: GuardianRisk = 'low';
  let reason = auth.authorization === 'unknown'
    ? `No escalation signals on the action itself, but ${auth.reason} — tool output is data, never authorization.`
    : `${toolName}: no escalation signals — routine call.`;
  for (const e of escalations) {
    if (RISK_RANK[e.risk] > RISK_RANK[risk]) {
      risk = e.risk;
      reason = auth.authorization === 'unknown'
        ? `${e.reason} — and ${auth.reason}, so the authority for this call is unclear.`
        : e.reason;
    }
  }
  if (escalations.length === 0 && auth.authorization === 'unknown') {
    risk = 'medium';
    reason = `${reason} Holding for confirmation anyway.`;
  }

  return { risk, reason, authorization: auth.authorization };
}

/**
 * Where did the justification for this call come from?
 *
 * Two fingerprints of tool-output-derived authority: a fetch-to-exec
 * command (the payload IS tool output), and an evidence argument whose
 * value appears verbatim in recent tool results. Absent either, the call
 * stands or falls on the ordinary grant/prompt machinery — 'granted'.
 */
function assessAuthorization(
  stringArgs: [string, string][],
  command: string,
  recentToolOutputs?: string[],
): { authorization: 'granted' | 'unknown'; reason?: string } {
  // A command that pipes fetched content into an executor is its own
  // evidence chain: what runs is a web page's body, so no grant recorded
  // earlier can have covered it.
  if (command && FETCH_TO_EXEC.test(command)) {
    return {
      authorization: 'unknown',
      reason: 'the command pipes fetched web content straight into an executor',
    };
  }

  // An evidence argument appearing verbatim in recent tool output is the
  // fingerprint of a hallucinated authorization: the model read the URL,
  // path, recipient or command out of a tool result rather than out of the
  // user's request.
  if (recentToolOutputs && recentToolOutputs.length > 0) {
    const haystack = recentToolOutputs.join('\n').toLowerCase();
    if (haystack.trim()) {
      for (const key of EVIDENCE_KEYS) {
        const value = stringArgs.find(([k]) => k === key)?.[1];
        if (typeof value === 'string' && value.trim().length >= MIN_EVIDENCE_LEN) {
          if (haystack.includes(value.trim().toLowerCase())) {
            return {
              authorization: 'unknown',
              reason: `the '${key}' argument appears verbatim in recent tool output`,
            };
          }
        }
      }
    }
  }

  return { authorization: 'granted' };
}
