import React, { useState, useEffect, useCallback } from 'react';
import { Files, RefreshCw, GitBranch, Circle, FileText, Loader2, Check } from 'lucide-react';
import terminalService from '../services/TerminalService';
import { isTauri } from '../platform';

export type FileChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface FileChange {
  status: FileChangeStatus;
  path: string;
  staged: boolean;
}

/**
 * Parse `git status --porcelain` output.
 *
 * Porcelain v1 is two status chars then a space then the path, e.g.
 * " M src/app.ts" (unstaged modify) or "A  new.ts" (staged add). The first
 * column is the index/staged state and the second is the worktree state, so
 * "committed" is simply "not present here".
 */
export function parseGitStatus(output: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    // Rename entries are "R  old -> new"; show the destination.
    const path = line.slice(3).trim();
    if (!path) continue;
    const dest = path.includes('->') ? path.split('->')[1].trim() : path;
    // "x?" is an untracked file.
    if (x === '?' && y === '?') {
      changes.push({ status: 'untracked', path: dest, staged: false });
      continue;
    }
    if (x === 'R' || y === 'R') {
      changes.push({ status: 'renamed', path: dest, staged: x !== ' ' && x !== '?' });
      continue;
    }
    if (x === 'D' || y === 'D') {
      changes.push({ status: 'deleted', path: dest, staged: x === 'D' });
      continue;
    }
    if (x === 'A') {
      changes.push({ status: 'added', path: dest, staged: true });
      continue;
    }
    changes.push({ status: 'modified', path: dest, staged: x === 'M' });
  }
  return changes;
}

const STATUS_STYLE: Record<FileChangeStatus, { color: string; label: string }> = {
  modified: { color: '#f59e0b', label: 'M' },
  added: { color: '#34d399', label: 'A' },
  deleted: { color: '#f87171', label: 'D' },
  renamed: { color: '#3b82f6', label: 'R' },
  untracked: { color: '#a855f7', label: 'U' },
};

interface FilesPanelProps {
  /** Called with the shell command the user asked to run, if any. */
  onRunCommand?: (cmd: string) => void;
}

const FilesPanel: React.FC<FilesPanelProps> = ({ onRunCommand }) => {
  const available = isTauri() && terminalService.isAvailable();
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [branch, setBranch] = useState<string>('');
  const [recentCommits, setRecentCommits] = useState<{ hash: string; subject: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadedOnce, setLoadedOnce] = useState(false);

  const refresh = useCallback(async () => {
    if (!available) return;
    setBusy(true);
    setError('');
    try {
      const [status, branchRes, logRes] = await Promise.all([
        terminalService.exec('git status --porcelain'),
        terminalService.exec('git rev-parse --abbrev-ref HEAD'),
        terminalService.exec('git log --oneline -8 --no-color'),
      ]);

      if (status.exitCode !== 0) {
        setError(status.output?.trim() || 'Not a git repository.');
        setChanges([]);
        setLoadedOnce(true);
        return;
      }

      setChanges(parseGitStatus(status.output || ''));
      setBranch(branchRes.output?.trim() || '');
      setRecentCommits(
        (logRes.output || '')
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean)
          .slice(0, 8)
          .map(l => {
            const [hash, ...rest] = l.split(/\s+/);
            return { hash: hash || '', subject: rest.join(' ') };
          }),
      );
      setLoadedOnce(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoadedOnce(true);
    } finally {
      setBusy(false);
    }
  }, [available]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const staged = changes.filter(c => c.staged);
  const unstaged = changes.filter(c => !c.staged);

  const renderFile = (c: FileChange) => {
    const s = STATUS_STYLE[c.status];
    return (
      <div key={`${c.status}-${c.path}-${c.staged}`} className="flex items-center gap-2 py-1 px-1.5 rounded hover:bg-white/[0.03]">
        <span
          className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold shrink-0"
          style={{ background: `${s.color}1f`, color: s.color }}
          title={`${s.label} — ${c.path}`}
        >
          {s.label}
        </span>
        <span className="text-[11px] truncate flex-1" style={{ color: 'var(--gia-text)' }} title={c.path}>
          {c.path.split('/').pop()}
        </span>
        <span className="text-[9px] truncate max-w-[45%]" style={{ color: 'var(--gia-muted-2)' }}>{c.path}</span>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col text-sm" style={{ background: 'var(--gia-bg)' }}>
      <div className="flex items-center justify-between px-3 py-2 shrink-0" style={{ borderBottom: '1px solid var(--gia-border)' }}>
        <div className="flex items-center gap-2 min-w-0">
          <Files size={13} style={{ color: '#3b82f6' }} />
          <span className="text-[11px] font-semibold" style={{ color: 'var(--gia-text)' }}>Files</span>
          {branch && (
            <span className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full" style={{
              background: 'rgba(59,130,246,0.1)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.2)',
            }}>
              <GitBranch size={8} />{branch}
            </span>
          )}
          {changes.length > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{
              background: 'rgba(245,158,11,0.12)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.25)',
            }}>{changes.length} changed</span>
          )}
        </div>
        <button
          onClick={() => void refresh()}
          disabled={busy || !available}
          className="p-1.5 rounded-lg transition-colors disabled:opacity-40"
          style={{ color: 'var(--gia-muted)' }}
          title="Refresh git status"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {!available ? (
          <p className="text-[10px] text-center py-6 px-3 leading-relaxed" style={{ color: 'var(--gia-muted-2)' }}>
            Files & git status need the desktop host shell. Open GIA Cowork on your machine to see
            changed, uncommitted and committed files here.
          </p>
        ) : error ? (
          <p className="text-[10px] text-center py-6 px-3 leading-relaxed" style={{ color: '#fb923c' }}>{error}</p>
        ) : (
          <>
            <Section title="Uncommitted changes" count={unstaged.length} color="#f59e0b">
              {unstaged.length === 0 ? (
                <Empty label="Working tree clean — nothing uncommitted." />
              ) : unstaged.map(renderFile)}
            </Section>

            <Section title="Staged" count={staged.length} color="#34d399">
              {staged.length === 0 ? (
                <Empty label="Nothing staged." />
              ) : staged.map(renderFile)}
            </Section>

            <Section title="Committed (recent)" count={recentCommits.length} color="#a855f7">
              {recentCommits.length === 0 ? (
                <Empty label="No commits yet." />
              ) : recentCommits.map(c => (
                <div key={c.hash} className="flex items-center gap-2 py-1 px-1.5 rounded">
                  <Check size={10} style={{ color: '#34d399' }} className="shrink-0" />
                  <span className="text-[9px] font-mono shrink-0" style={{ color: '#a855f7' }}>{c.hash.slice(0, 7)}</span>
                  <span className="text-[11px] truncate" style={{ color: 'var(--gia-muted)' }} title={c.subject}>{c.subject}</span>
                </div>
              ))}
            </Section>

            {loadedOnce && changes.length === 0 && recentCommits.length === 0 && (
              <p className="text-[10px] text-center py-6 px-3" style={{ color: 'var(--gia-muted-2)' }}>
                Not a git repository yet.
              </p>
            )}
          </>
        )}
      </div>

      {available && onRunCommand && (
        <div className="flex items-center gap-1.5 px-2 py-2 shrink-0 flex-wrap" style={{ borderTop: '1px solid var(--gia-border)' }}>
          {['git status', 'git diff', 'git add .', 'git log --oneline -8'].map(cmd => (
            <button
              key={cmd}
              onClick={() => onRunCommand(cmd)}
              className="text-[9px] px-2 py-1 rounded-lg transition-colors"
              style={{ background: 'var(--gia-overlay)', color: 'var(--gia-muted)', border: '1px solid var(--gia-overlay-2)' }}
            >
              {cmd}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const Section: React.FC<{ title: string; count: number; color: string; children: React.ReactNode }> = ({ title, count, color, children }) => (
  <div className="mb-3">
    <div className="flex items-center gap-1.5 px-1.5 mb-1">
      <Circle size={7} fill={color} color={color} />
      <span className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>{title}</span>
      {count > 0 && <span className="text-[9px]" style={{ color }}>{count}</span>}
    </div>
    {children}
  </div>
);

const Empty: React.FC<{ label: string }> = ({ label }) => (
  <p className="text-[10px] px-1.5 py-1" style={{ color: 'var(--gia-muted-2)' }}>{label}</p>
);

export default FilesPanel;