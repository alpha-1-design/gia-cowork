import React, { useState, useCallback } from 'react';
import { VisualCard } from './common';
import { useCopy } from './useCopy';
import { renderAnsiSpans } from './ansi';

interface TerminalData {
  output?: string;
  command?: string;
  title?: string;
  exitCode?: number;
}

export const TerminalVisual: React.FC<{ data: Record<string, unknown> }> = ({ data }) => {
  const d = data as TerminalData;
  const output = d.output;
  const command = d.command;
  const title = d.title;
  const exitCode = d.exitCode || 0;
  const [copied, copy] = useCopy();
  const [expanded, setExpanded] = useState(false);
  const copyOutput = useCallback(() => copy(output || ''), [output, copy]);

  const renderAnsi = renderAnsiSpans;

  return (
    <VisualCard title={title || 'Terminal Output'} onCopy={copyOutput} copied={copied} expanded={expanded} onToggle={() => setExpanded(!expanded)}>
      <div className="rounded-lg overflow-hidden" style={{ background: 'var(--gia-code-bg)', maxHeight: expanded ? '600px' : '200px', overflowY: 'auto' }}>
        {command && (
          <div className="px-3 py-1.5 text-[9px] font-mono" style={{ background: 'var(--gia-overlay)', color: 'var(--gia-muted-2)' }}>
            $ {command}
          </div>
        )}
        <pre className="p-3 text-[11px] font-mono leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--gia-muted)' }}>
          {renderAnsi(output || '')}
        </pre>
        {exitCode !== 0 && (
          <div className="px-3 py-1 text-[9px] font-mono" style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>
            Exit code: {exitCode}
          </div>
        )}
      </div>
    </VisualCard>
  );
};
