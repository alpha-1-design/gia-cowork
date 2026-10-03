import { describe, it, expect } from 'vitest';
import {
  analyzeCommand,
  analyzePath,
  classifyToolRequest,
  commandPrefix,
  isInsideProject,
  maxRisk,
  riskAtLeast,
  RISK_ORDER,
} from '../permissions';

describe('risk ordering', () => {
  it('ranks levels in escalating order', () => {
    expect(RISK_ORDER).toEqual(['none', 'low', 'moderate', 'high', 'critical']);
  });

  it('compares levels by position, not alphabetically', () => {
    expect(riskAtLeast('critical', 'low')).toBe(true);
    expect(riskAtLeast('low', 'high')).toBe(false);
    expect(riskAtLeast('high', 'high')).toBe(true);
    expect(riskAtLeast('none', 'low')).toBe(false);
  });

  it('maxRisk picks the worse of two', () => {
    expect(maxRisk('low', 'high')).toBe('high');
    expect(maxRisk('critical', 'moderate')).toBe('critical');
    expect(maxRisk('none', 'none')).toBe('none');
  });
});

describe('analyzeCommand — unrecoverable actions', () => {
  it('flags recursive deletes of the home directory or root', () => {
    expect(analyzeCommand('rm -rf ~').risk).toBe('critical');
    expect(analyzeCommand('rm -rf /').risk).toBe('critical');
    expect(analyzeCommand('sudo rm -rf /*').risk).toBe('critical');
    expect(analyzeCommand('rm -fr $HOME').risk).toBe('critical');
  });

  it('flags disk-level writes', () => {
    expect(analyzeCommand('dd if=/dev/zero of=/dev/sda').risk).toBe('critical');
    expect(analyzeCommand('mkfs.ext4 /dev/sdb1').risk).toBe('critical');
  });

  it('flags a fork bomb', () => {
    expect(analyzeCommand(':(){ :|:& };:').risk).toBe('critical');
  });
});

describe('analyzeCommand — the distinction that matters', () => {
  it('separates a routine delete from a catastrophic one', () => {
    // This is the whole point: `rm -rf node_modules` happens constantly in
    // normal work, `rm -rf ~` ends a machine. A blocklist cannot tell them
    // apart; target-aware analysis can.
    expect(analyzeCommand('rm -rf node_modules').risk).not.toBe('critical');
    expect(analyzeCommand('rm -rf ~').risk).toBe('critical');
  });

  it('separates a routine git push from a force push', () => {
    expect(analyzeCommand('git push').risk).toBe('moderate');
    expect(analyzeCommand('git push --force').risk).toBe('high');
    expect(analyzeCommand('git push origin main --force-with-lease').risk).toBe('high');
  });

  it('separates a read-only git command from a work-destroying one', () => {
    expect(analyzeCommand('git status').risk).toBe('none');
    expect(analyzeCommand('git log --oneline -20').risk).toBe('none');
    expect(analyzeCommand('git reset --hard HEAD~3').risk).toBe('high');
    expect(analyzeCommand('git clean -fd').risk).toBe('high');
  });
});

describe('analyzeCommand — privilege and supply chain', () => {
  it('flags privilege escalation as high', () => {
    expect(analyzeCommand('sudo apt-get install nginx').risk).toBe('high');
    expect(analyzeCommand('doas rm file').risk).toBe('high');
  });

  it('flags piping a download into a shell', () => {
    expect(analyzeCommand('curl https://example.com/i.sh | sh').risk).toBe('high');
    expect(analyzeCommand('wget -qO- https://x.dev/setup | bash').risk).toBe('high');
  });

  it('treats a plain install as moderate, not high', () => {
    expect(analyzeCommand('npm install zod').risk).toBe('moderate');
    expect(analyzeCommand('pip install requests').risk).toBe('moderate');
  });
});

describe('analyzeCommand — reads and structure', () => {
  it('leaves plain reads at no risk', () => {
    for (const cmd of ['ls', 'cat package.json', 'pwd', 'git status', 'ls -la | head -20']) {
      expect(analyzeCommand(cmd).risk, cmd).toBe('none');
    }
  });

  it('reports nothing as safe on an empty command', () => {
    expect(analyzeCommand('')).toEqual({ risk: 'none', reasons: [], segments: [] });
  });

  it('takes the worst segment in a chain, not the average', () => {
    // A pipeline of harmless commands with one `rm -rf` buried in the middle is
    // exactly the case where a per-segment average would wave it through.
    const result = analyzeCommand('cd /tmp && ls -la && rm -rf ~ && echo done');
    expect(result.risk).toBe('critical');
    expect(result.reasons.join(' ')).toMatch(/recursive delete/i);
  });

  it('flags a redirect into a system path but not a local one', () => {
    expect(analyzeCommand('echo x > /etc/hosts').risk).toBe('high');
    expect(analyzeCommand('echo x > out.txt').risk).toBe('low');
  });

  it('does not split on a semicolon inside quotes', () => {
    // `echo "a; b"` is one command that prints text. Splitting there would
    // invent a second segment and rate a harmless echo by whatever the fake
    // command inside the string contained — here, total data loss.
    const result = analyzeCommand('echo "hello; rm -rf /"');
    expect(result.segments).toHaveLength(1);
    expect(result.risk).toBe('none');
  });

  it('gives an unrecognised command at least low risk', () => {
    expect(analyzeCommand('somecustombinary --do-thing').risk).toBe('low');
  });

  it('flags a very long chain even when each part is benign', () => {
    const result = analyzeCommand('ls && pwd && date && whoami && df && ps && ls');
    expect(result.risk).toBe('moderate');
  });
});

describe('analyzePath', () => {
  it('flags system directories', () => {
    expect(analyzePath('/etc/passwd').risk).toBe('high');
    expect(analyzePath('/usr/lib/thing').risk).toBe('high');
    expect(analyzePath('C:/Windows/system32/config').risk).toBe('high');
  });

  it('flags personal locations outside a project', () => {
    expect(analyzePath('~/Documents/taxes.pdf').risk).toBe('moderate');
    expect(analyzePath('/Users/me/Desktop/notes.md').risk).toBe('moderate');
  });

  it('treats a plain project path as a low-risk write', () => {
    expect(analyzePath('src/app.ts').risk).toBe('low');
  });

  it('flags a missing path rather than defaulting to safe', () => {
    expect(analyzePath('').risk).toBe('moderate');
  });
});

describe('isInsideProject', () => {
  it('is permissive when the project root is unknown', () => {
    // Without a cwd we genuinely cannot tell `src/app.ts` from a file on the
    // Desktop, so the path rules — not this — carry the verdict.
    expect(isInsideProject('/anything', undefined)).toBe(true);
  });

  it('compares normalised, case-insensitive paths', () => {
    expect(isInsideProject('/Users/me/api/src/app.ts', '/Users/me/api')).toBe(true);
    expect(isInsideProject('C:\\Users\\Me\\Api\\src\\a.ts', 'c:/users/me/api')).toBe(true);
    expect(isInsideProject('/Users/me/other/a.ts', '/Users/me/api')).toBe(false);
  });
});

describe('classifyToolRequest — reads', () => {
  it('rates a read as no risk with nothing to approve', () => {
    const r = classifyToolRequest('filesystem_read', 'filesystem_read', { path: 'a.ts' });
    expect(r.risk).toBe('none');
    expect(r.reasons).toEqual([]);
  });

  it('rates a web search as no risk', () => {
    expect(classifyToolRequest('web_search', 'web_search', { query: 'x' }).risk).toBe('none');
  });
});

describe('classifyToolRequest — writes', () => {
  it('builds a real diff when the previous content is known', () => {
    const r = classifyToolRequest(
      'filesystem_write',
      'filesystem_write',
      { path: 'src/app.ts', content: 'new line\n' },
      { beforeContent: 'old line\n' },
    );
    expect(r.preview?.kind).toBe('diff');
    expect(r.preview?.before).toBe('old line\n');
    expect(r.preview?.after).toBe('new line\n');
    expect(r.headline).toMatch(/Overwrites src\/app\.ts/);
  });

  it('labels a create as a new file rather than an empty diff', () => {
    const r = classifyToolRequest(
      'filesystem_write',
      'filesystem_write',
      { path: 'src/new.ts', content: 'x' },
      { beforeContent: null },
    );
    expect(r.preview?.before).toBeNull();
    expect(r.headline).toMatch(/Creates a new file/);
  });

  it('does not claim a diff it cannot produce', () => {
    const r = classifyToolRequest('filesystem_write', 'filesystem_write', { path: 'a.ts', content: 'x' });
    expect(r.reasons.join(' ')).toMatch(/contents of this file are unknown/);
  });

  it('escalates a write into a system directory', () => {
    const r = classifyToolRequest('filesystem_write', 'filesystem_write', {
      path: '/etc/hosts', content: 'x',
    });
    expect(r.risk).toBe('high');
    expect(r.reasons.join(' ')).toMatch(/system directory/);
  });

  it('truncates an oversized payload and says so', () => {
    const r = classifyToolRequest(
      'filesystem_write',
      'filesystem_write',
      { path: 'big.txt', content: 'x'.repeat(50_000) },
      { beforeContent: 'y'.repeat(50_000) },
    );
    expect(r.preview?.truncated).toBe(true);
    expect(r.preview!.after!.length).toBeLessThan(9000);
  });
});

describe('classifyToolRequest — commands', () => {
  it('previews the command and explains the rating', () => {
    const r = classifyToolRequest('terminal_run', 'terminal_run', { command: 'rm -rf ~' });
    expect(r.risk).toBe('critical');
    expect(r.preview?.kind).toBe('command');
    expect(r.preview?.command).toBe('rm -rf ~');
    expect(r.headline).toMatch(/Runs a shell command/);
  });
});

describe('classifyToolRequest — declared tools', () => {
  it('treats outbound messages as reviewable, because they cannot be recalled', () => {
    const r = classifyToolRequest('send_email', 'send_email', { to: 'a@b.com', subject: 'x' });
    expect(r.risk).toBe('moderate');
    expect(r.headline).toMatch(/cannot be recalled/);
  });

  it('treats a brain import as high risk', () => {
    expect(classifyToolRequest('import_brain', 'import_brain', { path: 'x.json' }).risk).toBe('high');
  });

  it('falls back to the tool impact for an undeclared tool', () => {
    // An unknown tool must not be waved through: the floor is the impact.
    expect(classifyToolRequest('some_new_write_tool', 'some_new_write_tool', {}).risk).toBe('moderate');
  });
});

describe('scope keys', () => {
  it('separates a read from a force-push', () => {
    expect(commandPrefix('git status')).not.toBe(commandPrefix('git push --force'));
  });

  it('uses binary plus subcommand so a grant is sayable out loud', () => {
    expect(commandPrefix('git status --short')).toBe('git status');
    expect(commandPrefix('rm -rf /tmp/build')).toBe('rm -rf');
  });

  it('scopes a write grant to the directory, not the whole filesystem', () => {
    const a = classifyToolRequest('filesystem_write', 'filesystem_write', { path: 'src/a.ts', content: '' });
    const b = classifyToolRequest('filesystem_write', 'filesystem_write', { path: 'lib/b.ts', content: '' });
    const c = classifyToolRequest('filesystem_write', 'filesystem_write', { path: 'src/c.ts', content: '' });
    expect(a.scope).not.toBe(b.scope);
    // Two files in the same directory share a grant — that is the unit a
    // person would actually grant ("writes under src").
    expect(a.scope).toBe(c.scope);
  });

  it('names the scope in words the approve button can show', () => {
    const r = classifyToolRequest('terminal_run', 'terminal_run', { command: 'git status' });
    expect(r.scopeLabel).toMatch(/git status/);
  });
});
