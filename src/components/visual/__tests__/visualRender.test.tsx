import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import VisualRenderer from '../index';
import VisualErrorBoundary from '../VisualErrorBoundary';
import { DataFrameVisual, parseCsv } from '../DataFrameVisual';
import { ExecResultVisual, formatDuration } from '../ExecResultVisual';
import { VISUAL_TYPES, isSupportedVisualType } from '../parseVisualBlock';
import MarkdownRenderer from '../../MarkdownRenderer';

const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeText },
    configurable: true,
  });
});

describe('visual parse routes', () => {
  it('includes the W9/W12 renderer types and every legacy alias in the canonical set', () => {
    for (const t of ['chart', 'table', 'data-table', 'mindmap', 'dataframe', 'csv', 'dataframe_preview', 'exec_result', 'code-execution', 'crawl_result', 'crawl-result', 'waveform', 'file_preview', '3d']) {
      expect(isSupportedVisualType(t), t).toBe(true);
    }
    expect(isSupportedVisualType('quantum_widget')).toBe(false);
    expect(isSupportedVisualType(42)).toBe(false);
  });

  it('routes exec_result to the execution card with stdout, stderr, exit badge and duration', () => {
    const code = JSON.stringify({
      type: 'exec_result',
      data: { command: 'npm test', stdout: 'all green', stderr: 'warn: deprecated', exitCode: 1, durationMs: 1234 },
    });
    const { container } = render(<VisualRenderer code={code} />);
    expect(container.textContent).toContain('all green');
    expect(container.textContent).toContain('warn: deprecated');
    expect(container.textContent).toContain('✗ exit 1');
    expect(container.textContent).toContain('1.23 s');
    // Copy grabs the whole run report, not just one section.
    fireEvent.click(container.querySelector('button[aria-label="Copy"]')!);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('$ npm test'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('[stderr]\nwarn: deprecated'));
  });

  it('routes dataframe csv data into a paginated table with headers and quoted fields intact', () => {
    const code = JSON.stringify({
      type: 'dataframe',
      data: { title: 'Results', csv: 'name,qty\nAda,36\nGrace,"1,000"' },
    });
    const { container } = render(<VisualRenderer code={code} />);
    expect(container.textContent).toContain('Results');
    expect(container.textContent).toContain('name');
    expect(container.textContent).toContain('1,000');
    expect(container.textContent).toContain('36');
  });

  it('right-aligns inferred numeric columns with tabular numerals', () => {
    const { container } = render(
      <DataFrameVisual data={{ columns: ['name', 'qty'], rows: [['Ada', 36], ['Grace', 1000]] }} />,
    );
    const tds = Array.from(container.querySelectorAll('td'));
    // "Ada" left, 36 right.
    expect(tds[0].style.textAlign).toBe('left');
    expect(tds[1].style.textAlign).toBe('right');
    expect(tds[1].style.fontVariantNumeric).toBe('tabular-nums');
  });

  it('copies the FULL grid as TSV, not just the visible page', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ name: `row-${i}`, n: i }));
    const { container } = render(<DataFrameVisual data={{ columns: ['name', 'n'], rows }} />);
    fireEvent.click(container.querySelector('button[aria-label="Copy"]')!);
    const arg = writeText.mock.calls[0][0];
    expect(arg.split('\n')).toHaveLength(26); // header + all 25 rows
    expect(arg).toContain('row-24\t24');
  });
});

describe('generic artifact fallback (W9: no raw JSON, no broken nothing)', () => {
  it('degrades an unknown type to the artifact card instead of a red error', () => {
    const code = JSON.stringify({ type: 'quantum_widget', data: { title: 'Quantum', body: 'Hello artifact' } });
    const { container } = render(<VisualRenderer code={code} />);
    expect(container.textContent).toContain('Quantum');
    expect(container.textContent).toContain('Hello artifact');
    expect(container.textContent).not.toContain('Unknown visual type');
    expect(container.textContent).not.toContain('Rendering visualization…');
  });

  it('does not dump raw JSON as the visible body when the model only produced data', () => {
    const code = JSON.stringify({ type: 'quantum_widget', data: { foo: { deep: [1, 2] } } });
    const { container } = render(<VisualRenderer code={code} />);
    // The raw source survives ONLY inside the collapsed, copyable pane —
    // the visible body must not be a raw JSON dump.
    const sourcePane = container.querySelector('details');
    expect(sourcePane?.textContent).toContain('deep');
    expect(container.textContent).not.toContain('Unknown visual type');
  });

  it('degrades a complete-but-malformed block to the artifact card, never a throw', () => {
    const code = '{"type":"chart","data":{"labels":["A","B"'; // truncated JSON, fence complete
    const { container } = render(<VisualRenderer code={code} />);
    expect(container.textContent).toContain('Artifact');
    expect(container.textContent).toContain('showing the raw source instead');
    expect(container.textContent).not.toContain('Rendering visualization…');
  });

  it('still collapses to an inline error if a renderer itself crashes', () => {
    const Bomb: React.FC = () => { throw new Error('boom'); };
    const { container } = render(
      <VisualErrorBoundary><Bomb /></VisualErrorBoundary>,
    );
    expect(container.textContent).toContain("couldn't be displayed");
    expect(container.textContent).toContain('boom');
  });
});

describe('streaming safety (partial blocks never flash errors)', () => {
  const truncated = '{"type":"chart","data":{"labels":["A","B"';
  const unknownType = JSON.stringify({ type: 'quantum_widget', data: { title: 'Q' } });

  it('shows the rendering placeholder for a truncated block mid-stream', () => {
    const { container } = render(<VisualRenderer code={truncated} incomplete />);
    expect(container.textContent).toContain('Rendering visualization…');
    expect(container.textContent).not.toContain('Artifact');
  });

  it('shows the rendering placeholder for an unknown type mid-stream', () => {
    const { container } = render(<VisualRenderer code={unknownType} incomplete />);
    expect(container.textContent).toContain('Rendering visualization…');
    expect(container.textContent).not.toContain('Artifact');
  });

  it('renders a known type that parses mid-stream, even without a closing fence yet', () => {
    const code = JSON.stringify({ type: 'exec_result', data: { stdout: 'partial output', exitCode: 0 } });
    const { container } = render(<VisualRenderer code={code} incomplete />);
    expect(container.textContent).toContain('partial output');
    expect(container.textContent).toContain('✓ exit 0');
  });

  it('MarkdownRenderer feeds unclosed visual fences through with incomplete=true', () => {
    const content = 'Before\n```visual\n{"type":"exec_result","data":{"stdout":"streamed in"';
    const { container } = render(<MarkdownRenderer content={content} />);
    expect(container.textContent).toContain('Before');
    expect(container.textContent).toContain('Rendering visualization…');
  });

  it('MarkdownRenderer renders the same fence once the closing line arrives', () => {
    const content = 'Before\n```visual\n{"type":"exec_result","data":{"stdout":"streamed in","exitCode":0}}\n```\nAfter';
    const { container } = render(<MarkdownRenderer content={content} />);
    expect(container.textContent).toContain('streamed in');
    expect(container.textContent).toContain('✓ exit 0');
    expect(container.textContent).toContain('After');
  });
});

describe('dataframe internals', () => {
  it('parseCsv handles quoted commas, escaped quotes and embedded newlines', () => {
    const grid = parseCsv('a,b\n"x,y","he said ""hi"""\n"multi\nline",2');
    expect(grid).toEqual([
      ['a', 'b'],
      ['x,y', 'he said "hi"'],
      ['multi\nline', '2'],
    ]);
  });

  it('parseCsv keeps a final field with no trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n3')).toEqual([['a', 'b'], ['1', '2'], ['3']]);
  });
});

describe('exec internals', () => {
  it('formatDuration renders compact human durations and rejects junk', () => {
    expect(formatDuration(340)).toBe('340 ms');
    expect(formatDuration(1234)).toBe('1.23 s');
    expect(formatDuration(90_000)).toBe('1 m 30 s');
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });
});

describe('canonical set integrity', () => {
  it('VISUAL_TYPES is a non-empty readonly set', () => {
    expect(VISUAL_TYPES.size).toBeGreaterThan(30);
  });
});
