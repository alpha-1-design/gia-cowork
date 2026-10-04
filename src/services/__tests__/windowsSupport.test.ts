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
    const restore = setShell(async (cmd: string): Promise<ShellResult> => {
      seen.push(cmd);
      // PowerShell rejects `command -v` but resolves `where.exe`.
      if (cmd.startsWith('command -v')) return { output: '', exitCode: 1 };
      return { output: 'C:\\Program Files\\Claude\\claude.exe', exitCode: 0 };
    });

    try {
      const results = await detectPeerAgents();
      expect(results.find(r => r.agent.bin === 'claude')).toMatchObject({
        installed: true,
        path: 'C:\\Program Files\\Claude\\claude.exe',
      });
      expect(seen).toContain('where.exe claude');
    } finally {
      restore();
    }
  });

  it('does not run the second probe once the first succeeds', async () => {
    const seen: string[] = [];
    const restore = setShell(async (cmd: string): Promise<ShellResult> => {
      seen.push(cmd);
      return { output: '/usr/bin/claude', exitCode: 0 };
    });

    try {
      await detectPeerAgents();
      // No wasted subprocess on the platform where the first form works.
      expect(seen.some(c => c.startsWith('where.exe'))).toBe(false);
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