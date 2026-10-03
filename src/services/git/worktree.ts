import terminalService from '../TerminalService';

/**
 * Git worktrees, one per session.
 *
 * Claude's April 2026 desktop redesign listed "Git worktrees per session" as one
 * of seven surfaces, alongside its stated principle that *isolation must be
 * invisible*. That principle is the part worth stealing. Running two tasks on one
 * checkout is the failure everyone has hit: both agents write the same working
 * tree, `git status` shows the other's half-finished edits, a checkout or a
 * `git stash` from either task corrupts the other, and the user is left bisecting
 * which half of which change went where.
 *
 * A worktree gives each session its own checkout of the same repository at
 * `<repo>/.gia/worktrees/<slug>`. The `.gia/` directory is added to
 * `.git/info/exclude` rather than `.gitignore` deliberately: `info/exclude` is
 * local-only, so switching on worktree isolation never dirties a tracked file and
 * never shows up in a diff the user is about to commit.
 *
 * Everything here is TypeScript on top of the existing host terminal
 * (`terminal_exec` spawns a real shell on desktop, not a proot guest), so no new
 * native surface is required.
 *
 * NOTE ON VERIFICATION: the shell is injected via `setShell` so the git argument
 * construction and porcelain parsing are unit-tested without a repository. The
 * commands themselves have not been executed against a real repo in this
 * environment.
 */

export interface WorktreeInfo {
  /** Absolute path to the worktree checkout. */
  path: string;
  /** Branch checked out there. `null` when detached (e.g. a bare main). */
  branch: string | null;
  /** Commit SHA, when reported. */
  head: string | null;
  /** True for the repository's main checkout. */
  isPrimary: boolean;
  /** Git marks a worktree `locked` when it must not be pruned. */
  locked: boolean;
  /** Git reports `prunable` when the directory is gone but the metadata remains. */
  prunable: boolean;
  /** True for a bare repository (no working tree at all). */
  bare: boolean;
  /** Reason given for `prunable`, when present. */
  prunableReason?: string;
}

export interface ShellResult {
  output: string;
  exitCode: number;
}

/**
 * The seam. Everything goes through this rather than calling `terminalService`
 * directly so tests can drive real command strings and real porcelain output
 * without a git binary or a repository.
 */
export type Shell = (command: string, cwd?: string) => Promise<ShellResult>;

const defaultShell: Shell = async (command, cwd) => {
  const res = await terminalService.exec(command, cwd);
  return { output: res.output ?? '', exitCode: res.exitCode ?? -1 };
};

let shell: Shell = defaultShell;

/** Swap the command runner (tests). Returns a restore function. */
export function setShell(next: Shell): () => void {
  const prev = shell;
  shell = next;
  return () => { shell = prev; };
}

/**
 * Characters that must never reach a command line unquoted.
 *
 * Used only to *reject* obviously wrong input early, not as the quoting
 * mechanism — an allowlist was the first attempt here and it was wrong: real
 * branch names contain `/` (`gia/fix-login-1a2b`) and real paths contain `/`,
 * spaces and `~`, so an allowlist either throws on valid input or, once widened
 * to permit those, stops being an allowlist at all.
 */
const DANGEROUS = /[;&|`$(){}<>\\'"\n\r*?[\]!#]/;

/**
 * POSIX single-quote.
 *
 * Inside single quotes `sh` treats every character literally, so this is a
 * complete defence against injection. The one thing that cannot appear is a
 * single quote itself, which is why the string is closed, escaped, and reopened
 * — `'\''` is the standard idiom and is correct for every byte except NUL.
 *
 * The desktop backend spawns `sh -c` on Unix and `powershell -Command` on
 * Windows. PowerShell treats a single-quoted string the same way, so one
 * function is correct for both backends.
 */
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('Shell value contains a NUL byte');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Reject input that has no business being a path or branch component. */
export function assertSafeSegment(value: string, label: string): void {
  if (!value || DANGEROUS.test(value)) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
}

/**
 * Turn a session title into a branch-safe slug.
 *
 * Titles are user prose ("Fix the login redirect"), so they carry spaces,
 * capitals and punctuation. Branch names tolerate more than shell metacharacters,
 * so this slugs harder than strictly necessary — a branch you have to squint at
 * in `git branch` is a branch you will mis-type later.
 */
export function slugify(input: string, maxLen = 32): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return slug || 'session';
}

/** Short stable suffix so two sessions with the same title don't collide. */
export function shortHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 4);
}

export interface WorktreeTarget {
  /** Absolute path of the repository's main checkout. */
  repoRoot: string;
  /** Where the new worktree goes. */
  path: string;
  /** Branch the worktree will check out. */
  branch: string;
}

/** Deterministic, collision-free naming for a session's worktree. */
export function planWorktree(repoRoot: string, sessionId: string, title: string): WorktreeTarget {
  const name = `${slugify(title)}-${shortHash(sessionId)}`;
  assertSafeSegment(name, 'worktree name');
  return {
    repoRoot,
    // Stored as a plain path. Quoting happens at command-build time; baking
    // quotes into the value would make it wrong for every other consumer
    // (existence checks, display, comparison against `git worktree list`).
    path: `${repoRoot.replace(/[/\\]+$/, '')}/.gia/worktrees/${name}`,
    branch: `gia/${name}`,
  };
}

/**
 * Ask git for the repository root containing `cwd`.
 *
 * Returns `null` rather than throwing for "not a repository", because "you opened
 * a folder that is not a repo" is a normal state the UI should show as absent —
 * not an error worth a toast.
 */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  const res = await shell('git rev-parse --show-toplevel', cwd);
  if (res.exitCode !== 0) return null;
  const root = res.output.trim().split('\n')[0]?.trim();
  return root ? root : null;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const res = await shell('git rev-parse --is-inside-work-tree', cwd);
  return res.exitCode === 0 && res.output.trim() === 'true';
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * Porcelain is one attribute per line, records separated by a blank line. The
 * first record is the main checkout. Branch is absent when HEAD is detached,
 * which is why `branch` is nullable rather than defaulted — an agent that checked
 * out a commit to test something leaves a detached worktree behind, and treating
 * that as "no branch" is what lets it get pruned out from under you.
 */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> | null = null;

  const flush = () => {
    if (current && current.path) {
      out.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head ?? null,
        isPrimary: out.length === 0,
        locked: !!current.locked,
        prunable: !!current.prunable,
        bare: !!current.bare,
        prunableReason: current.prunableReason,
      });
    }
    current = null;
  };

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);

    switch (key) {
      case 'worktree': flush(); current = { path: value }; break;
      case 'HEAD': if (current) current.head = value; break;
      case 'branch': if (current) current.branch = value.replace(/^refs\/heads\//, ''); break;
      case 'bare': if (current) current.bare = true; break;
      case 'locked': if (current) current.locked = true; break;
      case 'prunable': if (current) { current.prunable = true; current.prunableReason = value || undefined; } break;
      default: break;
    }
  }
  flush();
  return out;
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const res = await shell('git worktree list --porcelain', repoRoot);
  if (res.exitCode !== 0) return [];
  return parseWorktreeList(res.output);
}

/**
 * Keep `.gia/` out of `git status` using the LOCAL exclude file.
 *
 * This is the whole reason isolation can be invisible: `.gitignore` is tracked,
 * so adding a line there produces a diff in the user's repository. `.git/info/
 * exclude` is per-clone and never committed.
 */
export async function excludeWorktreesFromStatus(repoRoot: string): Promise<void> {
  await shell('git config --local core.excludesFile .git/info/exclude', repoRoot);
  await shell(
    `mkdir -p .git/info && (grep -qxF '.gia/' .git/info/exclude 2>/dev/null || echo '.gia/' >> .git/info/exclude)`,
    repoRoot,
  );
}

export interface CreateResult {
  ok: boolean;
  target?: WorktreeTarget;
  /** Human-readable reason, suitable for display. */
  error?: string;
}

/**
 * Create a session's isolated worktree.
 *
 * Idempotent: if the worktree already exists, it is reused rather than rebuilt,
 * so switching back to a session does not throw away the edits in flight there.
 */
export async function createWorktree(
  repoRoot: string,
  sessionId: string,
  title: string,
): Promise<CreateResult> {
  const target = planWorktree(repoRoot, sessionId, title);

  const existing = await listWorktrees(repoRoot);
  const already = existing.find(w => w.path === target.path);
  if (already) return { ok: true, target };

  const branchTaken = existing.some(w => w.branch === target.branch);
  await excludeWorktreesFromStatus(repoRoot);

  const cmd = branchTaken
    ? `git worktree add --force ${shellQuote(target.path)}`
    : `git worktree add -b ${shellQuote(target.branch)} ${shellQuote(target.path)}`;

  const res = await shell(cmd, repoRoot);
  if (res.exitCode !== 0) {
    return { ok: false, target, error: res.output.trim() || 'git worktree add failed' };
  }
  return { ok: true, target };
}

export interface RemoveResult {
  ok: boolean;
  error?: string;
}

/**
 * Tear a session's worktree down.
 *
 * Two-step on purpose. `git worktree remove` refuses a worktree with uncommitted
 * changes — correctly, because that is the user's work. `--force` overwrites it.
 * So the default path tries the safe removal and surfaces the refusal, and force
 * has to be asked for explicitly by the caller.
 */
export async function removeWorktree(
  repoRoot: string,
  path: string,
  opts: { force?: boolean } = {},
): Promise<RemoveResult> {
  const res = await shell(
    `git worktree remove ${opts.force ? '--force ' : ''}${shellQuote(path)}`,
    repoRoot,
  );
  if (res.exitCode !== 0) {
    return { ok: false, error: res.output.trim() || 'git worktree remove failed' };
  }
  // Sweep metadata for directories deleted outside git (a common way these leak).
  await shell('git worktree prune', repoRoot);
  return { ok: true };
}

/** Every worktree GIA owns — i.e. everything under `.gia/worktrees`. */
export function giaWorktrees(all: WorktreeInfo[]): WorktreeInfo[] {
  return all.filter(w => !w.isPrimary && /[/\\]\.gia[/\\]worktrees[/\\]/.test(w.path));
}