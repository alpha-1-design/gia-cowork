import { describe, it, expect } from 'vitest';
import { analyzeShellCommand, isReadOnlyShellCommand } from '../brain/shellConcurrency';

describe('analyzeShellCommand — reads run concurrently', () => {
  it('allows obvious readers', () => {
    for (const cmd of [
      'ls', 'ls -la', 'cat package.json', 'head -20 README.md',
      'grep -r TODO src', 'rg foo', 'find . -name "*.ts"',
      'wc -l src/main.tsx', 'pwd', 'whoami', 'date', 'echo hi',
      'ps aux', 'df -h', 'free -h', 'env', 'stat package.json',
      'which node', 'tree src', 'jq . name package.json',
      'du -sh node_modules', 'file index.html', 'type ls',
    ]) {
      expect(analyzeShellCommand(cmd), cmd).toEqual({ safe: true });
    }
  });

  it('allows read-only git subcommands', () => {
    for (const cmd of ['git status', 'git log --oneline', 'git diff', 'git show HEAD', 'git branch']) {
      expect(analyzeShellCommand(cmd), cmd).toEqual({ safe: true });
    }
  });

  it('allows read-only package-manager subcommands', () => {
    expect(analyzeShellCommand('npm ls').safe).toBe(true);
    expect(analyzeShellCommand('npm outdated').safe).toBe(true);
    expect(analyzeShellCommand('pip list').safe).toBe(true);
  });

  it('handles a fully-qualified binary path', () => {
    expect(analyzeShellCommand('/bin/ls').safe).toBe(true);
    expect(analyzeShellCommand('/usr/bin/git status').safe).toBe(true);
  });

  it('ignores leading environment variable assignments', () => {
    expect(analyzeShellCommand('NODE_ENV=test ls').safe).toBe(true);
    expect(analyzeShellCommand('CI=true npm ls').safe).toBe(true);
  });

  it('ignores a leading sudo or env wrapper', () => {
    expect(analyzeShellCommand('sudo ls').safe).toBe(true);
    expect(analyzeShellCommand('env ls').safe).toBe(true);
  });

  it('handles shell aliases that expand to readers', () => {
    expect(analyzeShellCommand('ll').safe).toBe(true);
    expect(analyzeShellCommand('la').safe).toBe(true);
  });
});

describe('analyzeShellCommand — writes must never slip through', () => {
  it('rejects anything that could write, delete, or move', () => {
    for (const cmd of [
      'rm file.txt', 'rm -rf /tmp/x', 'mv a b', 'cp a b', 'mkdir foo',
      'touch foo', 'sed -i s/a/b/ f', 'chmod 777 f', 'chown me f',
      'npm install', 'npm i lodash', 'npx create-vite', 'pip install x',
      'cargo build', 'python script.py', 'node server.js', 'make', 'sh x.sh',
    ]) {
      expect(isReadOnlyShellCommand(cmd), cmd).toBe(false);
    }
  });

  it('rejects mutating git subcommands even though git is otherwise a reader', () => {
    // This is the case that matters most: `git commit` looks exactly like
    // `git status` until you check the subcommand.
    for (const cmd of ['git commit -m x', 'git checkout main', 'git push', 'git reset --hard', 'git merge x', 'git add .', 'git stash']) {
      expect(isReadOnlyShellCommand(cmd), cmd).toBe(false);
    }
  });

  it('rejects npx entirely, because npx installs by default', () => {
    expect(isReadOnlyShellCommand('npx cowsay')).toBe(false);
    expect(isReadOnlyShellCommand('npx --yes something')).toBe(false);
  });

  it('rejects any redirection', () => {
    for (const cmd of ['ls > out.txt', 'echo x >> log', 'cat a 2>&1', 'ls < in.txt']) {
      expect(isReadOnlyShellCommand(cmd), cmd).toBe(false);
    }
  });

  it('rejects chained and piped commands rather than guessing at the segments', () => {
    // `ls && rm -rf /` reads like a read. Running it in parallel with another
    // rm is how you lose a directory.
    for (const cmd of ['ls && rm -rf /', 'ls; rm x', 'cat a | rm b', 'ls || rm x']) {
      expect(isReadOnlyShellCommand(cmd), cmd).toBe(false);
    }
  });

  it('rejects command substitution', () => {
    expect(isReadOnlyShellCommand('echo $(rm -rf /)')).toBe(false);
    expect(isReadOnlyShellCommand('echo `rm -rf /`')).toBe(false);
  });

  it('rejects find with destructive flags', () => {
    expect(isReadOnlyShellCommand('find . -name "*.log" -delete')).toBe(false);
    expect(isReadOnlyShellCommand('find . -name "*.ts" -exec rm {} ;')).toBe(false);
  });

  it('rejects an unknown binary', () => {
    expect(isReadOnlyShellCommand('somecustomtool --dry-run')).toBe(false);
  });

  it('rejects empty and malformed input', () => {
    expect(isReadOnlyShellCommand('')).toBe(false);
    expect(isReadOnlyShellCommand('   ')).toBe(false);
    expect(isReadOnlyShellCommand('FOO=bar')).toBe(false);
  });

  it('rejects a multi-line script', () => {
    expect(isReadOnlyShellCommand('ls\nrm -rf /')).toBe(false);
  });

  it('explains why it refused, so the choice is auditable', () => {
    expect(analyzeShellCommand('git commit -m x').reason).toMatch(/can modify/);
    expect(analyzeShellCommand('ls > f').reason).toMatch(/redirect/);
    expect(analyzeShellCommand('ls && rm x').reason).toMatch(/chained/);
  });
});