import React from 'react';
import { VisualCard } from './common';
import { useCopy } from './useCopy';

/**
 * Generic last-resort visual — the W9 "render-anything" guarantee.
 *
 * Anything the pipeline can't confidently draw (a type no renderer claims,
 * or a complete block whose JSON never parses) lands here instead of the old
 * outcomes: a red "Unknown visual type" error box, an eternal spinner, or
 * raw JSON dumped into the chat. The model's intent — a title, some body
 * text, the source of the thing — is always showable, so we show exactly
 * that: recognized body keys rendered as readable text, everything else
 * collapsed into a copyable fenced-source pane.
 */

interface ArtifactData {
  title?: string;
  body?: string;
  text?: string;
  content?: string;
  message?: string;
  summary?: string;
}

/** Keys we'll surface as the readable body, in priority order. */
const BODY_KEYS: Array<keyof ArtifactData> = ['body', 'text', 'content', 'message', 'summary'];

export const ArtifactVisual: React.FC<{
  type?: string;
  data?: Record<string, unknown>;
  source?: string;
  error?: string;
}> = ({ type, data, source, error }) => {
  const d = (data || {}) as ArtifactData;
  const [copied, copy] = useCopy();

  const title = d.title || (type ? `Artifact · ${type}` : 'Artifact');
  const body = BODY_KEYS.map((k) => d[k]).find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const copyText = source || body || title;

  return (
    <VisualCard title={title} onCopy={() => copy(copyText)} copied={copied}>
      {error && (
        <div className="text-[10px] mb-2" style={{ color: 'var(--gia-muted-2)' }}>
          {error} — showing the raw source instead.
        </div>
      )}
      {body && (
        <div className="text-[12px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--gia-text)' }}>
          {body}
        </div>
      )}
      {source && (
        <details className="mt-2 rounded-lg" style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}>
          <summary className="px-3 py-1.5 text-[9px] font-bold uppercase tracking-wider cursor-pointer select-none" style={{ color: 'var(--gia-muted)' }}>
            Source
          </summary>
          <pre className="px-3 pb-3 text-[10px] font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto" style={{ color: 'var(--gia-muted)' }}>
            {source}
          </pre>
        </details>
      )}
      {!body && !source && (
        <div className="text-[11px]" style={{ color: 'var(--gia-muted-2)' }}>
          No displayable content in this block.
        </div>
      )}
    </VisualCard>
  );
};
