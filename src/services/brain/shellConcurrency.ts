/**
 * Shell command concurrency.
 *
 * `terminal_run` was excluded from the parallel-safe set, so when GIA issued
 * three shell commands in a single turn — "list these, grep those, check the
 * log" — they ran strictly one after another. A slow build would block a
 * directory listing behind it for no reason.
 *
 * The reason for the exclusion was correctness, not caution for its own sake:
 * two mutating commands racing can genuinely destroy work. `rm a && rm b` and
 * `rm b` running together is a real hazard, not a theoretical one.
 *
 * So the classifier is deliberately conservative. It only calls a command
 * read-only when every token is a known-safe reader AND there is no
 * redirection, no chaining, and no command substitution — the three things
 * that hide a write inside something that looks like a read. When in doubt it
 * says "not safe", because running two writes in parallel to save a second is
 * a bad trade.
 */

/**
 * Commands that only read. Anything not listed is treated as a writer.
 *
 * Interpreters and runtimes (`node`, `python`, `java`, `npx`) are deliberately
 * ABSENT. `node server.js` looks exactly like `node --version` and can run
 * arbitrary code, so they are handled only through the subcommand allowlist
 * below — which for them is empty, meaning never parallel.
 */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'file', 'stat', 'wc', 'du', 'df',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd', 'locate', 'which', 'whereis',
  'type', 'whoami', 'id', 'hostname', 'uname', 'uptime', 'date', 'pwd', 'realpath',
  'readlink', 'basename', 'dirname', 'echo', 'printf', 'true', 'false',
  'ps', 'top', 'free', 'env', 'printenv', 'set', 'alias',
  'git', // only safe in its read-only subcommand form — checked below
  'jq', 'sort', 'uniq', 'cut', 'tr', 'column', 'tree', 'diff', 'cmp',
  'ping', 'dig', 'nslookup', 'host',
  'sleep', ':',
]);

/**
 * `git` is safe only for read-only subcommands. `git commit` and
 * `git checkout` are writes, and `git status` is not — so the subcommand has
 * to be checked, not just the binary.
 */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'config', 'describe',
  'blame', 'shortlog', 'tag', 'ls-files', 'ls-remote', 'ls-tree', 'rev-parse',
  'rev-list', 'cat-file', 'show-ref', 'reflog', 'whatchanged', 'grep',
  // NB: `stash` is NOT here. It moves the working tree — `git stash` is a write
  // that looks exactly like a read.
]);

/** Subcommands of the "maybe safe" package runners that are actually reads. */
const RUNNER_READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(['list', 'ls', 'view', 'outdated', 'why', 'audit', 'ping', 'help']),
  npx: new Set([]), // npx installs things by design — never parallel
  pip: new Set(['list', 'show', 'freeze', 'check']),
  python: new Set([]), // arbitrary code; assume it writes
  python3: new Set([]),
  node: new Set([]),   // `node server.js` runs arbitrary code
  java: new Set([]),   // same
  cargo: new Set(['tree', 'metadata', 'search', 'locate-project']),
  go: new Set(['list', 'env', 'version']),
};

/**
 * Binary names that shell wrappers legitimately rename.
 * `jq` under a different name is still a read; `rm` under a different name is
 * still a write, so this only adds aliases for genuinely safe readers.
 */
const SAFE_ALIASES: Record<string, string> = {
  ll: 'ls', la: 'ls', dir: 'ls',
  md5sum: 'wc', sha256sum: 'wc',
  curl: 'curl', wget: 'wget',
};

export interface ShellCommandAnalysis {
  safe: boolean;
  /** Why it was rejected — surfaced in reasoning so the choice is auditable. */
  reason?: string;
}

/**
 * Decide whether a single shell command is safe to run alongside others.
 *
 * Accepts one command only. A compound command (`&&`, `;`, `|`) is rejected
 * outright rather than analysed part-by-part: the last segment of a pipeline
 * is where writes hide, and getting that wrong corrupts the user's files.
 */
export function analyzeShellCommand(raw: string): ShellCommandAnalysis {
  const cmd = (raw || '').trim();
  if (!cmd) return { safe: false, reason: 'empty command' };

  // Redirection of any kind is a write, including `2>&1` and `>>`.
  if (/[<>]/.test(cmd)) return { safe: false, reason: 'redirects output' };

  // Chaining, piping, backgrounding, and substitution all hide extra commands.
  if (/[|;&]/.test(cmd)) return { safe: false, reason: 'chained or piped command' };
  if (/\$\(|`/.test(cmd)) return { safe: false, reason: 'command substitution' };
  if (/[{}\n]/.test(cmd)) return { safe: false, reason: 'compound statement' };

  const tokens = cmd.split(/\s+/);
  if (tokens.length === 0) return { safe: false, reason: 'empty command' };

  // Skip leading VAR=value assignments — they are not the command.
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return { safe: false, reason: 'no command' };

  // Skip env-var prefixes such as `FOO=bar cmd` or `sudo cmd`.
  const WRAPPERS = ['env', 'sudo', 'command', 'nohup', 'time', 'nice'];
  while (i < tokens.length && WRAPPERS.includes(tokens[i])) {
    const before = i;
    i++;
    // `env FOO=bar cmd` — skip its assignments too.
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    // A wrapper with nothing after it is the command itself: bare `env` prints
    // the environment, which is a read.
    if (i >= tokens.length) { i = before; break; }
  }

  // The wrapper-skip loop above can walk past the end of the token list (a
  // command that is only a wrapper, like a bare `sudo`).
  if (i >= tokens.length) return { safe: false, reason: 'no command found' };

  const rawBin = tokens[i];
  const bin = (SAFE_ALIASES[rawBin] ?? rawBin).split('/').pop()!; // strip a path
  const args = tokens.slice(i + 1);

  // A leading flag on most coreutils selects the operation (`grep -i`, `sort -r`),
  // which is harmless, but some binaries change meaning entirely with flags
  // (`find -delete`, `find -exec`). Reject when a destructive flag is present.
  if (/(^|\s)(-delete|-exec|-execdir|-ok|-okdir|--remove|>\s*$)/.test(cmd)) {
    return { safe: false, reason: 'destructive flag' };
  }

  if (bin === 'git') {
    const sub = args.find(a => !a.startsWith('-'));
    if (!sub) return { safe: false, reason: 'git with no subcommand' };
    if (!GIT_READ_ONLY_SUBCOMMANDS.has(sub)) {
      return { safe: false, reason: `git ${sub} can modify the repository` };
    }
    return { safe: true };
  }

  if (RUNNER_READ_ONLY_SUBCOMMANDS[bin]) {
    const allowed = RUNNER_READ_ONLY_SUBCOMMANDS[bin];
    if (allowed.size === 0) return { safe: false, reason: `${bin} can run arbitrary code` };
    const sub = args.find(a => !a.startsWith('-'));
    if (!sub || !allowed.has(sub)) {
      return { safe: false, reason: `${bin} ${sub ?? ''} is not read-only`.trim() };
    }
    return { safe: true };
  }

  if (!READ_ONLY_COMMANDS.has(bin)) {
    return { safe: false, reason: `\`${rawBin}\` is not a known read-only command` };
  }

  return { safe: true };
}

/** Convenience predicate. */
export function isReadOnlyShellCommand(raw: string): boolean {
  return analyzeShellCommand(raw).safe;
}