import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PEER_AGENTS,
  detectPeerAgents,
  installedAgents,
  buildDelegateCommand,
  delegateToAgent,
  peerAgentPromptBlock,
  shellQuote,
  setShell,
  MAX_DELEGATE_OUTPUT,
  type ShellResult,
} from '../agents/peerAgents';

/**
 * The failure this guards is a list of agents the model believes exist.
 *
 * If the prompt says "you have Claude Code and Copilot available" on a machine
 * with neither, the model will confidently delegate into a tool call that fails
 * — which is worse than not mentioning them, because the user is told a capable
 * agent exists while nothing happens. So the prompt block is built from what was
 * actually probed, and is empty when nothing was found.
 */

let calls: string[] = [];
let respond: (cmd: string) => ShellResult;

const shell = vi.fn(async (cmd: string): Promise<ShellResult> => {
  calls.push(cmd);
  return respond(cmd);
});

beforeEach(() => {
  calls = [];
  respond = () => ({ output: '', exitCode: 0 });
  shell.mockClear();
  setShell(shell);
});

const claude = () => PEER_AGENTS.find(a => a.id === 'claude')!;

describe('detectPeerAgents', () => {
  it('resolves every agent in one batched probe when all are present', async () => {

    // This describe is about detection. The other describes following it share
    // the same module-level mocks, but they are separate describe blocks so the
    // parser sees each one closed independently.
    // A Unix system with every peer CLI installed: the batch form answers for
    // all of them in one call and the per-binary loop never runs.
    respond = (cmd) => {
      if (!cmd.startsWith('command -v ')) return { output: '', exitCode: 1 };
      const bins = cmd.slice('command -v '.length).split(/\s+/);
      return { output: bins.map(b => `/usr/local/bin/${b}`).join('\n'), exitCode: 0 };
    };
    const results = await detectPeerAgents();
    expect(results).toHaveLength(PEER_AGENTS.length);
    // All resolved through the single batched call — none individually probed.
    expect(calls.some(c => c.startsWith('command -v claude '))).toBe(true);
    expect(calls.some(c => c === 'command -v claude')).toBe(false);
    expect(results.every(r => r.installed)).toBe(true);
  });

  it('marks found binaries as installed with their resolved path', async () => {
    respond = (c) => c.includes('claude')
      ? { output: '/usr/local/bin/claude\n', exitCode: 0 }
      : { output: '', exitCode: 1 };
    const results = await detectPeerAgents();
    const c = results.find(r => r.agent.id === 'claude')!;
    expect(c.installed).toBe(true);
    expect(c.path).toBe('/usr/local/bin/claude');
    expect(results.find(r => r.agent.id === 'pi')!.installed).toBe(false);
  });

  it('treats a "not found" message as absent even on a zero exit code', async () => {
    // Busybox and some minimal shells report missing binaries on stdout with a
    // zero status. Trusting the exit code alone would invent agents.
    respond = () => ({ output: 'claude: not found', exitCode: 0 });
    const results = await detectPeerAgents();
    expect(results.every(r => !r.installed)).toBe(true);
  });

  it('survives one probe throwing without losing the rest', async () => {
    // A probe that throws must not kill the batch or hide the other results.
    respond = (c) => {
      if (c.includes('opencode')) throw new Error('boom');
      if (!c.startsWith('command -v ')) return { output: '', exitCode: 1 };
      const bins = c.slice('command -v '.length).split(/\s+/);
      return { output: bins.filter(b => b === 'pi').map(b => '/bin/pi').join('\n'), exitCode: 0 };
    };
    const results = await detectPeerAgents();
    expect(results).toHaveLength(PEER_AGENTS.length);
    expect(results.find(r => r.agent.id === 'opencode')!.installed).toBe(false);
    expect(results.find(r => r.agent.id === 'pi')!.installed).toBe(true);
  });

  it('lists only what is installed', async () => {
    // Exact match on the probe — 'code' is a substring of 'opencode', so a loose
    // match here would silently report OpenCode as installed too.
    //
    // The batched probe answers one path per resolved binary across the whole
    // list, so the mock must do the same: only `code` resolves.
    respond = (c: string) => {
      if (!c.startsWith('command -v ')) return { output: '', exitCode: 1 };
      const bins = c.slice('command -v '.length).split(/\s+/);
      const lines = bins
        .filter(b => b === 'code')
        .map(b => '/usr/bin/code');
      return { output: lines.join('\n'), exitCode: lines.length ? 0 : 1 };
    };
    const found = installedAgents(await detectPeerAgents()).map(a => a.id);
    expect(found).toEqual(['vscode']);
  });

  it('survives a per-binary probe that the batch could not answer', async () => {
    // The batch can't always answer everything; when it can't, the per-binary
    // fallback runs and uses only probe forms that haven't already given a clean
    // answer.
    respond = (c: string) => {
      if (c.startsWith('command -v ')) {
        const bins = c.slice('command -v '.length).split(/\s+/);
        const hits = bins.filter(b => b === 'code');
        if (hits.length) return { output: '/usr/bin/code', exitCode: 0 };
        return { output: '', exitCode: 1 };
      }
      if (c.startsWith('where.exe ')) return { output: '', exitCode: 1 };
      return { output: '', exitCode: 1 };
    };
    const found = installedAgents(await detectPeerAgents()).map(a => a.id);
    expect(found).toEqual(['vscode']);
    // vscode was found by the batch (command -v with everything listed), but
    // only code resolves — vscode is the only installed one.
    expect(found).not.toContain('opencode');
  });
});

describe('verified non-interactive invocations', () => {
  /**
   * Every agent's `usage` string was checked against that tool's own docs:
   *   claude  → `claude -p`            (Claude Code CLI)
   *   opencode → `opencode run`        (opencode.ai/docs/cli)
   *   copilot → `copilot -p`           (docs.github.com copilot-cli)
   *   hermes  → `hermes chat -q`       (Hermes CLI reference)
   *   pi      → `pi -p`                (pi.dev / pi-coding-agent docs)
   *
   * Two of these were originally wrong, and both wrong in the expensive
   * direction: `hermes run` does not exist, and bare `pi "<prompt>"` launches
   * the interactive TUI and waits for a human rather than failing. A bare
   * interactive invocation is the worst case here — it does not error, it
   * simply hangs until the terminal timeout.
   */
  const EXPECTED: Record<string, string> = {
    claude: 'claude -p "<prompt>"',
    opencode: 'opencode run "<prompt>"',
    copilot: 'copilot -p "<prompt>"',
    hermes: 'hermes chat -q "<prompt>"',
    pi: 'pi -p "<prompt>"',
  };

  it('matches the documented flags for every agent', () => {
    for (const agent of PEER_AGENTS.filter(a => a.kind === 'agent')) {
      expect(agent.usage, `${agent.id} usage drifted from its documented CLI`)
        .toBe(EXPECTED[agent.id]);
    }
  });

  it('never invokes an agent without a non-interactive flag', () => {
    for (const agent of PEER_AGENTS.filter(a => a.kind === 'agent')) {
      const cmd = buildDelegateCommand(agent, 'do the thing');
      // `hermes chat`/`opencode run` carry the non-interactive form in the
      // subcommand; everything else must pass an explicit flag or it hangs.
      const nonInteractive = /\s(-p|--print|-q|--query|-z|run\s)/.test(cmd);
      expect(nonInteractive, `${agent.id} would hang: ${cmd}`).toBe(true);
    }
  });

  it('places the prompt after the flags, not before', () => {
    expect(buildDelegateCommand(PEER_AGENTS.find(a => a.id === 'pi')!, 'x'))
      .toBe(`pi -p 'x'`);
    expect(buildDelegateCommand(PEER_AGENTS.find(a => a.id === 'hermes')!, 'x'))
      .toBe(`hermes chat -q 'x'`);
  });
});

describe('shell quoting', () => {
  it('wraps in single quotes so the shell cannot reinterpret it', () => {
    expect(shellQuote('hello world')).toBe(`'hello world'`);
  });

  it('closes, escapes and reopens around an embedded quote', () => {
    expect(shellQuote(`a'b`)).toBe(`'a'\\''b'`);
  });

  it('rejects NUL, which cannot be represented in a shell argument', () => {
    expect(() => shellQuote('a\0b')).toThrow(/NUL/);
  });
});

describe('buildDelegateCommand', () => {
  it('substitutes the prompt as a single quoted argument', () => {
    const cmd = buildDelegateCommand(claude(), 'fix the failing test');
    expect(cmd).toBe(`claude -p 'fix the failing test'`);
  });

  it('keeps a multi-line prompt as one argument', () => {
    const cmd = buildDelegateCommand(claude(), 'line one\nline two');
    // One quoted run, so the shell passes both lines as a single argv entry.
    expect(cmd).toBe(`claude -p 'line one\nline two'`);
  });

  it('neutralises an injection attempt in the prompt', () => {
    const cmd = buildDelegateCommand(claude(), `'; touch /tmp/PWNED; echo '`);
    expect(cmd).toBe(`claude -p ''\\''; touch /tmp/PWNED; echo '\\'''`);
    // The dangerous text must live entirely inside the quoted run.
    expect(cmd.indexOf('touch')).toBeGreaterThan(cmd.indexOf(`'\\''`));
  });

  it('refuses an unknown agent rather than passing through a binary name', () => {
    expect(() => buildDelegateCommand({ ...claude(), id: 'rm', bin: 'rm' }, 'x'))
      .toThrow(/Unknown peer agent/);
  });

  it('refuses an empty prompt', () => {
    expect(() => buildDelegateCommand(claude(), '   ')).toThrow(/empty/);
  });

  it('uses the editor form for an editor', () => {
    const vscode = PEER_AGENTS.find(a => a.id === 'vscode')!;
    expect(buildDelegateCommand(vscode, '/repo')).toBe(`code '/repo'`);
  });
});

describe('delegateToAgent', () => {
  it('returns the agent output on success', async () => {
    respond = () => ({ output: 'done: 3 files changed', exitCode: 0 });
    const res = await delegateToAgent(claude(), 'do it');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('3 files changed');
  });

  it('reports failure with the exit code rather than pretending it worked', async () => {
    respond = () => ({ output: 'error: not authenticated', exitCode: 1 });
    const res = await delegateToAgent(claude(), 'do it');
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('not authenticated');
  });

  it('truncates a runaway build log instead of flooding the conversation', async () => {
    respond = () => ({ output: 'x'.repeat(MAX_DELEGATE_OUTPUT + 500), exitCode: 0 });
    const res = await delegateToAgent(claude(), 'do it');
    expect(res.output.length).toBeLessThan(MAX_DELEGATE_OUTPUT + 100);
    expect(res.output).toContain('truncated');
  });
});

describe('peerAgentPromptBlock', () => {
  it('is empty when nothing is installed — absence is the honest answer', () => {
    expect(peerAgentPromptBlock([{ agent: claude(), installed: false, path: null }])).toBe('');
  });

  it('lists only installed agents, with their ids and strengths', () => {
    const block = peerAgentPromptBlock([
      { agent: claude(), installed: true, path: '/usr/bin/claude' },
      { agent: PEER_AGENTS.find(a => a.id === 'pi')!, installed: false, path: null },
    ]);
    expect(block).toContain('`claude`');
    expect(block).toContain('/usr/bin/claude');
    expect(block).not.toContain('`pi`');
  });

  it('tells the model the prompt must be self-contained', () => {
    const block = peerAgentPromptBlock([{ agent: claude(), installed: true, path: '/usr/bin/claude' }]);
    expect(block).toMatch(/SELF-CONTAINED|self-contained/i);
  });

  it('separates editors from delegable agents', () => {
    const block = peerAgentPromptBlock([
      { agent: claude(), installed: true, path: '/usr/bin/claude' },
      { agent: PEER_AGENTS.find(a => a.id === 'vscode')!, installed: true, path: '/usr/bin/code' },
    ]);
    expect(block).toContain('Editors available');
    expect(block).toContain('`vscode`');
  });
});