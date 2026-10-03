import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseWorktreeList,
  planWorktree,
  slugify,
  shortHash,
  createWorktree,
  removeWorktree,
  giaWorktrees,
  isGitRepo,
  findRepoRoot,
  setShell,
  shellQuote,
  type ShellResult,
} from '../git/worktree';

/**
 * These tests drive real git porcelain text and assert on the real command
 * strings. The shell is injected, so nothing here needs a repository — but the
 * parsing and quoting under test are exactly what runs against a real one.
 */

const RUN = '/repo';

let calls: { cmd: string; cwd?: string }[] = [];
let responses: Record<string, ShellResult>;

const shell = vi.fn(async (cmd: string, cwd?: string): Promise<ShellResult> => {
  calls.push({ cmd, cwd });
  for (const [needle, res] of Object.entries(responses)) {
    if (cmd.includes(needle)) return res;
  }
  return { output: '', exitCode: 0 };
});

beforeEach(() => {
  calls = [];
  responses = {};
  shell.mockClear();
  setShell(shell);
});

describe('parseWorktreeList', () => {
  it('parses the porcelain format including detached and prunable records', () => {
    const out = `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo/.gia/worktrees/fix-login-1a2b
HEAD def456
branch refs/heads/gia/fix-login-1a2b

worktree /repo/.gia/worktrees/detached
HEAD 789abc

worktree /repo/.gia/worktrees/gone
HEAD 000000
prunable gitdir file points to non-existent location
`;
    const list = parseWorktreeList(out);
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({ path: '/repo', branch: 'main', isPrimary: true, head: 'abc123' });
    expect(list[1]).toMatchObject({ branch: 'gia/fix-login-1a2b', isPrimary: false, head: 'def456' });
    // Detached HEAD has no `branch` line at all — must not become "main".
    expect(list[2].branch).toBeNull();
    expect(list[2].head).toBe('789abc');
    expect(list[3].prunable).toBe(true);
    expect(list[3].prunableReason).toContain('non-existent');
  });

  it('marks the first record as primary regardless of path', () => {
    const list = parseWorktreeList('worktree /elsewhere\nHEAD a\n');
    expect(list[0].isPrimary).toBe(true);
  });

  it('handles locked and bare markers', () => {
    const list = parseWorktreeList('worktree /repo\nbare\nlocked reason here\n');
    expect(list[0].bare).toBe(true);
    expect(list[0].locked).toBe(true);
  });

  it('returns nothing for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('naming', () => {
  it('slugifies prose into a branch-safe name', () => {
    expect(slugify('Fix the login redirect!')).toBe('fix-the-login-redirect');
    expect(slugify('   ')).toBe('session');
    expect(slugify('a'.repeat(80))).toHaveLength(32);
  });

  it('strips trailing dashes after truncation', () => {
    expect(slugify('abcdefghij'.repeat(5)).endsWith('-')).toBe(false);
  });

  it('gives two sessions with the same title different worktrees', () => {
    const a = planWorktree('/repo', 's1', 'Fix login');
    const b = planWorktree('/repo', 's2', 'Fix login');
    expect(a.branch).not.toBe(b.branch);
    expect(a.path).not.toBe(b.path);
  });

  it('is stable for the same session', () => {
    expect(planWorktree('/repo', 's1', 'Fix login')).toEqual(planWorktree('/repo', 's1', 'Fix login'));
  });

  it('places worktrees under .gia/worktrees and normalizes the repo root', () => {
    const p = planWorktree('/repo/', 's1', 'x');
    expect(p.path.startsWith('/repo/.gia/worktrees/x-')).toBe(true);
    expect(p.branch.startsWith('gia/x-')).toBe(true);
  });

  it('produces shell-safe names even from hostile titles', () => {
    const p = planWorktree('/repo', 's1', '../../etc; rm -rf /');
    expect(p.path).not.toContain('..');
    expect(p.path).not.toContain(';');
    expect(p.branch).not.toContain('rm -rf');
  });

  it('shortHash is stable and non-negative', () => {
    expect(shortHash('abc')).toBe(shortHash('abc'));
    expect(shortHash('abc')).not.toBe(shortHash('abd'));
    expect(shortHash('abc')).toMatch(/^[0-9a-z]+$/);
  });
});

describe('createWorktree', () => {
  it('creates a branch and worktree, and excludes .gia locally', async () => {
    responses['worktree list'] = { output: 'worktree /repo\nHEAD a\nbranch refs/heads/main\n', exitCode: 0 };
    const res = await createWorktree(RUN, 's1', 'Fix login');
    expect(res.ok).toBe(true);

    const created = calls.find(c => c.cmd.includes('git worktree add'));
    expect(created!.cmd).toMatch(/^git worktree add -b 'gia\/fix-login-[a-z0-9]+' /);
    expect(created!.cwd).toBe(RUN);

    // Local exclude, never .gitignore — that would dirty a tracked file.
    expect(calls.some(c => c.cmd.includes('info/exclude'))).toBe(true);
    expect(calls.some(c => c.cmd.includes('.gitignore'))).toBe(false);
  });

  it('is idempotent and does not rebuild an existing worktree', async () => {
    const plan = planWorktree(RUN, 's1', 'Fix login');
    responses['worktree list'] = {
      output: `worktree /repo\nHEAD a\nbranch refs/heads/main\n\nworktree ${plan.path}\nHEAD b\nbranch refs/heads/${plan.branch}\n`,
      exitCode: 0,
    };
    const res = await createWorktree(RUN, 's1', 'Fix login');
    expect(res.ok).toBe(true);
    expect(calls.some(c => c.cmd.includes('git worktree add'))).toBe(false);
  });

  it('does not re-create a branch that already exists', async () => {
    const plan = planWorktree(RUN, 's1', 'Fix login');
    responses['worktree list'] = {
      output: `worktree /repo\nHEAD a\nbranch refs/heads/main\n\nworktree /other\nHEAD b\nbranch refs/heads/${plan.branch}\n`,
      exitCode: 0,
    };
    const res = await createWorktree(RUN, 's1', 'Fix login');
    expect(res.ok).toBe(true);
    const add = calls.find(c => c.cmd.includes('git worktree add'))!;
    expect(add.cmd).not.toContain('-b');
    expect(add.cmd).toContain('--force');
  });

  it('reports the failure reason from git', async () => {
    responses['worktree list'] = { output: '', exitCode: 0 };
    responses['git worktree add'] = { output: 'fatal: invalid reference', exitCode: 128 };
    const res = await createWorktree(RUN, 's1', 'Fix login');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('invalid reference');
  });
});

describe('removeWorktree', () => {
  it('does not force by default, so uncommitted work is protected', async () => {
    responses['git worktree remove'] = { output: 'contains modified or untracked files', exitCode: 1 };
    const res = await removeWorktree(RUN, '/repo/.gia/worktrees/x');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('modified');

    const cmd = calls.find(c => c.cmd.includes('git worktree remove'))!;
    expect(cmd.cmd).not.toContain('--force');
    // A refused removal must not be followed by prune.
    expect(calls.some(c => c.cmd.includes('prune'))).toBe(false);
  });

  it('forces only when asked, then prunes', async () => {
    responses['git worktree remove'] = { output: '', exitCode: 0 };
    const res = await removeWorktree(RUN, '/repo/.gia/worktrees/x', { force: true });
    expect(res.ok).toBe(true);
    expect(calls.find(c => c.cmd.includes('git worktree remove'))!.cmd).toContain('--force');
    expect(calls.some(c => c.cmd.includes('git worktree prune'))).toBe(true);
  });

  it('quotes an injected path instead of letting it run', async () => {
    responses['git worktree remove'] = { output: '', exitCode: 0 };
    await removeWorktree(RUN, "/repo/x'; rm -rf /; echo '");
    const cmd = calls.find(c => c.cmd.includes('git worktree remove'))!;
    // The whole payload sits inside one quoted run: every single quote closes,
    // escapes and reopens, so `sh` never sees an unquoted semicolon.
    expect(cmd.cmd).toBe(`git worktree remove '/repo/x'\\''; rm -rf /; echo '\\'''`);
  });

  it('rejects a NUL byte, which cannot be quoted at all', () => {
    expect(() => shellQuote('a\0b')).toThrow(/NUL/);
  });

  it('quotes a plain path without altering it', () => {
    expect(shellQuote('/repo/.gia/worktrees/x-1a2b')).toBe(`'/repo/.gia/worktrees/x-1a2b'`);
  });
});

describe('repo detection', () => {
  it('returns the root', async () => {
    responses['--show-toplevel'] = { output: '/repo\n', exitCode: 0 };
    expect(await findRepoRoot(RUN)).toBe('/repo');
  });

  it('returns null instead of throwing when not a repo', async () => {
    responses['--show-toplevel'] = { output: 'not a git repository', exitCode: 128 };
    expect(await findRepoRoot(RUN)).toBeNull();
  });

  it('detects a work tree', async () => {
    responses['--is-inside-work-tree'] = { output: 'true\n', exitCode: 0 };
    expect(await isGitRepo(RUN)).toBe(true);
    responses['--is-inside-work-tree'] = { output: '', exitCode: 128 };
    expect(await isGitRepo(RUN)).toBe(false);
  });
});

describe('giaWorktrees', () => {
  it('selects only worktrees under .gia/worktrees', () => {
    const all = parseWorktreeList(`worktree /repo
HEAD a
branch refs/heads/main

worktree /repo/.gia/worktrees/x
HEAD b

worktree /elsewhere/manual
HEAD c
`);
    expect(giaWorktrees(all).map(w => w.path)).toEqual(['/repo/.gia/worktrees/x']);
  });
});