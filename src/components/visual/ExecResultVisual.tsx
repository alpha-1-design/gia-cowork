import React, { useState, useCallback } from 'react';
import { VisualCard } from './common';
import { useCopy } from './useCopy';
import { renderAnsiSpans } from './ansi';

/**
 * Code-execution result card — the W9 gap renderer for `exec_result` blocks.
 *
 * Complements TerminalVisual (raw terminal scrollback): this one is the
 * structured run report — stdout and stderr in clearly separated sections,
 * an exit-code badge that's readable at a glance (green/red), and the run
 * duration. Reuses TerminalVisual's ANSI coloring via the shared renderer.
 */

interface ExecResultData {
  title?: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
}

/** Compact human duration: sub-second runs show ms, longer ones seconds. */
export function formatDuration(ms?: number): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} m ${s} s`;
}

export const ExecResultVisual: React.FC<{ data: Record<string, unknown> }> = ({ data }) => {
  const d = data as ExecResultData;
  const exitCode = typeof d.exitCode === 'number' ? d.exitCode : 0;
  const failed = exitCode !== 0;
  const duration = formatDuration(d.durationMs);
  const [copied, copy] = useCopy();
  const [expanded, setExpanded] = useState(false);

  const copyAll = useCallback(() => {
    const parts: string[] = [];
    if (d.command) parts.push(`$ ${d.command}`);
    if (d.stdout) parts.push(d.stdout);
    if (d.stderr) parts.push(`[stderr]\n${d.stderr}`);
    if (exitCode !== 0) parts.push(`exit code: ${exitCode}`);
    copy(parts.join('\n'));
  }, [d.command, d.stdout, d.stderr, exitCode, copy]);

  return (
    <VisualCard title={d.title || 'Execution Result'} onCopy={copyAll} copied={copied} expanded={expanded} onToggle={() => setExpanded(!expanded)}>
      <div className="rounded-lg overflow-hidden" style={{ background: 'var(--gia-code-bg)', maxHeight: expanded ? '600px' : '280px', overflowY: 'auto' }}>
        {d.command && (
          <div className="px-3 py-1.5 text-[9px] font-mono" style={{ background: 'var(--gia-overlay)', color: 'var(--gia-muted-2)' }}>
            $ {d.command}
          </div>
        )}
        <div className="px-3 py-1 text-[9px] font-bold uppercase tracking-wider" style={{ background: 'var(--gia-overlay)', color: 'var(--gia-muted)' }}>
          stdout
        </div>
        <pre className="p-3 text-[11px] font-mono leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--gia-muted)' }}>
          {renderAnsiSpans(d.stdout || '')}
        </pre>
        {d.stderr && (
          <>
            <div className="px-3 py-1 text-[9px] font-bold uppercase tracking-wider" style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171' }}>
              stderr
            </div>
            <pre className="p-3 text-[11px] font-mono leading-relaxed whitespace-pre-wrap" style={{ color: '#f87171', background: 'rgba(239,68,68,0.06)' }}>
              {renderAnsiSpans(d.stderr)}
            </pre>
          </>
        )}
        <div className="flex items-center gap-2 px-3 py-1.5" style={{ background: 'var(--gia-overlay)', borderTop: '1px solid var(--gia-border)' }}>
          <span
            className="text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={failed
              ? { background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.3)' }
              : { background: 'rgba(34,197,94,0.12)', color: '#4ade80', border: '1px solid rgba(34,197,94,0.3)' }}
          >
            {failed ? `✗ exit ${exitCode}` : '✓ exit 0'}
          </span>
          {duration && (
            <span className="text-[9px]" style={{ color: 'var(--gia-muted-2)' }}>{duration}</span>
          )}
        </div>
      </div>
    </VisualCard>
  );
};
