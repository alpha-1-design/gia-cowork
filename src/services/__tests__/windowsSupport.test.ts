import { describe, it, expect, afterEach } from 'vitest';
import { pathArgsOf } from '../projects/projectIsolation';
import {
  detectPeerAgents,
  probeCommands,
  shellQuote,
  setQuoteStyle,
  currentQuoteStyle,
  setShell,
  type ShellResult,
} from '../agents/peerAgents';

/**
 * Windows behaviour, without a Windows machine.
 *
 * The failures these guard against all fail *open*: an unmatched path, an
 * unrunnable probe, or a re-split command do not throw. They just quietly stop
 * enforcing the thing they were built to enforce, which is why they survived a
 * green suite in the first place.
 */

describe('the boundary gate sees Windows paths', () => {
  it('reads a drive-letter path out of a command', () => {
    // The gap: a POSIX-only pattern finds nothing here, so the gate reports
    // calm while enforcing nothing.
    expect(pathArgsOf({ command: 'Get-Content C:\\work\\beta\\secret.env' }))
      .toContain('C:\\work\\beta\\secret.env');
  });

  it('reads a forward-slash drive path too', () => {
    expect(pathArgsOf({ command: 'copy C:/work/beta/x /tmp/x' }))
      .toEqual(expect.arrayContaining(['C:/work/beta/x', '/tmp/x']));
  });

  it('reads a quoted drive path', () => {
    expect(pathArgsOf({ command: "cat 'C:\\work\\beta\\x'" })).toContain('C:\\work\\beta\\x');
  });

  it('reads a UNC path', () => {
    expect(pathArgsOf({ command: 'type \\\\build01\\share\\notes.txt' }))
      .toContain('\\\\build01\\share\\notes.txt');
  });

  it('still reads POSIX paths', () => {
    expect(pathArgsOf({ command: 'cat /work/beta/x' })).toEqual(['/work/beta/x']);
  });

  it('still ignores URLs', () => {
    expect(pathArgsOf({ command: 'curl https://example.com/work/beta/x' })).toEqual([]);
  });

  it('still ignores prose containing slashes', () => {
    expect(pathArgsOf({ command: 'echo see src/index.ts for details' })).toEqual([]);
  });

  it('reads a drive-letter path given as a direct argument', () => {
    // This worked before and must keep working: argument extraction is
    // format-agnostic, so only command scanning ever needed drive letters.
    expect(pathArgsOf({ path: 'C:\\work\\beta\\x.ts' })).toEqual(['C:\\work\\beta\\x.ts']);
  });

  it('does not let a subshell smuggle a path past the scan', () => {
    // `$(...)` is the injection shape the terminator exists for.
    const out = pathArgsOf({ command: 'echo $(cat /work/beta/x)' });
    for (const p of out) expect(p.endsWith(')')).toBe(false);
  });
});

describe('peer detection works on Windows', () => {
  it('offers both probe forms', () => {
    expect(probeCommands('claude')).toEqual(['command -v claude', 'where.exe claude']);
  });

  it('falls back to where.exe when command -v is not a PowerShell cmdlet', async () => {
    const seen: string[] = [];
    // Answers per binary, the way a real probe does. The earlier version of
    // this test returned the same claude path for *every* command, which
    // happened to pass against the old per-binary loop and hid the batching.
    const INSTALLED: Record<string, string> = { claude: 'C:\\Program Files\\Claude\\claude.exe' };
    const restore = setShell(async (cmd: string): Promise<ShellResult> => {
      seen.push(cmd);
      // PowerShell rejects `command -v`; only `where.exe` resolves.
      if (cmd.startsWith('command -v')) return { output: '', exitCode: 1 };
      const bins = cmd.replace(/^where\.exe\s+/, '').split(/\s+/);
      const lines = bins.filter(b => INSTALLED[b]).map(b => INSTALLED[b]);
      return lines.length
        ? { output: lines.join('\n'), exitCode: 0 }
        : { output: '', exitCode: 1 };
    });

    try {
      const results = await detectPeerAgents();
      expect(results.find(r => r.agent.bin === 'claude')).toMatchObject({
        installed: true,
        path: 'C:\\Program Files\\Claude\\claude.exe',
      });
      // Only claude exists, and the batched probe must have resolved it.
      expect(seen.some(c => c.startsWith('where.exe'))).toBe(true);
    } finally {
      restore();
    }
  });

  it('resolves every installed agent in one batched call per probe form', async () => {
    const seen: string[] = [];
    const INSTALLED: Record<string, string> = {
      claude: '/usr/local/bin/claude',
      opencode: '/usr/local/bin/opencode',
    };
    const restore = setShell(async (cmd: string): Promise<ShellResult> => {
      seen.push(cmd);
      if (cmd.startsWith('where.exe')) return { output: '', exitCode: 1 };
      const bins = cmd.replace(/^command -v\s+/, '').split(/\s+/);
      const lines = bins.filter(b => INSTALLED[b]).map(b => INSTALLED[b]);
      return lines.length
        ? { output: lines.join('\n'), exitCode: 0 }
        : { output: '', exitCode: 1 };
    });

    try {
      const results = await detectPeerAgents();
      // Both found binaries resolved by the single batched `command -v`.
      expect(results.find(r => r.agent.bin === 'claude')?.installed).toBe(true);
      expect(results.find(r => r.agent.bin === 'opencode')?.installed).toBe(true);
      // The batch already answered for these two, so they are never re-probed
      // one at a time. (The agents the batch could NOT find legitimately fall
      // through to individual probes, so `where.exe` may still appear for
      // them -- asserting its total absence here would be wrong.)
      expect(seen.some(c => c === 'command -v claude')).toBe(false);
      expect(seen.some(c => c === 'command -v opencode')).toBe(false);
      // The Windows form is not spent re-asking about a binary Unix already
      // resolved.
      expect(seen.some(c => c === 'where.exe claude')).toBe(false);
    } finally {
      restore();
    }
  });

  it('does not spawn a subprocess per agent when the batch answers for all', async () => {
    const seen: string[] = [];
    const restore = setShell(async (cmd: string): Promise<ShellResult> => {
      seen.push(cmd);
      const bins = cmd.replace(/^(command -v|where\.exe)\s+/, '').split(/\s+/);
      const lines = bins.map(b => `/usr/local/bin/${b}`);
      return { output: lines.join('\n'), exitCode: 0 };
    });

    try {
      await detectPeerAgents();
      // Six agents used to cost up to twelve spawns. All-present must now cost
      // exactly one, which is what stopped the app looking like it was running
      // background scripts on Windows.
      expect(seen.length).toBe(1);
    } finally {
      restore();
    }
  });

  it('reports missing agents as missing rather than throwing', async () => {
    const restore = setShell(async (): Promise<ShellResult> => ({ output: '', exitCode: 1 }));
    try {
      const results = await detectPeerAgents();
      expect(results.every(r => r.installed === false)).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('quoting matches the host shell', () => {
  const restorePosix = () => {};
  afterEach(() => { restorePosix(); });

  it('uses the POSIX idiom on Unix', () => {
    const restore = setQuoteStyle('posix');
    try {
      expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    } finally {
      restore();
    }
  });

  it('uses the PowerShell doubling idiom on Windows', () => {
    const restore = setQuoteStyle('powershell');
    try {
      expect(shellQuote("it's")).toBe(`'it''s'`);
    } finally {
      restore();
    }
  });

  it('quotes plain values identically on both shells', () => {
    const restoreA = setQuoteStyle('posix');
    const posix = shellQuote('refactor the auth module');
    restoreA();
    const restoreB = setQuoteStyle('powershell');
    const ps = shellQuote('refactor the auth module');
    restoreB();
    expect(posix).toBe(ps);
    expect(posix).toBe(`'refactor the auth module'`);
  });

  it('is inert for values with no quote in them', () => {
    const restore = setQuoteStyle('powershell');
    try {
      expect(currentQuoteStyle()).toBe('powershell');
      expect(shellQuote('plain value')).toBe(`'plain value'`);
    } finally {
      restore();
    }
  });

  it('still rejects NUL in either dialect', () => {
    const restore = setQuoteStyle('powershell');
    try {
      expect(() => shellQuote('a\0b')).toThrow(/NUL/);
    } finally {
      restore();
    }
  });

  it('restores the previous style', () => {
    const restore = setQuoteStyle('posix');
    setQuoteStyle('powershell');
    restore();
    expect(currentQuoteStyle()).toBe('posix');
  });
});