import React, { useState, useMemo, useCallback } from 'react';
import { VisualCard } from './common';
import { useCopy } from './useCopy';

/**
 * Dataframe/CSV preview — the W9 gap renderer for tabular blobs.
 *
 * Distinct from DataTableVisual (which renders object rows with
 * sort/filter for the `table` type): this one accepts the shapes a model
 * actually emits for a *dataset* — a raw CSV string, array-of-arrays, or
 * array-of-objects — infers per-column alignment from the cell types, and
 * paginates. Copy always exports the full grid as TSV, not just the page.
 */

interface DataFrameData {
  title?: string;
  columns?: string[];
  rows?: unknown[];
  csv?: string;
  pageSize?: number;
}

/** RFC-4180-flavoured CSV split: quoted fields may contain commas, escaped
 * quotes ("") and newlines. Deliberately dependency-free — the model's CSV
 * is usually simple, but must not silently mis-split on the day it isn't. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const push = () => { row.push(field); field = ''; };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { push(); i++; continue; }
    if (c === '\n') { push(); rows.push(row); row = []; i++; continue; }
    if (c === '\r') { i++; continue; }
    field += c; i++;
  }
  // Truncated final line (streaming) or no trailing newline still lands.
  if (field !== '' || row.length > 0) { push(); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r[0] ?? '').trim() !== '');
}

const isNumeric = (v: string): boolean =>
  v.trim() !== '' && Number.isFinite(Number(v.trim()));

/** A column right-aligns when every non-empty cell is numeric — text rows
 * with a stray digit stay left-aligned, so the inference is conservative. */
function columnAlignments(rows: string[][], colCount: number): ('left' | 'right')[] {
  return Array.from({ length: colCount }, (_, c) =>
    rows.every(r => {
      const cell = String(r[c] ?? '').trim();
      return cell === '' || isNumeric(cell);
    }) && rows.some(r => isNumeric(String(r[c] ?? ''))) ? 'right' : 'left',
  );
}

export const DataFrameVisual: React.FC<{ data: Record<string, unknown> }> = ({ data }) => {
  const d = data as DataFrameData;
  const [copied, copy] = useCopy();
  const [page, setPage] = useState(0);
  const pageSize = d.pageSize || 10;

  const { headers, rows } = useMemo((): { headers: string[]; rows: string[][] } => {
    if (d.csv) {
      const grid = parseCsv(d.csv);
      if (grid.length === 0) return { headers: [], rows: [] };
      const [head, ...body] = grid;
      return { headers: head, rows: body };
    }
    const raw = d.rows || [];
    if (raw.length > 0 && Array.isArray(raw[0])) {
      // Array-of-arrays: headers only exist if the block provides them.
      const body = raw.map(r => (r as unknown[]).map(c => String(c ?? '')));
      const colCount = Math.max(...body.map(r => r.length), 0);
      const headers = d.columns || Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`);
      return { headers, rows: body };
    }
    // Array-of-objects, same as DataTableVisual accepts.
    const objs = raw.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null);
    const headers = d.columns || (objs.length ? Object.keys(objs[0]) : []);
    return { headers, rows: objs.map(o => headers.map(h => String(o[h] ?? ''))) };
  }, [d.csv, d.rows, d.columns]);

  const alignments = useMemo(() => columnAlignments(rows, headers.length), [rows, headers]);

  const totalPages = Math.ceil(rows.length / pageSize);
  const pageRows = rows.slice(page * pageSize, (page + 1) * pageSize);

  const copyTsv = useCallback(() => {
    copy([headers, ...rows].map(r => r.join('\t')).join('\n'));
  }, [headers, rows, copy]);

  if (rows.length === 0) {
    return (
      <div className="text-xs p-4 text-center" style={{ color: 'var(--gia-muted-2)' }}>No data</div>
    );
  }

  return (
    <VisualCard title={d.title || 'Dataframe'} onCopy={copyTsv} copied={copied}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[9px]" style={{ color: 'var(--gia-muted-2)' }}>{rows.length} rows × {headers.length} cols</span>
        <span className="text-[9px]" style={{ color: 'var(--gia-muted-2)' }}>TSV copy includes all rows</span>
      </div>
      <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--gia-border)' }}>
        <table className="w-full text-[11px]">
          <thead>
            <tr style={{ background: 'var(--gia-surface-3)', position: 'sticky', top: 0, zIndex: 1 }}>
              {headers.map((h, hi) => (
                <th key={hi} className="px-3 py-2 font-medium whitespace-nowrap" style={{ textAlign: alignments[hi] === 'right' ? 'right' : 'left', color: 'var(--gia-muted)', borderBottom: '1px solid var(--gia-border)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, ri) => (
              <tr key={ri} className="transition-colors hover:bg-white/5" style={{ background: ri % 2 === 1 ? 'var(--gia-surface-2)' : 'transparent' }}>
                {headers.map((_, ci) => (
                  <td key={ci} className="px-3 py-1.5 whitespace-nowrap" style={{ textAlign: alignments[ci] === 'right' ? 'right' : 'left', color: 'var(--gia-text)', borderBottom: '1px solid var(--gia-border)', fontVariantNumeric: 'tabular-nums' }}>
                    {row[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-3">
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="text-[9px] px-2 py-1 rounded" style={{ color: page === 0 ? 'var(--gia-muted-2)' : 'var(--gia-muted)', background: 'var(--gia-surface-2)' }}>← Prev</button>
          <span className="text-[9px]" style={{ color: 'var(--gia-muted-2)' }}>{page + 1} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="text-[9px] px-2 py-1 rounded" style={{ color: page >= totalPages - 1 ? 'var(--gia-muted-2)' : 'var(--gia-muted)', background: 'var(--gia-surface-2)' }}>Next →</button>
        </div>
      )}
    </VisualCard>
  );
};
