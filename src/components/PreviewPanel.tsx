import React, { useCallback, useState } from 'react';
import { RefreshCw, ExternalLink, Monitor } from 'lucide-react';
import { useGiaStore } from '../store/useGiaStore';

/**
 * The running app, docked beside the conversation.
 *
 * This exists because of a specific, repeated complaint: the build preview used
 * to be an 85vh bottom sheet, which meant opening it covered the terminal
 * showing the build that produced it. You could watch output OR the result,
 * never both — and "did my change take effect?" always cost a dismissal.
 *
 * So preview is a dock tab rather than a takeover. The terminal keeps streaming
 * on the left of it, the conversation keeps running, and watching a hot-reload
 * land becomes a glance instead of a context switch.
 *
 * The sheet is still reachable for when you genuinely want it big.
 */
export function PreviewPanel({ onExpand }: { onExpand?: () => void }) {
  const url = useGiaStore(s => s.buildPreviewUrl);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => setReloadKey(k => k + 1), []);

  if (!url) {
    return (
      <div
        className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center"
        style={{ color: 'var(--gia-muted-2)' }}
        data-testid="preview-empty"
      >
        <Monitor size={18} style={{ opacity: 0.5 }} />
        <p className="text-[11px]">Nothing is running yet.</p>
        <p className="text-[10px]" style={{ opacity: 0.7 }}>
          When GIA builds or serves something, it shows up here — beside the
          terminal, not on top of it.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="preview-panel">
      <div
        className="flex items-center gap-1.5 px-2 py-1 shrink-0"
        style={{ borderBottom: '1px solid var(--gia-border)' }}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: '#22c55e', boxShadow: '0 0 6px #22c55e' }} />
        <span className="text-[10px] truncate flex-1 min-w-0" style={{ color: 'var(--gia-muted)' }} title={url}>
          {url}
        </span>
        <button
          onClick={refresh}
          className="p-1 rounded transition-colors hover:bg-white/10"
          style={{ color: 'var(--gia-muted-2)' }}
          title="Reload preview"
          aria-label="Reload preview"
          data-testid="preview-refresh"
        >
          <RefreshCw size={12} />
        </button>
        <button
          onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
          className="p-1 rounded transition-colors hover:bg-white/10"
          style={{ color: 'var(--gia-muted-2)' }}
          title="Open in browser"
          aria-label="Open preview in browser"
        >
          <ExternalLink size={12} />
        </button>
        {onExpand && (
          <button
            onClick={onExpand}
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ color: 'var(--gia-muted-2)' }}
            title="Open the large preview sheet"
          >
            Expand
          </button>
        )}
      </div>
      <iframe
        key={reloadKey}
        src={url}
        title="App preview"
        // See BuildPreviewSheet for why these flags are what they are.
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        referrerPolicy="no-referrer"
        className="flex-1 w-full border-0 min-h-0 block"
        style={{ background: '#fff' }}
      />
    </div>
  );
}