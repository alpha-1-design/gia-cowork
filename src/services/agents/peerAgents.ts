import terminalService from '../TerminalService';

/**
 * Peer agents GIA can work alongside.
 *
 * A developer running GIA almost certainly already has other agents installed —
 * Claude Code, OpenCode, Copilot CLI, an editor. Pretending otherwise is the
 * expensive mistake: GIA re-implements work those tools already do well, in a
 * worse way, and burns the user's time re-deriving context their tooling
 * already holds.
 *
 * So this detects what is actually on the machine and gives GIA two ways to use
 * it — *delegate* a scoped task and read the result back, or just *know* the
 * tool exists so it stops reinventing it.
 *
 * Detection is `command -v`, which is the only portable probe: no filesystem
 * walking, no hardcoded paths per platform, and it respects whatever PATH the
 * user's shell actually has (including asdf, nix, homebrew, and a version
 * manager's shims).
 *
 * NOTE ON VERIFICATION: detection and command construction are unit-tested with
 * an injected shell. The agent CLIs themselves are not installed in this
 * environment, so "is this binary present" and "does this agent accept these
 * flags" have not been exercised against the real tools.
 */

/** Everything needed to talk to one peer agent. */
export interface PeerAgent {
  id: string;
  name: string;
  /** Executable looked up with `command -v`. */
  bin: string;
  /** What this agent is actually good at — shown in the picker. */
  strength: string;
  /** A worked invocation, used as the prompt hint for `delegate_to_agent`. */
  usage: string;
  /**
   * Whether this is an editor rather than an agent. VS Code is in the list
   * because opening the built result in the user's real editor is a thing GIA
   * should be able to do, not because it can be delegated a prompt.
   */
  kind: 'agent' | 'editor';
}

export const PEER_AGENTS: PeerAgent[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    strength: 'Long multi-file refactors and codebase-wide reasoning.',
    usage: 'claude -p "<prompt>"',
    kind: 'agent',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    bin: 'opencode',
    strength: 'Fast local iteration with its own browser tooling.',
    usage: 'opencode run "<prompt>"',
    kind: 'agent',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    bin: 'copilot',
    strength: 'Repo-aware edits inside an existing GitHub workflow.',
    usage: 'copilot -p "<prompt>"',
    kind: 'agent',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    bin: 'hermes',
    strength: 'Deep multi-step runs; has its own git worktree isolation.',
    // `hermes chat -q` is the one-shot form that keeps tool output. `hermes -z`
    // is the scripted variant that prints only the final answer, which is wrong
    // here: delegation needs to come back with what the agent actually did.
    // (Verified against the Hermes CLI reference — there is no `hermes run`.)
    usage: 'hermes chat -q "<prompt>"',
    kind: 'agent',
  },
  {
    id: 'pi',
    name: 'Pi',
    bin: 'pi',
    strength: 'Minimal and fast. Small focused sub-tasks and one-file changes.',
    // `-p` / `--print` is required. Plain `pi "<prompt>"` opens the interactive
    // TUI and waits for a human, so it would hang until the terminal timeout
    // rather than failing — verified against the Pi CLI docs.
    usage: 'pi -p "<prompt>"',
    kind: 'agent',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    bin: 'code',
    strength: 'Opening the finished result in the real editor.',
    usage: 'code <path>',
    kind: 'editor',
  },
];

/** What a command run returned. */
export interface ShellResult {
  output: string;
  exitCode: number;
}

export type Shell = (command: string, cwd?: string) => Promise<ShellResult>;

const defaultShell: Shell = async (command, cwd) => {
  const res = await terminalService.exec(command, cwd);
  return { output: res.output ?? '', exitCode: res.exitCode ?? -1 };
};

let shell: Shell = defaultShell;

export function setShell(next: Shell): () => void {
  const prev = shell;
  shell = next;
  return () => { shell = prev; };
}

/** What `command -v` prints for a missing binary, which varies by shell. */
function found(output: string): boolean {
  const out = output.trim();
  if (!out) return false;
  return !/not found/i.test(out) && out.length > 0;
}

export interface DetectionResult {
  agent: PeerAgent;
  installed: boolean;
  /** Resolved path, when the probe found one. */
  path: string | null;
}

/**
 * Probe every peer agent in one pass.
 *
 * `command -v a b c` works and is a single shell round-trip, but this probes
 * individually so one slow or odd binary cannot wedge detection for the rest —
 * and so a single failure yields one honest `installed: false` instead of
 * killing the batch.
 */
export async function detectPeerAgents(cwd?: string): Promise<DetectionResult[]> {
  const out: DetectionResult[] = [];
  for (const agent of PEER_AGENTS) {
    try {
      const res = await shell(`command -v ${agent.bin}`, cwd);
      const path = res.exitCode === 0 && found(res.output) ? res.output.trim().split('\n')[0].trim() : null;
      out.push({ agent, installed: !!path, path });
    } catch {
      out.push({ agent, installed: false, path: null });
    }
  }
  return out;
}

export function installedAgents(results: DetectionResult[]): PeerAgent[] {
  return results.filter(r => r.installed).map(r => r.agent);
}

/** Agent ids, for the `/agents` command and the agent-detection prompt block. */
export function installedAgentIds(results: DetectionResult[]): string[] {
  return installedAgents(results).map(a => a.id);
}

/**
 * Single-quote for the host shell.
 *
 * Same POSIX reasoning as the worktree service: an allowlist would have to
 * either reject legitimate paths or stop being an allowlist. `terminal_exec`
 * spawns `sh -c` on Unix and `powershell -Command` on Windows, and both treat a
 * single-quoted string literally.
 */
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('Shell value contains a NUL byte');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the command that delegates a task to a peer agent.
 *
 * The prompt is quoted as one argument so a multi-line instruction, or one
 * containing quotes and `$(...)`, reaches the agent intact instead of being
 * re-split by the shell.
 */
export function buildDelegateCommand(agent: PeerAgent, prompt: string): string {
  if (!prompt || !prompt.trim()) throw new Error('Delegation prompt is empty');
  // Only ids from PEER_AGENTS can reach here, but the bin is still asserted
  // against the catalog so a caller cannot smuggle in an arbitrary executable.
  const known = PEER_AGENTS.find(a => a.id === agent.id);
  if (!known || known.bin !== agent.bin) throw new Error(`Unknown peer agent: ${agent.id}`);
  const q = shellQuote(prompt.trim());
  if (agent.kind === 'editor') return `${agent.bin} ${q}`;
  return agent.usage.replace('"<prompt>"', q);
}

export interface DelegateResult {
  ok: boolean;
  output: string;
  exitCode: number;
}

/**
 * Run a task on a peer agent and bring the output back.
 *
 * Output is truncated on the way in. A peer agent that prints a full build log
 * would otherwise dump thousands of lines into the conversation and evict the
 * actual conversation from the model's attention — the same reason DiffViewer
 * caps its render.
 */
export const MAX_DELEGATE_OUTPUT = 8000;

export async function delegateToAgent(
  agent: PeerAgent,
  prompt: string,
  cwd?: string,
  timeout?: number,
): Promise<DelegateResult> {
  const cmd = buildDelegateCommand(agent, prompt);
  const res = await shell(cmd, cwd);
  let output = res.output ?? '';
  const truncated = output.length > MAX_DELEGATE_OUTPUT;
  if (truncated) {
    output = output.slice(0, MAX_DELEGATE_OUTPUT)
      + `\n\n[truncated ${res.output.length - MAX_DELEGATE_OUTPUT} more characters]`;
  }
  return { ok: res.exitCode === 0, output, exitCode: res.exitCode };
}

/**
 * The prompt block describing what is installed.
 *
 * Goes into the system prompt so GIA reaches for an agent it already has
 * instead of reimplementing it. Returns '' when nothing is found, rather than
 * listing absent tools — a list of things that do not exist on this machine is
 * an instruction to go and use them.
 */
export function peerAgentPromptBlock(results: DetectionResult[]): string {
  const present = results.filter(r => r.installed);
  if (present.length === 0) return '';
  const agents = present.filter(r => r.agent.kind === 'agent');
  const editors = present.filter(r => r.agent.kind === 'editor');
  const lines: string[] = [];
  lines.push('## Other agents installed on this machine');
    lines.push('These are already here. Prefer delegating to them over reimplementing what they do well, and never claim a task is impossible because you lack a tool for it.');
    lines.push('');
    lines.push('Use `delegate_to_agent` with the `agent` id below. Give a self-contained prompt: the peer agent does not share this conversation, so it cannot see what you know unless you write it down.');
    lines.push('');
  if (agents.length) {
    lines.push('**Agents you can delegate to:**');
    for (const { agent, path } of agents) {
      lines.push(`- \`${agent.id}\` (${agent.name}, at ${path}) — ${agent.strength} Invoke: \`${agent.usage}\``);
    }
    lines.push('');
  }
  if (editors.length) {
    lines.push('**Editors available:**');
    for (const { agent } of editors) {
      lines.push(`- \`${agent.id}\` (${agent.name}) — ${agent.strength} Invoke: \`${agent.usage}\``);
    }
  }
  return lines.join('\n');
}