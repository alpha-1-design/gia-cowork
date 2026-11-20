import React from 'react';
import { VisualCard } from './common';
import { useCopy } from './useCopy';

/**
 * CrawlResultVisual — minimal renderer for a `web_crawl` result (W12): a
 * title list with per-page status badges. Deliberately small — the tool's
 * text result already carries the full per-page excerpts for the model; this
 * card is just the at-a-glance map of what was crawled. Anything richer
 * (excerpt expansion, link graph) is REVIEW-2 material.
 */
interface CrawlPageRow {
  url?: string;
  title?: string;
  status?: number;
}

interface CrawlResultData {
  crawlId?: string;
  pages?: CrawlPageRow[];
  cancelled?: boolean;
}

/** Status → badge color: green fetched, red HTTP error, amber no response. */
function statusColor(status: number | undefined): string {
  if (!status || status <= 0) return '#f59e0b'; // network/CORS failure
  if (status < 400) return '#22c55e';
  return '#ef4444';
}

export const CrawlResultVisual: React.FC<{ data: Record<string, unknown> }> = ({ data }) => {
  const d = data as CrawlResultData;
  const pages = d.pages;
  const [copied, copy] = useCopy();
  const copyData = React.useCallback(
    () => copy((pages ?? []).map((p) => `[${p.status ?? 0}] ${p.title || ''} ${p.url || ''}`).join('\n')),
    [pages, copy],
  );

  if (!pages?.length) return null;

  return (
    <VisualCard title={`Web Crawl — ${pages.length} page${pages.length === 1 ? '' : 's'}${d.cancelled ? ' (cancelled)' : ''}`} onCopy={copyData} copied={copied}>
      <nav>
        {pages.map((p, i) => (
          <div key={i} className="flex items-center gap-2 py-0.5">
            <span
              className="text-[8px] font-semibold px-1.5 py-0.5 rounded-md shrink-0 font-mono tabular-nums"
              style={{ background: `${statusColor(p.status)}12`, color: statusColor(p.status) }}
            >
              {p.status || 'ERR'}
            </span>
            <span className="text-[11px] truncate" style={{ color: 'var(--gia-text)' }} title={p.url}>
              {p.title || p.url || 'Untitled'}
            </span>
          </div>
        ))}
      </nav>
    </VisualCard>
  );
};
