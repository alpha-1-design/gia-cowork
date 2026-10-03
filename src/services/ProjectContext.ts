import terminalService from './TerminalService';
import { logger } from '../utils/logger';

/**
 * Project context — the `/init` engine.
 *
 * GIA drives a real machine but starts every conversation knowing nothing
 * about the code in front of her. `/init` fixes that by reading the project
 * and writing an `AGENTS.md`: what it is, how it builds, how it tests, and the
 * conventions a newcomer would otherwise have to infer from a hundred files.
 *
 * The analysis is split from the I/O on purpose. Everything below the
 * `scanProject` boundary is a pure function over strings, so the interesting
 * part — what counts as a test runner, which file signals a React app, how a
 * language breakdown is summarised — is unit tested without a shell.
 */

// ── types ────────────────────────────────────────────────────────────────

export interface LanguageSlice {
  name: string;
  files: number;
  pct: number;
}

export interface ProjectProfile {
  root: string;
  name: string;
  isGitRepo: boolean;
  branch?: string;
  recentCommits: string[];
  /** Manifest files found at the root, e.g. package.json. */
  manifests: string[];
  languages: LanguageSlice[];
  packageManager: string;
  scripts: Record<string, string>;
  /** Non-script package.json deps worth knowing about. */
  dependencies: string[];
  devDependencies: string[];
  frameworks: string[];
  testCommand?: string;
  lintCommand?: string;
  buildCommand?: string;
  runCommand?: string;
  entryPoints: string[];
  sourceDirs: string[];
  configFiles: string[];
  readme?: string;
  /** Conventions inferred from structure — the part a newcomer would otherwise guess. */
  conventions: string[];
  /** Paths the scan actually read, for transparency. */
  inspected: string[];
  /** Top-level entries seen in the project root — used to reuse an existing context file. */
  topLevel: string[];
}

// ── pure analysis ────────────────────────────────────────────────────────

/** Extension → language label. Only entries we can act on; ignore the rest. */
const EXTENSION_LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.rs': 'Rust', '.go': 'Go', '.py': 'Python', '.rb': 'Ruby', '.java': 'Java',
  '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C', '.h': 'C', '.cc': 'C++',
  '.cpp': 'C++', '.hpp': 'C++', '.cs': 'C#', '.php': 'PHP', '.sh': 'Shell',
  '.bash': 'Shell', '.zsh': 'Shell', '.sql': 'SQL', '.dart': 'Dart', '.ex': 'Elixir',
  '.exs': 'Elixir', '.lua': 'Lua', '.scala': 'Scala', '.zig': 'Zig',
  '.vue': 'Vue', '.svelte': 'Svelte', '.css': 'CSS', '.scss': 'SCSS', '.less': 'Less',
};

const BINARY_OR_IGNORED = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg', 'woff', 'woff2', 'ttf', 'eot',
  'pdf', 'zip', 'gz', 'tar', 'mp3', 'mp4', 'mov', 'webm', 'lock', 'map', 'bin',
]);

/** Directories never worth counting toward a language breakdown. */
const IGNORED_PATH_PARTS = [
  'node_modules/', '.git/', 'dist/', 'build/', 'target/', 'out/', '.next/',
  'coverage/', '__pycache__/', 'vendor/', '.venv/', 'venv/', '.gradle/',
  'Pods/', '.idea/', '.vscode/', 'target/debug/', 'target/release/',
];

/**
 * Turn a file listing into a language breakdown by file count.
 *
 * Counted by files, not bytes or lines: a 12k-line generated bundle would
 * otherwise dominate a small project and make the summary actively misleading.
 * Files past `maxFiles` are dropped so a `node_modules` slip or a data dump
 * cannot skew the result.
 */
export function buildLanguageBreakdown(filePaths: string[], maxFiles = 4000): LanguageSlice[] {
  const counts = new Map<string, number>();
  let seen = 0;

  for (const raw of filePaths) {
    if (seen >= maxFiles) break;
    const path = raw.replace(/\\/g, '/');
    if (IGNORED_PATH_PARTS.some(part => path.includes(part))) continue;
    const base = path.slice(path.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    if (dot <= 0) continue; // dotfiles like .gitignore have no extension
    const ext = base.slice(dot).toLowerCase();
    if (BINARY_OR_IGNORED.has(ext.slice(1))) continue;
    const lang = EXTENSION_LANGUAGE[ext];
    if (!lang) continue;
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
    seen++;
  }

  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  return Array.from(counts.entries())
    .map(([name, files]) => ({ name, files, pct: total > 0 ? Math.round((files / total) * 100) : 0 }))
    .sort((a, b) => b.files - a.files);
}

/**
 * Pick a package manager from the lockfiles present.
 *
 * The lockfile is the source of truth rather than a preference setting: if
 * both npm and pnpm wrote a lockfile, whichever the project actually committed
 * is the one whose commands will reproduce the install.
 */
export function inferPackageManager(topLevel: string[]): string {
  const has = (f: string) => topLevel.includes(f);
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('package-lock.json')) return 'npm';
  if (has('Cargo.toml')) return 'cargo';
  if (has('go.mod')) return 'go';
  if (has('requirements.txt') || has('pyproject.toml')) return 'pip';
  if (has('Gemfile')) return 'bundle';
  return 'unknown';
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Parse package.json, returning an empty shape rather than throwing on bad JSON. */
export function parsePackageJson(raw: string): PackageJson {
  try {
    const parsed = JSON.parse(raw) as PackageJson;
    return {
      scripts: parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {},
      dependencies: parsed.dependencies ?? {},
      devDependencies: parsed.devDependencies ?? {},
    };
  } catch {
    return { scripts: {}, dependencies: {}, devDependencies: {} };
  }
}

/**
 * Detect the frameworks in play from dependency names.
 *
 * Returns labels rather than ids, because the point of the document is that a
 * human (or GIA on a cold start) reads "Next.js" and knows what to do.
 */
export function detectFrameworks(deps: Record<string, string>): string[] {
  const has = (...names: string[]) => names.some(n => n in deps);
  const found: string[] = [];

  if (has('next')) found.push('Next.js');
  if (has('nuxt')) found.push('Nuxt');
  if (has('@remix-run/react', '@remix-run/node')) found.push('Remix');
  if (has('astro')) found.push('Astro');
  if (has('svelte', '@sveltejs/kit')) found.push('Svelte');
  if (has('vue')) found.push('Vue');
  if (has('react')) found.push('React');
  if (has('@angular/core')) found.push('Angular');
  if (has('solid-js')) found.push('Solid');
  if (has('express')) found.push('Express');
  if (has('fastify')) found.push('Fastify');
  if (has('fastapi')) found.push('FastAPI');
  if (has('django')) found.push('Django');
  if (has('flask')) found.push('Flask');
  if (has('uvicorn', 'gunicorn')) found.push('ASGI/WSGI server');
  if (has('@nestjs/core')) found.push('NestJS');
  if (has('hono')) found.push('Hono');
  if (has('electron')) found.push('Electron');
  if (has('@tauri-apps/api')) found.push('Tauri');
  if (has('@capacitor/core')) found.push('Capacitor');
  if (has('react-native')) found.push('React Native');
  if (has('tailwindcss')) found.push('Tailwind CSS');
  if (has('prisma')) found.push('Prisma');
  if (has('drizzle-orm')) found.push('Drizzle ORM');
  if (has('mongoose')) found.push('Mongoose');
  if (has('pg', 'postgres', 'mysql2', 'better-sqlite3')) found.push('SQL database driver');
  if (has('socket.io', 'ws')) found.push('WebSockets');
  if (has('@modelcontextprotocol/sdk')) found.push('MCP');
  if (has('vite')) found.push('Vite');
  if (has('webpack')) found.push('webpack');
  if (has('eslint')) found.push('ESLint');
  if (has('prettier')) found.push('Prettier');

  return found;
}

/**
 * How the project runs its tests, as a command someone could paste.
 *
 * Returns an executable command rather than a description of one — this lands
 * in a table of runnable commands, and "test (package.json script)" in a
 * Commands column tells the reader nothing they could use.
 */
export function detectTestCommand(
  scripts: Record<string, string>,
  deps: Record<string, string>,
  packageManager = 'npm',
): string | undefined {
  if (scripts.test) return packageManager === 'npm' ? 'npm test' : `${packageManager} test`;
  if ('vitest' in deps) return 'npx vitest';
  if ('jest' in deps) return 'npx jest';
  if ('mocha' in deps) return 'npx mocha';
  if (scripts.pytest) return 'pytest';
  if (scripts.cargo) return 'cargo test';
  if (scripts.go) return 'go test ./...';
  return undefined;
}

/**
 * Work out the project's own conventions from its shape.
 *
 * This is the part worth the most to a cold-start agent, and the part no
 * manifest states outright — the source directory, the naming scheme, whether
 * there is a test suite to keep green, and whether strict types are on.
 */
export function deriveConventions(input: {
  topLevel: string[];
  scripts: Record<string, string>;
  tsconfig?: string;
  hasTests: boolean;
  languages: LanguageSlice[];
  packageManager: string;
}): string[] {
  const out: string[] = [];

  const srcDir = ['src', 'app', 'lib', 'packages'].find(d => input.topLevel.includes(d));
  if (srcDir) out.push(`Source lives in \`${srcDir}/\`. Match the existing module layout rather than adding a new top-level tree.`);

  if (input.hasTests) {
    const testFiles = ['test', 'tests', '__tests__', 'spec'].filter(d => input.topLevel.includes(d));
    out.push(testFiles.length
      ? `Tests live in \`${testFiles.join('/')}/\`. Add a test beside new logic — a change with no test will look incomplete.`
      : 'This project has tests colocated with source. Add one for any new logic.');
  } else {
    out.push('No test suite detected. If you add one, follow the runner already in `package.json`/manifests.');
  }

  if (input.languages.some(l => l.name === 'TypeScript')) {
    out.push('TypeScript. Match the strictness already in `tsconfig.json` — do not loosen compiler settings to make an error go away.');
  }

  if (input.scripts.build) out.push(`Build with \`${input.packageManager} run build\`. Do not hand-edit build output.`);
  if (input.scripts.lint) out.push(`Lint with \`${input.packageManager} run lint\`.`);
  if (input.scripts.typecheck || input.scripts['type-check']) {
    out.push(`Typecheck with \`${input.packageManager} run ${input.scripts.typecheck ? 'typecheck' : 'type-check'}\`. Run it before calling work done.`);
  }

  if (input.topLevel.includes('.github')) out.push('CI config is in `.github/` — read a workflow before assuming how something is run or released.');
  if (input.topLevel.includes('Dockerfile') || input.topLevel.includes('docker-compose.yml')) {
    out.push('Container config exists. Run dependencies the way the Dockerfile does rather than assuming host-installed versions.');
  }

  if (input.tsconfig?.includes('"strict": true')) {
    out.push('`strict` is on in tsconfig — handle undefined explicitly rather than casting it away.');
  }

  return out;
}

/** Candidate filenames for the context file, best first. */
export const CONTEXT_FILENAMES = ['AGENTS.md', 'GIA.md', 'CLAUDE.md', '.cursorrules'] as const;

/** If the project already has a context file, write to that one instead of adding a second. */
export function chooseContextFilename(topLevel: string[]): string {
  const existing = CONTEXT_FILENAMES.find(f => topLevel.includes(f));
  return existing ?? CONTEXT_FILENAMES[0];
}

/** Pick the entry points worth naming, preferring conventional locations. */
export function detectEntryPoints(topLevel: string[], filePaths: string[]): string[] {
  const candidates = [
    'src/main.ts', 'src/main.tsx', 'src/index.ts', 'src/index.tsx',
    'src/App.tsx', 'src/app.ts', 'index.js', 'index.ts', 'main.py', 'main.go',
    'src-tauri/src/lib.rs', 'src-tauri/src/main.rs', 'cmd/server/main.go',
  ];
  const present = new Set(filePaths.map(p => p.replace(/\\/g, '/').replace(/^\.\//, '')));
  const fromKnown = candidates.filter(c => present.has(c));
  if (fromKnown.length > 0) return fromKnown;

  // Fall back to whatever sits directly in a conventional source directory,
  // rather than guessing at a deep tree.
  return filePaths
    .map(p => p.replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(p => /^(src|app|lib|cmd)\/[A-Za-z0-9_.-]+\.[a-z]+$/.test(p))
    .slice(0, 5);
}

/**
 * The operating guidance section — what an agent should actually *do*.
 *
 * Kept separate from the detected facts on purpose. The facts section is what
 * the scanner found; this is the judgement the scanner cannot derive, and it
 * is the part that changes behaviour rather than just informing it.
 *
 * Markdown is used as the carrier format rather than because agents "prefer"
 * it — an agent reads whatever text is loaded into its prompt. The format earns
 * its place for the humans and the tools around it: it diffs cleanly in a PR,
 * renders in review, and other agents discover it by filename convention
 * (CLAUDE.md, .cursorrules, copilot-instructions.md).
 */
function renderGuidance(p: ProjectProfile): string[] {
  const L: string[] = [];
  const hasTests = p.conventions.some(c => c.startsWith('This project has tests'));
  const isTS = p.languages.some(l => l.name === 'TypeScript');
  const tsx = p.languages.some(l => l.name === 'TypeScript') && p.frameworks.some(f => /React|Vue|Svelte|Next|Nuxt|Angular/.test(f));

  L.push('## How to work in this project');
  L.push('');

  L.push('### Before you touch anything');
  L.push('');
  L.push('- **Read before you write.** Open the file and read it. Do not edit from a filename or a search hit alone — a match tells you the symbol exists, not how it is used.');
  L.push('- **Trace the call site.** A function you are about to change usually has callers you have not seen. Grep for the symbol and read at least the entry points that use it.');
  L.push('- **Read the test for the thing you are changing.** The test encodes what the behaviour is *supposed* to be, which is stronger than the current implementation.');
  if (p.entryPoints.length) {
    L.push(`- **Start at the entry point.** ${p.entryPoints.slice(0, 3).map(e => `\`${e}\``).join(', ')} — following real control flow beats reading files in alphabetical order.`);
  }
  L.push('');

  L.push('### While you work');
  L.push('');
  L.push('- **Smallest change that solves the problem.** Not the one you would write from scratch. Match the existing structure even where you would have done it differently.');
  L.push('- **Do not reformat code you were not asked to change.** Unrelated churn buries the real diff and makes review slower for everyone.');
  if (tsx) {
    L.push('- **This is a component codebase.** Keep state close to where it is used, lift it only when two components genuinely need the same value, and never duplicate props into a global store without a reason.');
  }
  if (isTS) {
    L.push('- **Make illegal states unrepresentable.** Prefer discriminated unions and narrow types over runtime checks scattered through the code.');
  }
  L.push('- **Handle the failure path, not just the happy path.** Empty state, loading, error, and "the thing you depend on is missing" are all real states.');
  L.push('');

  L.push('### Before you say you are done');
  L.push('');
  const checks = [
    p.testCommand ? `**\`${p.testCommand}\`** passes` : 'You exercised the change by running the thing',
    p.buildCommand ? `**\`${p.buildCommand}\`** succeeds` : null,
    p.lintCommand ? `**\`${p.lintCommand}\`** is clean` : null,
  ].filter(Boolean) as string[];
  for (const c of checks) L.push(`- ${c}`);
  L.push('- You actually looked at what changed — re-read your diff before reporting it.');
  L.push('- You did not leave a `TODO`, a stub, a hardcoded value, or an empty catch behind.');
  L.push('- If something is still broken, you said so. A truthful "this part is unfinished" beats a confident summary that hides it.');
  L.push('');

  L.push('### Do not');
  L.push('');
  L.push('- **Do not weaken a type, a lint rule, or a test to make something pass.** That converts a visible failure into an invisible one. Fix the cause, or say you could not.');
  L.push('- **Do not install packages or add dependencies** without being asked — it changes the project for everyone.');
  L.push('- **Do not commit, push, force-push, rewrite history, or delete branches** unless explicitly told to.');
  L.push('- **Do not delete or overwrite work you did not write** — including files that look stale or unused. Ask.');
  L.push('- **Do not guess at an API.** If you cannot verify it, use the tool that can, or say you are unsure.');
  L.push('- **Do not add a parallel abstraction** next to an existing one. Extend what is there unless replacing it was the task.');
  L.push('');

  L.push('### Look for these specifically');
  L.push('');
  L.push('- `TODO`, `FIXME`, `HACK`, and `XXX` comments near the area you are changing — they are usually unfinished work you should be aware of.');
  L.push('- Error handling that swallows failures (`catch {}`). It is usually hiding a bug someone gave up on.');
  if (isTS) L.push('- `any`, `@ts-ignore`, and unchecked casts. Each one is a place the compiler was told to stop looking.');
  if (p.isGitRepo) L.push('- `git log` on the file you are changing — it shows what went wrong before and what the last fix attempted.');
  L.push('- Tests that were skipped or commented out near your change.');
  L.push('');

  L.push('### When you are uncertain');
  L.push('');
  L.push('Say so and say what you would need to know. A wrong confident answer costs more than a question — it gets built on. Read the file, run the command, or ask.');
  L.push('');

  return L;
}

/**
 * Render the context document.
 *
 * Written for a reader with no memory of the project, so every claim has to be
 * checkable. Anything the scan could not determine is omitted rather than
 * guessed — a confidently wrong convention is worse than a missing one.
 */
export function renderContextMarkdown(p: ProjectProfile): string {
  const L: string[] = [];

  L.push(`# ${p.name}`);
  L.push('');
  L.push('_Generated by GIA Cowork `/init`. Re-run it after the project changes shape._');
  L.push('');

  L.push('## What this is');
  L.push('');
  // Anything under 1% rounds to "0%", which reads as "not present" and is
  // actively misleading in a project that does contain the language.
  const notable = p.languages.filter(l => l.pct >= 1).slice(0, 5);
  const langs = (notable.length > 0 ? notable : p.languages.slice(0, 3))
    .map(l => `${l.name} (${l.pct}%)`).join(', ');
  if (langs) L.push(`- **Languages:** ${langs}`);
  if (p.frameworks.length) L.push(`- **Stack:** ${p.frameworks.join(', ')}`);
  if (p.packageManager !== 'unknown') L.push(`- **Package manager:** ${p.packageManager}`);
  if (p.isGitRepo && p.branch) L.push(`- **Git:** branch \`${p.branch}\``);
  if (p.manifests.length) L.push(`- **Manifests:** ${p.manifests.map(m => `\`${m}\``).join(', ')}`);
  L.push('');

  if (p.scripts && Object.keys(p.scripts).length > 0) {
    L.push('## Commands');
    L.push('');
    L.push('| Task | Command |');
    L.push('| --- | --- |');
    const pm = p.packageManager === 'unknown' ? '' : `${p.packageManager} `;
    const named: Array<[string, string | undefined]> = [
      ['Install', p.manifests.includes('package.json') ? `${pm}install` : undefined],
      ['Run / dev', p.runCommand],
      ['Build', p.buildCommand],
      ['Test', p.testCommand],
      ['Lint', p.lintCommand],
    ];
    for (const [label, cmd] of named) {
      if (cmd) L.push(`| ${label} | \`${cmd}\` |`);
    }
    const extra = Object.entries(p.scripts).filter(([k]) => !['dev', 'build', 'test', 'lint', 'start'].includes(k));
    if (extra.length) {
      L.push('');
      L.push(`Other scripts: ${extra.map(([k, v]) => `\`${pm}run ${k}\``).join(', ')}`);
    }
    L.push('');
  }

  if (p.entryPoints.length) {
    L.push('## Where things start');
    L.push('');
    for (const e of p.entryPoints) L.push(`- \`${e}\``);
    L.push('');
  }

  if (p.conventions.length) {
    L.push('## Conventions');
    L.push('');
    for (const c of p.conventions) L.push(`- ${c}`);
    L.push('');
  }

  // The guidance section is the part that changes behaviour, not just informs.
  L.push(...renderGuidance(p));

  if (p.dependencies.length) {
    L.push('## Key dependencies');
    L.push('');
    L.push(`${p.dependencies.slice(0, 20).join(', ')}${p.devDependencies.length ? `\n\n_Dev:_ ${p.devDependencies.slice(0, 15).join(', ')}` : ''}`);
    L.push('');
  }

  if (p.recentCommits.length) {
    L.push('## Recent work');
    L.push('');
    for (const c of p.recentCommits) L.push(`- ${c}`);
    L.push('');
  }

  if (p.readme) {
    L.push('## From the README');
    L.push('');
    L.push(p.readme);
    L.push('');
  }

  L.push('## Working agreement');
  L.push('');
  L.push('_The detailed version of this is in "How to work in this project" above; this is the short form._');
  L.push('');
  L.push('- Read a file before editing it. Guessing at a codebase you have not read is how changes break.');
  L.push('- Match the style already there. Consistency beats personal preference in an unfamiliar repo.');
  if (p.testCommand || p.lintCommand) {
    // Only promise what this project actually has — telling an agent to run
    // a lint command the project does not have wastes a turn and erodes trust
    // in the rest of the document.
    const checks = [p.testCommand && `test`, p.lintCommand && `lint`].filter(Boolean).join(' and ');
    L.push(`- Run the ${checks} ${checks.includes(' and ') ? 'checks' : 'check'} above before reporting work as done.`);
  } else {
    L.push('- This project has no test or lint command to run. Verify changes by running the app.');
  }
  L.push('- Do not commit, push, or rewrite history unless asked.');
  L.push('');

  return L.join('\n');
}

// ── shell-driven scan ────────────────────────────────────────────────────

interface ExecResult {
  output: string;
  exitCode: number;
}

async function sh(command: string, workdir?: string, timeout = 20000): Promise<ExecResult> {
  const res = await terminalService.exec(command, workdir, undefined, timeout);
  return { output: res?.output ?? '', exitCode: res?.exitCode ?? -1 };
}

/** Parse `ls -A` output, ignoring the header noise some shells add. */
export function parseTopLevel(output: string): string[] {
  return output
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !/^total\b/i.test(l))
    .filter(l => !l.includes(':') || l.startsWith('.'));
}

/** Pull commit subjects out of `git log --oneline` output. */
export function parseGitLog(output: string, limit = 10): string[] {
  return output
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, limit);
}

const MANIFEST_FILES = [
  'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt',
  'setup.py', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile',
  'composer.json', 'Makefile', 'CMakeLists.txt', 'deno.json', 'mix.exs',
  'Package.swift', 'build.zig', 'pubspec.yaml',
];

const CONFIG_FILES = [
  'tsconfig.json', 'vite.config.ts', 'vite.config.js', 'next.config.js',
  'next.config.mjs', 'tailwind.config.js', 'tailwind.config.ts', '.eslintrc.json',
  'eslint.config.js', 'prettier.config.js', '.prettierrc', 'vitest.config.ts',
  'jest.config.js', 'Dockerfile', 'docker-compose.yml', '.env.example',
  'tauri.conf.json', 'capacitor.config.json',
];

/**
 * Scan a project directory and build a profile.
 *
 * Each probe is independent and tolerant of failure — a project without git,
 * without a lockfile, or without network access still produces a document
 * rather than an error.
 */
export async function scanProject(workdir?: string): Promise<ProjectProfile> {
  const inspected: string[] = [];

  const pwdRes = await sh('pwd', workdir);
  const root = (pwdRes.output.trim().split('\n')[0] || workdir || '.').trim();
  const name = root.split('/').filter(Boolean).pop() || 'project';

  const lsRes = await sh('ls -A 2>/dev/null', root);
  const topLevel = parseTopLevel(lsRes.output);

  const manifests = MANIFEST_FILES.filter(f => topLevel.includes(f));
  const configFiles = CONFIG_FILES.filter(f => topLevel.includes(f));

  // File listing: git's index is fast and excludes ignored files, so prefer it
  // and only fall back to a bounded find for non-repo directories.
  const gitCheck = await sh('git rev-parse --is-inside-work-tree 2>/dev/null', root);
  const isGitRepo = gitCheck.output.trim() === 'true';

  const listingRes = await sh(
    isGitRepo
      ? 'git ls-files 2>/dev/null | head -4000'
      : 'find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" 2>/dev/null | head -4000',
    root,
    25000,
  );
  const filePaths = listingRes.output.split('\n').map(l => l.trim()).filter(Boolean);
  const languages = buildLanguageBreakdown(filePaths);

  let branch: string | undefined;
  let recentCommits: string[] = [];
  if (isGitRepo) {
    const branchRes = await sh('git rev-parse --abbrev-ref HEAD 2>/dev/null', root);
    branch = branchRes.output.trim() || undefined;
    const logRes = await sh('git log --oneline -10 2>/dev/null', root);
    recentCommits = parseGitLog(logRes.output);
  }

  // Read the manifests that actually matter for commands and frameworks.
  let scripts: Record<string, string> = {};
  let deps: Record<string, string> = {};
  let devDeps: Record<string, string> = {};

  if (topLevel.includes('package.json')) {
    const pkgRes = await sh('cat package.json 2>/dev/null', root);
    if (pkgRes.exitCode === 0) {
      inspected.push('package.json');
      const pkg = parsePackageJson(pkgRes.output);
      scripts = pkg.scripts ?? {};
      deps = pkg.dependencies ?? {};
      devDeps = pkg.devDependencies ?? {};
    }
  }

  let tsconfig = '';
  if (topLevel.includes('tsconfig.json')) {
    const tsRes = await sh('cat tsconfig.json 2>/dev/null | head -80', root);
    if (tsRes.exitCode === 0) {
      inspected.push('tsconfig.json');
      tsconfig = tsRes.output;
    }
  }

  let readme: string | undefined;
  const readmeName = ['README.md', 'readme.md', 'README.MD', 'README'].find(f => topLevel.includes(f));
  if (readmeName) {
    const readmeRes = await sh(`head -60 ${JSON.stringify(readmeName)} 2>/dev/null`, root);
    if (readmeRes.exitCode === 0 && readmeRes.output.trim()) {
      inspected.push(readmeName);
      readme = readmeRes.output.trim();
    }
  }

  const packageManager = inferPackageManager(topLevel);
  const allDeps = { ...deps, ...devDeps };
  const hasTests = filePaths.some(f =>
    /(^|\/)(__tests__|tests?|spec)\//.test(f.replace(/\\/g, '/')) ||
    /\.(test|spec)\.[a-z]+$/.test(f),
  );

  const profile: ProjectProfile = {
    root,
    name,
    isGitRepo,
    branch,
    recentCommits,
    manifests,
    languages,
    packageManager,
    scripts,
    dependencies: Object.keys(deps),
    devDependencies: Object.keys(devDeps),
    frameworks: detectFrameworks(allDeps),
    testCommand: detectTestCommand(scripts, allDeps, packageManager),
    lintCommand: scripts.lint ? `${packageManager} run lint` : undefined,
    buildCommand: scripts.build ? `${packageManager} run build` : undefined,
    runCommand: scripts.dev ? `${packageManager} run dev` : scripts.start ? `${packageManager} run start` : undefined,
    entryPoints: detectEntryPoints(topLevel, filePaths),
    sourceDirs: ['src', 'app', 'lib', 'packages', 'server', 'api'].filter(d => topLevel.includes(d)),
    configFiles,
    readme,
    conventions: deriveConventions({ topLevel, scripts, tsconfig, hasTests, languages, packageManager }),
    inspected,
    topLevel,
  };

  logger.log(`[ProjectContext] Scanned ${root}: ${profile.languages.length} languages, ${profile.manifests.length} manifests`);
  return profile;
}

/** A one-screen summary for chat, since AGENTS.md is too long to paste. */
export function summarizeProfile(p: ProjectProfile): string {
  const L: string[] = [];
  const langs = p.languages.filter(l => l.pct >= 1).slice(0, 4).map(l => `${l.name} ${l.pct}%`).join(' · ');
  L.push(`**${p.name}** — ${langs || 'no recognised source files'}`);
  if (p.frameworks.length) L.push(`Stack: ${p.frameworks.slice(0, 8).join(', ')}`);
  if (p.packageManager !== 'unknown') L.push(`Tooling: ${p.packageManager}${p.isGitRepo ? ` · branch ${p.branch ?? '?'}` : ''}`);
  if (p.entryPoints.length) L.push(`Entry: ${p.entryPoints.slice(0, 3).join(', ')}`);
  L.push(`${p.languages.reduce((a, l) => a + l.files, 0)} source files analysed.`);
  return L.join('\n');
}