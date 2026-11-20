import React from 'react';

interface AnsiSpan {
  text: string;
  bold?: boolean;
  color?: string;
}

/**
 * Shared ANSI SGR renderer for output-bearing visuals (terminal output,
 * code-execution results). Parses `ESC [ … m` sequences only — enough for
 * bold and the standard/bright foreground palette the tool runners emit —
 * and returns styled spans so each consumer can lay them out in its own
 * <pre>. Kept in one place because TerminalVisual and ExecResultVisual must
 * color identical output the identical way.
 */
export function renderAnsiSpans(text: string): React.ReactNode[] {
  if (!text) return [];
  const ansiRegex = new RegExp(String.fromCharCode(27) + '\\[([0-9;]*)m', 'g');
  const parts: AnsiSpan[] = [];
  let lastIdx = 0;
  let currentStyle: { bold?: boolean; color?: string } = {};

  const addPart = (t: string) => {
    if (t) parts.push({ text: t, ...currentStyle });
  };

  let match: RegExpExecArray | null;
  while ((match = ansiRegex.exec(text)) !== null) {
    addPart(text.slice(lastIdx, match.index));
    lastIdx = match.index + match[0].length;
    const codes = match[1] ? match[1].split(';').map(Number) : [0];
    for (const code of codes) {
      if (code === 0) currentStyle = {};
      else if (code === 1) currentStyle.bold = true;
      else if (code >= 30 && code <= 37) {
        const ansiColors = ['#666', '#e74c3c', '#27ae60', '#f39c12', '#3498db', '#9b59b6', '#1abc9c', '#ecf0f1'];
        currentStyle.color = ansiColors[code - 30];
      } else if (code >= 90 && code <= 97) {
        const brightColors = ['#999', '#ff6b6b', '#51cf66', '#ffd43b', '#74c0fc', '#cc5de8', '#22b8cf', '#f8f9fa'];
        currentStyle.color = brightColors[code - 90];
      }
    }
  }
  addPart(text.slice(lastIdx));

  return parts.map((p, i) => (
    <span key={i} style={{ fontWeight: p.bold ? 700 : 400, color: p.color || 'var(--gia-muted)' }}>{p.text}</span>
  ));
}
