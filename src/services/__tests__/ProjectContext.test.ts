import { describe, it, expect } from 'vitest';
import {
  buildLanguageBreakdown,
  inferPackageManager,
  parsePackageJson,
  detectFrameworks,
  detectTestCommand,
  deriveConventions,
  chooseContextFilename,
  detectEntryPoints,
  parseTopLevel,
  parseGitLog,
  renderContextMarkdown,
  summarizeProfile,
  type ProjectProfile,
} from '../ProjectContext';
import { getInjectedContext, MAX_INJECTED_CHARS, type ProjectContextEntry } from '../../store/useProjectContextStore';

const baseProfile: ProjectProfile = {
  root: '/home/dev/app',
  name: 'app',
  isGitRepo: true,
  branch: 'main',
  recentCommits: ['a1b2c3d add login'],
  manifests: ['package.json'],
  languages: [{ name: 'TypeScript', files: 40, pct: 80 }, { name: 'CSS', files: 10, pct: 20 }],
  packageManager: 'npm',
  scripts: { dev: 'vite', build: 'tsc && vite build', test: 'vitest', lint: 'eslint .' },
  dependencies: ['react', 'vite'],
  devDependencies: ['typescript'],
  frameworks: ['React', 'Vite'],
  testCommand: 'npm test',
  lintCommand: 'npm run lint',
  buildCommand: 'npm run build',
  runCommand: 'npm run dev',
  entryPoints: ['src/main.tsx'],
  sourceDirs: ['src'],
  configFiles: ['tsconfig.json'],
  conventions: ['Source lives in `src/`.'],
  inspected: ['package.json'],
  topLevel: ['src', 'package.json'],
};

describe('buildLanguageBreakdown', () => {
  it('counts files per language and computes percentages', () => {
    const files = ['a.ts', 'b.ts', 'c.tsx', 'd.css'];
    const result = buildLanguageBreakdown(files);
    expect(result).toEqual([
      { name: 'TypeScript', files: 3, pct: 75 },
      { name: 'CSS', files: 1, pct: 25 },
    ]);
  });

  it('ignores dependency and build directories', () => {
    const files = [
      'src/app.ts',
      'node_modules/react/index.js',
      'node_modules/lib/x.js',
      'dist/bundle.js',
      '.git/hooks/pre-commit.sh',
      'coverage/report.json',
    ];
    const result = buildLanguageBreakdown(files);
    expect(result).toEqual([{ name: 'TypeScript', files: 1, pct: 100 }]);
  });

  it('ignores binary assets and lockfiles', () => {
    const files = ['logo.png', 'app.js', 'package-lock.json', 'font.woff2', 'data.zip'];
    expect(buildLanguageBreakdown(files)).toEqual([{ name: 'JavaScript', files: 1, pct: 100 }]);
  });

  it('ignores dotfiles, which have no extension', () => {
    expect(buildLanguageBreakdown(['.gitignore', '.eslintrc.json', 'main.py'])).toEqual([
      { name: 'Python', files: 1, pct: 100 },
    ]);
  });

  it('caps the scan so a huge repo cannot produce a useless breakdown', () => {
    const files = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts`);
    const result = buildLanguageBreakdown(files, 10);
    expect(result[0].files).toBe(10);
  });

  it('returns an empty breakdown rather than dividing by zero', () => {
    expect(buildLanguageBreakdown([])).toEqual([]);
    expect(buildLanguageBreakdown(['logo.png'])).toEqual([]);
  });

  it('handles Windows-style separators', () => {
    expect(buildLanguageBreakdown(['src\\app.tsx'])).toEqual([{ name: 'TypeScript', files: 1, pct: 100 }]);
  });
});

describe('inferPackageManager', () => {
  it('prefers the lockfile that is actually committed', () => {
    expect(inferPackageManager(['package.json', 'bun.lock'])).toBe('bun');
    expect(inferPackageManager(['package.json', 'pnpm-lock.yaml'])).toBe('pnpm');
    expect(inferPackageManager(['package.json', 'yarn.lock'])).toBe('yarn');
    expect(inferPackageManager(['package.json', 'package-lock.json'])).toBe('npm');
  });

  it('respects lockfile priority over filename order', () => {
    // npm listed first, but bun's lockfile is the committed one.
    expect(inferPackageManager(['package-lock.json', 'bun.lockb'])).toBe('bun');
  });

  it('falls back to non-npm ecosystems', () => {
    expect(inferPackageManager(['Cargo.toml'])).toBe('cargo');
    expect(inferPackageManager(['go.mod'])).toBe('go');
    expect(inferPackageManager(['pyproject.toml'])).toBe('pip');
  });

  it('reports unknown when there is nothing to go on', () => {
    expect(inferPackageManager(['README.md'])).toBe('unknown');
  });
});

describe('parsePackageJson', () => {
  it('extracts scripts and dependencies', () => {
    const pkg = parsePackageJson('{"scripts":{"dev":"vite"},"dependencies":{"react":"^19"},"devDependencies":{"vitest":"^3"}}');
    expect(pkg.scripts).toEqual({ dev: 'vite' });
    expect(pkg.dependencies).toEqual({ react: '^19' });
    expect(pkg.devDependencies).toEqual({ vitest: '^3' });
  });

  it('returns empty shapes for malformed JSON rather than throwing', () => {
    // A truncated package.json must not abort the whole scan.
    expect(parsePackageJson('{ "scripts": ')).toEqual({ scripts: {}, dependencies: {}, devDependencies: {} });
  });

  it('tolerates a package.json with no scripts', () => {
    expect(parsePackageJson('{}')).toEqual({ scripts: {}, dependencies: {}, devDependencies: {} });
  });
});

describe('detectFrameworks', () => {
  it('identifies a React + Vite app', () => {
    const f = detectFrameworks({ react: '^19', vite: '^7' });
    expect(f).toContain('React');
    expect(f).toContain('Vite');
  });

  it('identifies a Tauri desktop app', () => {
    expect(detectFrameworks({ '@tauri-apps/api': '^2', react: '^19' })).toContain('Tauri');
  });

  it('identifies a Python web stack', () => {
    const f = detectFrameworks({ fastapi: '0.1', prisma: '5', pg: '8' });
    expect(f).toContain('FastAPI');
    expect(f).toContain('Prisma');
    expect(f).toContain('SQL database driver');
  });

  it('identifies a Django or Flask app', () => {
    expect(detectFrameworks({ django: '5' })).toContain('Django');
    expect(detectFrameworks({ flask: '3' })).toContain('Flask');
  });

  it('identifies MCP support', () => {
    expect(detectFrameworks({ '@modelcontextprotocol/sdk': '1.0' })).toContain('MCP');
  });

  it('returns nothing for a project with no recognisable stack', () => {
    expect(detectFrameworks({ lodash: '4' })).toEqual([]);
  });
});

describe('detectTestCommand', () => {
  it('prefers the declared script and returns a runnable command', () => {
    // The old version returned the label "test (package.json script)", which
    // is useless in a table of commands someone might paste.
    expect(detectTestCommand({ test: 'vitest' }, { vitest: '3' })).toBe('npm test');
    expect(detectTestCommand({ test: 'vitest' }, {}, 'pnpm')).toBe('pnpm test');
  });

  it('falls back to detecting the runner in dependencies', () => {
    expect(detectTestCommand({}, { vitest: '3' })).toBe('npx vitest');
    expect(detectTestCommand({}, { jest: '29' })).toBe('npx jest');
  });

  it('handles non-npm ecosystems', () => {
    expect(detectTestCommand({ cargo: 'test' }, {})).toBe('cargo test');
    expect(detectTestCommand({ go: 'test' }, {})).toBe('go test ./...');
  });

  it('reports nothing when there is no test setup', () => {
    expect(detectTestCommand({}, {})).toBeUndefined();
  });
});

describe('deriveConventions', () => {
  it('points at the source directory', () => {
    const c = deriveConventions({ topLevel: ['src'], scripts: {}, hasTests: false, languages: [], packageManager: 'npm' });
    expect(c.join(' ')).toContain('`src/`');
  });

  it('tells the agent to add tests when a suite exists', () => {
    const c = deriveConventions({ topLevel: ['tests', 'src'], scripts: {}, hasTests: true, languages: [], packageManager: 'npm' });
    expect(c.join(' ')).toContain('Add a test');
  });

  it('flags TypeScript projects', () => {
    const c = deriveConventions({
      topLevel: [], scripts: {}, hasTests: false,
      languages: [{ name: 'TypeScript', files: 5, pct: 100 }], packageManager: 'npm',
    });
    expect(c.join(' ')).toContain('TypeScript');
  });

  it('mentions the build and lint commands', () => {
    const c = deriveConventions({
      topLevel: [], scripts: { build: 'tsc', lint: 'eslint', typecheck: 'tsc --noEmit' },
      hasTests: false, languages: [], packageManager: 'npm',
    });
    const text = c.join(' ');
    expect(text).toContain('npm run build');
    expect(text).toContain('npm run lint');
    expect(text).toContain('npm run typecheck');
  });

  it('warns against loosening tsconfig when strict is on', () => {
    const c = deriveConventions({
      topLevel: [], scripts: {}, hasTests: false, languages: [],
      packageManager: 'npm', tsconfig: '{ "compilerOptions": { "strict": true } }',
    });
    expect(c.join(' ')).toContain('strict');
  });

  it('warns against changing compiler settings generally for TS projects', () => {
    const c = deriveConventions({
      topLevel: [], scripts: {}, hasTests: false,
      languages: [{ name: 'TypeScript', files: 1, pct: 100 }], packageManager: 'npm',
    });
    expect(c.join(' ')).toContain('do not loosen compiler settings');
  });

  it('notes CI config when present', () => {
    const c = deriveConventions({ topLevel: ['.github'], scripts: {}, hasTests: false, languages: [], packageManager: 'npm' });
    expect(c.join(' ')).toContain('.github');
  });

  it('never claims a test suite exists when there is none', () => {
    const c = deriveConventions({ topLevel: [], scripts: {}, hasTests: false, languages: [], packageManager: 'npm' });
    expect(c.join(' ')).toContain('No test suite detected');
  });
});

describe('chooseContextFilename', () => {
  it('defaults to AGENTS.md', () => {
    expect(chooseContextFilename(['src', 'package.json'])).toBe('AGENTS.md');
  });

  it('reuses an existing context file instead of adding a second one', () => {
    expect(chooseContextFilename(['CLAUDE.md', 'src'])).toBe('CLAUDE.md');
    expect(chooseContextFilename(['.cursorrules'])).toBe('.cursorrules');
  });

  it('prefers AGENTS.md when several exist', () => {
    expect(chooseContextFilename(['CLAUDE.md', 'AGENTS.md'])).toBe('AGENTS.md');
  });
});

describe('detectEntryPoints', () => {
  it('finds conventional entry points', () => {
    const files = ['src/main.tsx', 'src/App.tsx', 'src/utils/x.ts'];
    expect(detectEntryPoints(['src'], files)).toEqual(['src/main.tsx', 'src/App.tsx']);
  });

  it('finds a Tauri or Rust entry point', () => {
    expect(detectEntryPoints([], ['src-tauri/src/lib.rs'])).toEqual(['src-tauri/src/lib.rs']);
  });

  it('strips the leading ./ that find and git ls-files differ on', () => {
    expect(detectEntryPoints([], ['./src/index.ts'])).toEqual(['src/index.ts']);
  });

  it('falls back to top-level files in a source directory', () => {
    const files = ['src/server.ts', 'src/util.ts', 'src/deep/nested/thing.ts'];
    expect(detectEntryPoints(['src'], files)).toEqual(['src/server.ts', 'src/util.ts']);
  });

  it('returns nothing rather than a wild guess', () => {
    expect(detectEntryPoints([], ['a/b/c/d.ts'])).toEqual([]);
  });
});

describe('parseTopLevel', () => {
  it('parses ls output', () => {
    expect(parseTopLevel('src\npackage.json\nREADME.md\n')).toEqual(['src', 'package.json', 'README.md']);
  });

  it('drops the total line some shells emit', () => {
    expect(parseTopLevel('total 12\nsrc\npackage.json')).toEqual(['src', 'package.json']);
  });

  it('handles an empty directory', () => {
    expect(parseTopLevel('')).toEqual([]);
  });
});

describe('parseGitLog', () => {
  it('parses oneline log output and respects the limit', () => {
    const out = Array.from({ length: 15 }, (_, i) => `abc${i} commit ${i}`).join('\n');
    const parsed = parseGitLog(out, 3);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toBe('abc0 commit 0');
  });

  it('returns empty for a repo with no commits', () => {
    expect(parseGitLog('')).toEqual([]);
  });
});

describe('renderContextMarkdown', () => {
  const md = renderContextMarkdown(baseProfile);

  it('names the project and its languages', () => {
    expect(md).toContain('# app');
    expect(md).toContain('TypeScript (80%)');
  });

  it('drops languages that round to 0%, which reads as absent', () => {
    const withTrace = renderContextMarkdown({
      ...baseProfile,
      languages: [{ name: 'TypeScript', files: 578, pct: 99 }, { name: 'CSS', files: 2, pct: 0 }],
    });
    expect(withTrace).toContain('TypeScript (99%)');
    // "CSS (0%)" would imply the project has no CSS.
    expect(withTrace).not.toContain('(0%)');
  });

  it('lists the runnable commands', () => {
    expect(md).toContain('npm run dev');
    expect(md).toContain('npm run build');
    expect(md).toContain('npm run lint');
    expect(md).toContain('npm test');
    // Never a description where a pasteable command belongs.
    expect(md).not.toContain('package.json script');
  });

  it('names the entry points and conventions', () => {
    expect(md).toContain('src/main.tsx');
    expect(md).toContain('Source lives in `src/`');
  });

  it('includes recent commits when there are any', () => {
    expect(md).toContain('a1b2c3d add login');
  });

  it('states the working agreement', () => {
    expect(md).toContain('Do not commit, push, or rewrite history unless asked.');
    expect(md).toContain('Read a file before editing it');
  });

  it('does not promise a lint run in a project with no lint command', () => {
    const noLint = renderContextMarkdown({ ...baseProfile, lintCommand: undefined });
    expect(noLint).toContain('Run the test check above');
    expect(noLint).not.toContain('test and lint');
  });

  it('does not promise checks in a project with neither test nor lint', () => {
    const none = renderContextMarkdown({ ...baseProfile, lintCommand: undefined, testCommand: undefined });
    expect(none).toContain('no test or lint command');
  });

  it('omits sections it has no data for rather than printing empty ones', () => {
    const sparse = renderContextMarkdown({
      ...baseProfile, scripts: {}, recentCommits: [], readme: undefined,
      entryPoints: [], dependencies: [], devDependencies: [], frameworks: [],
    });
    expect(sparse).not.toContain('## Commands');
    expect(sparse).not.toContain('## Recent work');
    expect(sparse).not.toContain('## Key dependencies');
    expect(sparse).not.toContain('undefined');
  });

  it('never emits an undefined placeholder', () => {
    const noGit = renderContextMarkdown({ ...baseProfile, isGitRepo: false, branch: undefined, recentCommits: [] });
    // Match the Git bullet specifically — the word "branch" also appears in
    // the working agreement ("delete branches").
    expect(noGit).not.toContain('- **Git:**');
    expect(noGit).not.toContain('undefined');
  });
});

describe('summarizeProfile', () => {
  it('summarises stack and size', () => {
    const s = summarizeProfile(baseProfile);
    expect(s).toContain('**app**');
    expect(s).toContain('TypeScript 80%');
    expect(s).toContain('source files analysed');
  });

  it('copes with a project with no recognisable languages', () => {
    const s = summarizeProfile({ ...baseProfile, languages: [], frameworks: [], entryPoints: [] });
    expect(s).toContain('no recognised source files');
  });
});

describe('agent guidance section', () => {
  const md = renderContextMarkdown(baseProfile);

  it('tells the agent to read before it writes', () => {
    expect(md).toContain('### Before you touch anything');
    expect(md).toContain('Read before you write');
    expect(md).toContain('Trace the call site');
  });

  it('warns against reformatting untouched code', () => {
    expect(md).toContain('Do not reformat code you were not asked to change');
  });

  it('forbids weakening types, lint rules, or tests to get a pass', () => {
    // This is the single highest-value rule in the document: it is the failure
    // mode that turns a visible error into an invisible one.
    expect(md).toContain('Do not weaken a type, a lint rule, or a test');
  });

  it('forbids unrequested dependency changes and unrequested git history edits', () => {
    expect(md).toContain('Do not install packages or add dependencies');
    expect(md).toContain('rewrite history');
  });

  it('tells the agent to delete nothing it did not write', () => {
    expect(md).toContain('Do not delete or overwrite work you did not write');
  });

  it('lists what to actively look for', () => {
    expect(md).toContain('### Look for these specifically');
    expect(md).toContain('TODO');
    expect(md).toContain('catch {}');
  });

  it('adds TypeScript-specific things to look for', () => {
    expect(md).toContain('`any`');
  });

  it('asks for git history when the project is a repo', () => {
    expect(md).toContain('git log');
    const noGit = renderContextMarkdown({ ...baseProfile, isGitRepo: false });
    expect(noGit).not.toContain('git log');
  });

  it('demands the real verification commands before declaring done', () => {
    expect(md).toContain('### Before you say you are done');
    expect(md).toContain('npm test');
    expect(md).toContain('npm run build');
  });

  it('does not promise a build command in a project without one', () => {
    const noBuild = renderContextMarkdown({ ...baseProfile, buildCommand: undefined, lintCommand: undefined, testCommand: undefined });
    expect(noBuild).toContain('exercised the change by running the thing');
    expect(noBuild).not.toContain('npm run build');
  });

  it('tells the agent to say when it is uncertain', () => {
    expect(md).toContain('### When you are uncertain');
    expect(md).toContain('A wrong confident answer costs more than a question');
  });

  it('adds component-specific guidance for a React codebase', () => {
    expect(md).toContain('This is a component codebase');
  });

  it('omits component guidance for a non-component project', () => {
    const backend = renderContextMarkdown({
      ...baseProfile, frameworks: ['Fastify'], languages: [{ name: 'TypeScript', files: 9, pct: 100 }],
    });
    expect(backend).not.toContain('This is a component codebase');
  });

  it('does not tell the agent to leave stubs behind', () => {
    expect(md).toContain('You did not leave a `TODO`, a stub');
  });
});

describe('project context injection', () => {
  const entry: ProjectContextEntry = {
    path: '/home/dev/app/AGENTS.md',
    projectName: 'app',
    markdown: '# app\n\nUses npm.',
    updatedAt: Date.now(),
  };

  it('injects the document with guidance to read files', () => {
    const out = getInjectedContext(entry);
    expect(out).toContain('# app');
    expect(out).toContain('before proposing changes');
  });

  it('injects nothing when there is no context', () => {
    expect(getInjectedContext(null)).toBe('');
    expect(getInjectedContext({ ...entry, markdown: '   ' })).toBe('');
  });

  it('truncates on a line boundary rather than mid-sentence', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i} of the context file`).join('\n');
    const out = getInjectedContext({ ...entry, markdown: long });
    expect(out.length).toBeLessThan(MAX_INJECTED_CHARS + 400);
    expect(out).toContain('truncated');
    // Must not end mid-line with a dangling partial word.
    const body = out.split('\n\n_[truncated')[0];
    expect(body.split('\n').pop()).toMatch(/^line \d+ of the context file$/);
  });

  it('points at the real file when truncating', () => {
    const out = getInjectedContext({ ...entry, markdown: 'x'.repeat(MAX_INJECTED_CHARS + 500) });
    expect(out).toContain(entry.path);
  });
});