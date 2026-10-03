import React, { useEffect, useState } from 'react';
import { ArrowUpCircle, X } from 'lucide-react';
import { versionCheck, type VersionInfo } from '../services/VersionCheck';

/**
 * Update banner.
 *
 * A version check nobody sees is not a version check. This surfaces the result
 * once, dismissible, and never in the way — no modal, no nag on every launch,
 * and nothing at all when the check fails or is inconclusive.
 *
 * A failure is genuinely silent: whether GitHub's API is reachable is not the
 * user's problem, and an error banner about a failed version lookup would be
 * alarming noise for zero benefit.
 */
export function UpdateBanner() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Not forced: the service rate-limits itself to one check per six hours,
    // so this is cheap and usually served from cache.
    void versionCheck.check().then(result => {
      if (!cancelled) setInfo(result);
    });
    return () => { cancelled = true; };
  }, []);

  if (dismissed || !info?.updateAvailable) return null;

  return (
    <div
      data-testid="update-banner"
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px]"
      style={{
        background: 'rgba(34,197,94,0.08)',
        border: '1px solid rgba(34,197,94,0.25)',
        color: 'var(--gia-muted)',
      }}
    >
      <ArrowUpCircle size={12} style={{ color: '#22c55e' }} className="shrink-0" />
      <span className="flex-1">
        GIA <span className="font-mono">{info.current}</span> is out of date —{' '}
        <span className="font-mono">{info.latest}</span> is available.
      </span>
      {info.releaseUrl && (
        <a
          href={info.releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium shrink-0"
          style={{ color: '#22c55e' }}
        >
          Release notes
        </a>
      )}
      <button onClick={() => setDismissed(true)} aria-label="Dismiss update notice" className="shrink-0 p-0.5 rounded">
        <X size={11} style={{ color: 'var(--gia-muted-2)' }} />
      </button>
    </div>
  );
}

export default UpdateBanner;