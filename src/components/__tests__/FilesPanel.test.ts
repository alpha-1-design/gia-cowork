import { describe, it, expect } from 'vitest';
import { parseGitStatus } from '../FilesPanel';

describe('parseGitStatus', () => {
  it('parses an unstaged modification', () => {
    const changes = parseGitStatus(' M src/app.ts\n');
    expect(changes).toEqual([{ status: 'modified', path: 'src/app.ts', staged: false }]);
  });

  it('parses a staged addition', () => {
    const changes = parseGitStatus('A  new.ts\n');
    expect(changes).toEqual([{ status: 'added', path: 'new.ts', staged: true }]);
  });

  it('parses an unstaged deletion', () => {
    const changes = parseGitStatus(' D gone.ts\n');
    expect(changes).toEqual([{ status: 'deleted', path: 'gone.ts', staged: false }]);
  });

  it('parses a staged deletion', () => {
    const changes = parseGitStatus('D  gone.ts\n');
    expect(changes).toEqual([{ status: 'deleted', path: 'gone.ts', staged: true }]);
  });

  it('parses an untracked file', () => {
    const changes = parseGitStatus('?? scratch.txt\n');
    expect(changes).toEqual([{ status: 'untracked', path: 'scratch.txt', staged: false }]);
  });

  it('shows the destination for a rename', () => {
    const changes = parseGitStatus('R  old.ts -> new.ts\n');
    expect(changes).toEqual([{ status: 'renamed', path: 'new.ts', staged: true }]);
  });

  it('handles CRLF line endings', () => {
    const changes = parseGitStatus(' M a.ts\r\n?? b.txt\r\n');
    expect(changes).toHaveLength(2);
    expect(changes[0].path).toBe('a.ts');
    expect(changes[1].path).toBe('b.txt');
  });

  it('separates staged from unstaged for the same file', () => {
    // "MM" = staged change AND further unstaged change.
    const changes = parseGitStatus('MM both.ts\n');
    expect(changes).toHaveLength(1);
    expect(changes[0].staged).toBe(true);
  });

  it('parses a mixed batch', () => {
    const output = [
      ' M src/a.ts',
      'A  src/b.ts',
      '?? notes.md',
      ' R old.ts -> renamed.ts',
    ].join('\n');
    const changes = parseGitStatus(output);
    expect(changes).toHaveLength(4);
    expect(changes.map(c => c.status)).toEqual(['modified', 'added', 'untracked', 'renamed']);
  });

  it('returns nothing for a clean working tree', () => {
    expect(parseGitStatus('')).toEqual([]);
    expect(parseGitStatus('\n\n')).toEqual([]);
  });

  it('ignores malformed short lines instead of producing junk entries', () => {
    const changes = parseGitStatus('x\n??\n M ok.ts\n');
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('ok.ts');
  });
});