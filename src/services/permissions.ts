/**
 * Permission classification — the thing you should see BEFORE an action runs.
 *
 * GIA already had approvals, and they were the right instinct in the wrong
 * shape. You got a card saying "Execute filesystem_write" with a truncated
 * argument blob, and the only choices were run it or stop the turn. That is
 * not a real review: you cannot tell from that card whether the agent is about
 * to reformat one file or overwrite the wrong project, and you certainly
 * cannot tell `git push --force` from `git push`.
 *
 * Every competitor that touches your files runs in a throwaway VM, so a wrong
 * call costs you a reset. GIA runs against the real disk — which is the whole
 * appeal and the whole risk. This module closes that gap with three things the
 * old card lacked:
 *
 *   1. a RISK RATING that comes from the actual arguments, not the tool name;
 *   2. a PREVIEW of the effect (real diff for a file write, the command with
 *      its dangerous parts called out) so approval is informed;
 *   3. a SCOPE KEY ("any file under ~/projects/api") so "allow this session"
 *      means something more precise than "allow writes".
 *
 * Deliberately pure: no I/O, no store access, no globals. Everything here is a
 * function of its arguments, so it is exhaustively testable and can be run
 * against a tool call before the tool itself does anything at all.
 */

import { toolToImpact } from './brain/toolSchemas';

// ── risk ─────────────────────────────────────────────────────────────────

export type RiskLevel = 'none' | 'low' | 'moderate' | 'high' | 'critical';

export const RISK_ORDER: RiskLevel[] = ['none', 'low', 'moderate', 'high', 'critical'];

const RISK_RANK: Record<RiskLevel, number> = {
  none: 0, low: 1, moderate: 2, high: 3, critical: 4,
};

export function riskAtLeast(level: RiskLevel, min: RiskLevel): boolean {
  return RISK_RANK[level] >= RISK_RANK[min];
}

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

export const RISK_META: Record<RiskLevel, { label: string; color: string; blurb: string }> = {
  none:     { label: 'Safe',      color: '#6b7280', blurb: 'Reads state or answers a question. Nothing on your machine changes.' },
  low:      { label: 'Low',       color: '#22c55e', blurb: 'A small local change, easy to reverse.' },
  moderate: { label: 'Review',    color: '#eab308', blurb: 'Changes real state — a file, a device, or something other people can see.' },
  high:     { label: 'Dangerous', color: '#f97316', blurb: 'Hard to undo, touches things outside this project, or reaches the network.' },
  critical: { label: 'Severe',    color: '#ef4444', blurb: 'Data loss or system damage is possible and may be unrecoverable.' },
};

// ── request shape ────────────────────────────────────────────────────────

export type PreviewKind = 'diff' | 'command' | 'text' | 'url' | 'args';

export interface PermissionPreview {
  kind: PreviewKind;
  /** File path, for a diff. */
  path?: string;
  /** Current on-disk content. null means the file does not exist yet. */
  before?: string | null;
  /** Content that will be written. */
  after?: string;
  /** The command, for `command`. */
  command?: string;
  /** The URL, for `url`. */
  url?: string;
  /** Fallback for tools with no better shape: a readable arg summary. */
  fields?: { key: string; value: string }[];
  /** True when any part of the payload was cut for display. */
  truncated?: boolean;
}

export interface PermissionRequest {
  id: string;
  toolId: string;
  toolName: string;
  risk: RiskLevel;
  /** One plain sentence: what is about to happen. */
  headline: string;
  /** Why it is rated this way. Empty only for 'none'. */
  reasons: string[];
  /**
   * Stable key a grant is recorded against. Deliberately narrow: "writes under
   * this directory", not "writes", so a session grant cannot silently widen.
   */
  scope: string;
  /** Human phrasing of the scope, shown on the allow buttons. */
  scopeLabel: string;
  preview?: PermissionPreview;
  args: Record<string, unknown>;
}

// ── shell analysis ───────────────────────────────────────────────────────

/** Maximum characters of a file body rendered in a preview. */
const MAX_PREVIEW_CHARS = 8000;
/** Maximum lines of a file body handed to the diff renderer. */
const MAX_PREVIEW_LINES = 600;

export interface CommandAnalysis {
  risk: RiskLevel;
  reasons: string[];
  /** The individual pipeline/chained segments that were inspected. */
  segments: string[];
}

interface CommandRule {
  /** Regex tested against the command text. */
  test: RegExp;
  risk: RiskLevel;
  reason: string;
}

/**
 * Rules applied to the command line as a whole.
 *
 * These are the patterns that only exist *between* the segments — a download
 * piped into a shell, a fork bomb, an encoded payload. Splitting a command
 * destroys exactly the patterns worth catching: a fork bomb is `|`, `&` and
 * `;` glued together, and `curl x | sh` becomes two innocent-looking words
 * once the pipe is removed. So these run first, against the raw text.
 */
const WHOLE_COMMAND_RULES: CommandRule[] = [
  { test: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
    risk: 'critical', reason: 'Fork bomb — this will exhaust the machine.' },
  { test: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|fi)?sh\b/,
    risk: 'high', reason: 'Pipes a downloaded script straight into a shell — you cannot see what you are running.' },
  { test: /\bbase64\s+(-d|--decode)\b[^|]*\|\s*(ba)?sh\b/,
    risk: 'high', reason: 'Decodes and runs an encoded payload.' },
  { test: /\beval\b[^|;&]*\b(base64|curl|wget|echo)\b/,
    risk: 'high', reason: 'Evaluates dynamically constructed or encoded code.' },
  // A subshell or backtick can hide an entire second command, so a line that
  // uses one is never reviewed segment-by-segment alone.
  { test: /\$\(|`/,
    risk: 'moderate', reason: 'Runs a nested command via substitution, so the real command is not visible on this line.' },
];

/**
 * Per-segment rules, applied to every segment of a command line.
 *
 * These target the specific strings that show up when a coding agent gets
 * something wrong. Each is a real failure mode observed in agent transcripts,
 * not a generic blocklist: `rm -rf node_modules` is routine, `rm -rf ~` is
 * the catastrophe, and only the target distinguishes them.
 *
 * Tested against BOTH the raw segment and a lowercased copy. Lowercasing alone
 * is wrong in a way that matters: `$HOME` becomes `$home`, which is a
 * different (usually empty) variable, so the home-directory rule silently
 * stopped matching the one command it exists to catch.
 */
const SEGMENT_RULES: CommandRule[] = [
  // ── unrecoverable ─────────────────────────────────────────────────────
  { test: /(^|\s)rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|\/\*|~|\$HOME|\*)(\s|$)/,
    risk: 'critical', reason: 'Recursive delete aimed at the filesystem root, your home directory, or everything in it.' },
  { test: /(^|\s)rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(\s|$)/,
    risk: 'critical', reason: 'Recursive delete of /.' },
  { test: /\bdd\b[^|;&]*\bof=\/dev\//,
    risk: 'critical', reason: 'Writes directly to a raw block device — this overwrites the disk.' },
  { test: /\bmkfs(\.\w+)?\b|\bfdisk\b|\bdiskutil\s+erase|\bformat\s+[a-zA-Z]:/,
    risk: 'critical', reason: 'Formats a disk or partition.' },
  { test: /\bhistory\s+-c\b|\bshred\b[^|;&]*\b\/dev\//,
    risk: 'moderate', reason: 'Erases shell history or shreds a device.' },

  // ── privilege and system scope ────────────────────────────────────────
  { test: /(^|\s)(sudo|doas|su)\s/,
    risk: 'high', reason: 'Runs as root or another user — it can change anything on this machine.' },
  { test: /(^|\s)(shutdown|reboot|halt|poweroff)\b/,
    risk: 'high', reason: 'Shuts the machine down.' },
  { test: /(^|\s)chmod\s+(-[a-zA-Z]+\s+)?(777|a\+rwx|o\+w)\b/,
    risk: 'high', reason: 'Makes a file or directory world-writable.' },
  { test: /(^|\s)(chown|chgrp)\b/,
    risk: 'high', reason: 'Changes file ownership, which can lock you out of your own files.' },
  { test: /(^|\s)kill(all)?\s+(-9|-KILL)|\bpkill\b/,
    risk: 'moderate', reason: 'Force-kills processes, including ones you did not start.' },
  { test: />\s*\/dev\/(sd|nvme|disk|hd)/,
    risk: 'critical', reason: 'Redirects output to a raw disk device.' },
  { test: /(^|\s)(visudo|passwd|useradd|userdel|usermod|dscl)\b/,
    risk: 'high', reason: 'Changes system accounts or passwords.' },

  // ── network and supply chain ───────────────────────────────────────────
  { test: /(^|\s)(npm|pnpm|yarn|bun)\s+(i|install|add)\b/,
    risk: 'moderate', reason: 'Installs packages, which runs their install scripts and pulls from the network.' },
  { test: /(^|\s)(pip3?|uv)\s+install\b/,
    risk: 'moderate', reason: 'Installs Python packages from the network.' },
  { test: /(^|\s)(apt|apt-get|brew|yum|dnf|apk)\s+(install|remove|purge|upgrade)\b/,
    risk: 'high', reason: 'Changes system packages outside this project.' },
  { test: /(^|\s)(ssh|scp|rsync)\b[^|;&]*\s/,
    risk: 'moderate', reason: 'Reaches another machine over the network.' },
  { test: /\bgit\s+push\b[^|;&]*(--force|-f\b|--force-with-lease)/,
    risk: 'high', reason: 'Force-pushes, which can destroy commits other people already have.' },
  { test: /\bgit\s+push\b/,
    risk: 'moderate', reason: 'Publishes your commits to a remote — other people can see them.' },

  // ── version control that loses work ───────────────────────────────────
  { test: /\bgit\s+reset\s+--hard\b/,
    risk: 'high', reason: 'Discards uncommitted changes permanently.' },
  { test: /\bgit\s+clean\s+-[a-zA-Z]*f/,
    risk: 'high', reason: 'Deletes untracked files permanently.' },
  { test: /\bgit\s+checkout\s+(--\s+)?\.\s*$/,
    risk: 'high', reason: 'Discards every uncommitted change in the working tree.' },
  { test: /\bgit\s+(stash\s+drop|branch\s+-D\s|filter-branch)\b/,
    risk: 'moderate', reason: 'Drops stashed or branch history.' },
  { test: /\bgit\s+(commit|merge|rebase|cherry-pick|tag)\b/,
    risk: 'low', reason: 'Records changes in the repository history.' },

  // ── structure that hides a write ──────────────────────────────────────
  { test: /(^|\s)(eval|source)\s+/,
    risk: 'moderate', reason: 'Sourcing or evaluating a file runs whatever it contains.' },
  { test: /\bchmod\s+[0-7]*7[0-7]{2}\b/,
    risk: 'moderate', reason: 'Loosens file permissions.' },
];

/** Segments that are pure read-only navigation and raise nothing on their own. */
const BENIGN_SEGMENT = /^\s*(ls|cat|head|tail|pwd|echo|printf|whoami|date|which|git status|git log|git diff)\b/;

function splitSegments(command: string): string[] {
  // Split on the operators that can hide a second command inside the first.
  // Quotes are stripped first so a `;` inside a string literal is not a split.
  const unquoted = command.replace(/'[^']*'|"[^"]*"/g, ' ');
  return unquoted
    .split(/\|\||&&|[|;&\n]/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

export function analyzeCommand(command: string): CommandAnalysis {
  const raw = command || '';
  const segments = splitSegments(raw);
  if (segments.length === 0) {
    return { risk: 'none', reasons: [], segments: [] };
  }

  let risk: RiskLevel = 'none';
  const reasons: string[] = [];
  const seen = new Set<string>();

  const record = (level: RiskLevel, reason: string) => {
    risk = maxRisk(risk, level);
    if (!seen.has(reason)) {
      seen.add(reason);
      reasons.push(reason);
    }
  };

  // Whole-line patterns first, against the untouched text.
  for (const rule of WHOLE_COMMAND_RULES) {
    if (rule.test.test(raw)) record(rule.risk, rule.reason);
  }

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    for (const rule of SEGMENT_RULES) {
      if (rule.test.test(segment) || rule.test.test(lower)) record(rule.risk, rule.reason);
    }
  }

  // A redirection is a write even when the command reads. Writing inside the
  // project is routine; writing outside it is the dangerous half.
  const redirects = command.match(/>>?\s*([^\s|>]+)/g) || [];
  for (const r of redirects) {
    const target = r.replace(/^>+\s*/, '').replace(/^['"]|['"]$/g, '');
    const verdict = analyzePath(target);
    if (verdict.risk === 'none' || verdict.risk === 'low') {
      risk = maxRisk(risk, 'low');
      if (!seen.has('redirect')) {
        seen.add('redirect');
        reasons.push(`Redirects output to a file${target ? ` (${target})` : ''}.`);
      }
    } else {
      record(verdict.risk, verdict.reason);
    }
  }

  // Chaining several commands raises the floor even when each is benign,
  // because a long pipeline is exactly where a surprising command hides.
  if (segments.length > 3 && !reasons.length) {
    risk = 'moderate';
    reasons.push(`Chains ${segments.length} commands in one line — harder to verify by eye.`);
  }

  if (risk === 'none' && segments.every(s => BENIGN_SEGMENT.test(s))) {
    return { risk: 'none', reasons: [], segments };
  }
  if (risk === 'none') {
    risk = 'low';
    reasons.push('Runs a command on your machine.');
  }
  return { risk, reasons, segments };
}

// ── path analysis ────────────────────────────────────────────────────────

export interface PathAnalysis {
  risk: RiskLevel;
  reason: string;
  /** Directory prefix used for scope keys and grant labels. */
  root: string;
}

/** Directories where a write is a system-level problem, not a project one. */
const SYSTEM_PREFIXES = [
  '/etc', '/usr', '/bin', '/sbin', '/boot', '/lib', '/var/lib', '/proc', '/sys',
  '/System', '/Library', '/Applications', '/private/etc',
  'c:/windows', 'c:/program files', 'c:/program files (x86)',
];

/** User-owned but still not-this-project: a write here can break unrelated work. */
const HOME_WRITE_PREFIXES = [
  '/users', '/home', 'c:/users',
];

/**
 * Where a path lives, expressed as a scope root.
 *
 * The grant key is derived from this, so "allow writes under
 * ~/projects/api" cannot be satisfied by a write to ~/Desktop.
 */
export function analyzePath(rawPath: string): PathAnalysis {
  let p = (rawPath || '').trim().replace(/^['"]|['"]$/g, '');
  if (!p) {
    return { risk: 'moderate', reason: 'Writes a file at a path the tool did not specify.', root: '(unknown path)' };
  }

  // Normalize to a leading-slash form so Windows and POSIX compare sanely.
  const normalized = p.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();

  if (SYSTEM_PREFIXES.some(prefix => lower === prefix || lower.startsWith(prefix + '/'))) {
    return {
      risk: 'high',
      reason: `Writes inside a system directory (${SYSTEM_PREFIXES.find(pr => lower.startsWith(pr))}) — this can break the machine.`,
      root: systemRootOf(lower),
    };
  }

  // Prefixes are pre-lowercased so they compare against the normalised path.
  // Comparing `/Users` against `/users/me/...` never matches, which silently
  // let every real macOS home path report as a plain project write.
  if (/^~\//.test(p) || HOME_WRITE_PREFIXES.some(prefix => lower === prefix || lower.startsWith(prefix + '/'))) {
    return {
      risk: 'moderate',
      reason: 'Writes outside the project directory, into your personal files.',
      root: parentOf(normalized),
    };
  }

  return { risk: 'low', reason: 'Writes a file in the project.', root: parentOf(normalized) };
}

function parentOf(normalized: string): string {
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return normalized;
  return normalized.slice(0, idx);
}

function systemRootOf(lower: string): string {
  for (const prefix of SYSTEM_PREFIXES) {
    if (lower.startsWith(prefix)) return prefix;
  }
  return '/';
}

/**
 * Is this path inside the active project?
 *
 * Used to soften the "outside the project" penalty when we actually know the
 * project root — without a cwd we cannot tell `src/app.ts` from
 * `~/Desktop/tax-return.pdf`, so we report low and let the preview carry the
 * weight instead of crying wolf on every write.
 */
export function isInsideProject(path: string, projectRoot: string | undefined): boolean {
  if (!projectRoot) return true;
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  return norm(path).startsWith(norm(projectRoot));
}

// ── per-tool classification ──────────────────────────────────────────────

/** Tools that cannot change anything, whatever arguments they are given. */
const READ_ONLY_TOOLS = new Set([
  'filesystem_read', 'list_files', 'web_search', 'read_url', 'browser_navigate',
  'page_info', 'get_environment_info', 'get_user_location', 'search_places',
  'get_directions', 'wikipedia', 'weather', 'define', 'project_context',
  'project_memory_list', 'project_memory_forget', 'task_read', 'note_read',
  'mcp_list_servers', 'mcp_list_tools', 'mcp_server_status', 'mcp_stats',
  'email_list', 'email_read', 'email_search', 'email_status', 'calendar_list_events',
  'calendar_status', 'messaging_status', 'social_list_platforms', 'bible_verse',
  'device_info', 'device_health', 'project_context_list', 'get_temperature',
]);

/** Baseline risk for tools whose arguments do not change the verdict much. */
const TOOL_RISK: Record<string, { risk: RiskLevel; headline: (args: Record<string, unknown>) => string }> = {
  terminal_run: {
    risk: 'moderate',
    headline: (a) => `Runs a shell command: ${truncate(String(a.command ?? '(empty)'), 120)}`,
  },
  sandbox_exec: {
    risk: 'moderate',
    headline: (a) => `Runs code in a sandbox: ${truncate(String(a.code ?? a.command ?? ''), 120)}`,
  },
  build_project: {
    risk: 'low',
    headline: () => 'Builds the project. This writes output artifacts to disk.',
  },
  forget_memory: {
    risk: 'high',
    headline: () => 'Deletes a stored memory. This cannot be undone.',
  },
  save_memory: {
    risk: 'low',
    headline: () => 'Saves a new memory to your store.',
  },
  send_email: {
    risk: 'moderate',
    headline: (a) => `Sends an email to ${a.to ?? 'a recipient'}. It cannot be recalled.`,
  },
  email_send: {
    risk: 'moderate',
    headline: () => 'Sends an email. It cannot be recalled.',
  },
  messaging_send: {
    risk: 'moderate',
    headline: () => 'Sends a message to another person. It cannot be recalled.',
  },
  send_whatsapp: {
    risk: 'moderate',
    headline: () => 'Sends a WhatsApp message. It cannot be recalled.',
  },
  system_lock: {
    risk: 'moderate',
    headline: () => 'Locks your screen. You will need to authenticate to get back in.',
  },
  screen_brightness: {
    risk: 'low',
    headline: () => 'Changes your screen brightness.',
  },
  install_skill: {
    risk: 'moderate',
    headline: (a) => `Installs the skill "${a.name ?? a.skill ?? 'unknown'}", which adds new capabilities.`,
  },
  export_brain: {
    risk: 'moderate',
    headline: (a) => `Exports your brain data to ${a.path ?? 'a file you choose'}.`,
  },
  import_brain: {
    risk: 'high',
    headline: (a) => `Imports brain data from ${a.path ?? 'a file'}, overwriting what is there.`,
  },
  toggle_feature: {
    risk: 'low',
    headline: (a) => `Turns the feature "${a.feature ?? a.name ?? ''}" on or off.`,
  },
  zip_project: {
    risk: 'low',
    headline: () => 'Packs files into a zip archive.',
  },
  show_notification: {
    risk: 'low',
    headline: () => 'Shows a notification on your desktop.',
  },
  set_alarm: {
    risk: 'low',
    headline: () => 'Sets an alarm.',
  },
  filegen_write: {
    risk: 'moderate',
    headline: (a) => `Writes generated content to ${a.path ?? 'a file'}.`,
  },
  documents_write: {
    risk: 'moderate',
    headline: (a) => `Writes a document to ${a.path ?? 'a file'}.`,
  },
};

/** How a `write`-impact tool's risk follows from its path. */
const WRITE_TOOL_IDS = new Set(['filesystem_write', 'file_write', 'write_file']);

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function clipForPreview(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_PREVIEW_CHARS) return { text: content, truncated: false };
  // Cut on a line boundary — a preview that ends mid-token is useless.
  const sliced = content.slice(0, MAX_PREVIEW_CHARS);
  const lastBreak = sliced.lastIndexOf('\n');
  return { text: lastBreak > 0 ? sliced.slice(0, lastBreak) : sliced, truncated: true };
}

export interface ClassifyOptions {
  /** Current contents of the target file, when known. Enables a real diff. */
  beforeContent?: string | null;
  /** Absolute path of the project root, when known. */
  projectRoot?: string;
  /** Stable id to stamp onto the request. */
  id?: string;
}

/**
 * Turn a tool call into a reviewable request.
 *
 * The order matters: a tool-specific rule wins, then argument analysis can
 * only RAISE the result. A generic "write" is 'moderate', but a write to
 * /etc/passwd escalates to 'high' — never the reverse, so a rule set for
 * terminal commands can never accidentally downgrade a known-safe read.
 */
export function classifyToolRequest(
  toolId: string,
  toolName: string,
  args: Record<string, unknown> = {},
  options: ClassifyOptions = {},
): PermissionRequest {
  const id = options.id ?? `${toolId}-${Math.random().toString(36).slice(2, 10)}`;
  const base: PermissionRequest = {
    id, toolId, toolName,
    risk: 'none', headline: toolName, reasons: [],
    scope: `tool:${toolId}`, scopeLabel: `any ${toolName} call`, args,
  };

  if (READ_ONLY_TOOLS.has(toolId)) {
    return { ...base, headline: `${toolName} — reads state, changes nothing.` };
  }

  // ── writes: the argument decides ────────────────────────────────────────
  if (WRITE_TOOL_IDS.has(toolId)) {
    const path = String(args.path ?? args.file ?? '');
    const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
    const analysis = analyzePath(path);
    const inProject = isInsideProject(path, options.projectRoot);
    const risk = inProject ? (analysis.risk === 'high' ? 'high' : 'low') : analysis.risk;

    const reasons = [...(analysis.risk === 'high' ? [analysis.reason] : [analysis.reason])];
    const before = options.beforeContent ?? null;
    if (before === null && options.beforeContent === undefined) {
      reasons.push('Cannot show a diff — the current contents of this file are unknown.');
    }

    const afterClip = clipForPreview(content);
    const beforeClip = before === null ? null : clipForPreview(before).text;

    return {
      ...base,
      risk,
      headline: before === null
        ? `Creates a new file at ${path || '(no path given)'}.`
        : `Overwrites ${path || '(no path given)'} with new content.`,
      reasons,
      scope: `write:${normalizeScopeRoot(path)}`,
      scopeLabel: `writes under ${normalizeScopeRoot(path) || '(unknown)'}`,
      preview: {
        kind: 'diff',
        path,
        before: beforeClip,
        after: afterClip.text,
        truncated: afterClip.truncated || (before !== null && before.length > MAX_PREVIEW_CHARS),
      },
    };
  }

  // ── commands: the text decides ──────────────────────────────────────────
  if (toolId === 'terminal_run' || toolId === 'bash') {
    const command = String(args.command ?? '');
    const analysis = analyzeCommand(command);
    return {
      ...base,
      risk: analysis.risk,
      headline: `Runs a shell command on your machine: ${truncate(command, 160) || '(empty)'}`,
      reasons: analysis.reasons,
      scope: `command:${commandPrefix(command)}`,
      scopeLabel: `shell commands starting "${commandPrefix(command) || '(any)'}"`,
      preview: { kind: 'command', command },
    };
  }

  // ── everything else: declared baseline, then impact floor ───────────────
  const declared = TOOL_RISK[toolId];
  const impactFloor: Record<string, RiskLevel> = {
    read: 'none', notification: 'low', network: 'low', location: 'low',
    write: 'moderate', execution: 'moderate', destructive: 'high',
  };
  const floor = impactFloor[toolToImpact(toolId)] ?? 'moderate';

  const risk = declared ? declared.risk : floor;
  const reasons: string[] = [];
  if (declared && risk !== 'none') {
    reasons.push(`${toolToImpact(toolId)} action.`);
  } else if (risk === 'none') {
    return { ...base, headline: `${toolName} — reads state, changes nothing.` };
  } else {
    reasons.push(`Unclassified tool with ${toolToImpact(toolId)} impact — reviewing by default.`);
  }

  return {
    ...base,
    risk,
    headline: declared ? declared.headline(args) : `${toolName} (${toolToImpact(toolId)} action)`,
    reasons,
    scope: `tool:${toolId}`,
    scopeLabel: `any ${toolName} call`,
  };
}

/** Normalize a path for use inside a grant key. */
function normalizeScopeRoot(path: string): string {
  const p = (path || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!p) return '';
  return parentOf(p);
}

/**
 * The stable prefix of a command, used as a grant key.
 *
 * `git status` and `git push` must not share a grant, so the key is the first
 * two words — binary plus subcommand. That is exactly the granularity a person
 * would say out loud: "yes, let it run git status without asking".
 */
export function commandPrefix(command: string): string {
  const segments = splitSegments(command || '');
  if (!segments.length) return '';
  const words = segments[0].split(/\s+/).filter(Boolean).slice(0, 2);
  return words.join(' ').toLowerCase();
}
