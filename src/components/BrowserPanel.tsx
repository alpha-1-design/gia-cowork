import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Globe, X, ShieldAlert, Cookie, History, ExternalLink } from 'lucide-react';
import { browserSession } from '../services/browser/BrowserSession';

/**
 * Browser panel — the agent's browsing, made visible.
 *
 * This exists because of a specific failure. GIA could open tabs, click, type
 * and sign in, and the user saw nothing at all — just a line in a reasoning
 * chain saying "clicking e14". That is not a missing feature, it is a trust
 * problem: the permission gate asks you to approve actions, and no one can
 * meaningfully approve what they cannot watch. An agent that browses your
 * machine invisibly is the exact scenario the gate was built for.
 *
 * OpenCode states the requirement plainly — "screenshots require a focused
 * visible tab" — and it is right. So the panel hosts the tab's REAL live
 * iframe rather than a re-render of it: same DOM, same scroll position, same
 * in-flight state. What you see is genuinely the page the agent is acting on,
 * not a reconstruction of it.
 *
 * What it deliberately does not do is become a second browser. There is no
 * address bar, because the point is observation, not competing with the user's
 * own browser for the task of actually logging in.
 */

const KIND_LABEL: Record<string, string> = {
  login: 'Sign-in page',
  consent: 'Cookie consent',
  paywall: 'Paywall',
  captcha: 'Bot check',
  'rate-limit': 'Rate limited',
  geo: 'Unavailable here',
};

export function BrowserPanel() {
  const tabs = useSyncExternalStore(
    browserSession.subscribe,
    browserSession.listSnapshot,
    browserSession.listSnapshot,
  );

  const [active, setActive] = useState<string | null>(null);
  const frameHost = useRef<HTMLDivElement>(null);

  // Default to the newest tab, and follow along if the agent opens one while
  // you are already watching — otherwise the panel silently shows a stale page
  // while the agent has moved on, which is worse than showing nothing.
  useEffect(() => {
    if (tabs.length === 0) {
      setActive(null);
      return;
    }
    if (!active || !tabs.some(t => t.tabId === active)) {
      setActive(tabs[tabs.length - 1].tabId);
    }
  }, [tabs, active]);

  useEffect(() => {
    if (!active || !frameHost.current) return;
    browserSession.attachTo(active, frameHost.current);
    return () => {
      // Put it back off-screen rather than tearing it down. The tab has to
      // survive the user looking away, or switching tabs would destroy the
      // state the agent is working in.
      browserSession.attachTo(active, null);
    };
  }, [active, tabs]);

  if (tabs.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 p-6 text-center">
        <Globe size={22} style={{ color: 'var(--gia-muted-2)' }} />
        <p className="text-[11px] font-medium" style={{ color: 'var(--gia-muted)' }}>No tabs open</p>
        <p className="text-[10px] leading-relaxed max-w-[240px]" style={{ color: 'var(--gia-muted-2)' }}>
          When GIA browses, the pages appear here — so you can see what she is looking at before you approve
          anything she does on them.
        </p>
      </div>
    );
  }

  const activeTab = tabs.find(t => t.tabId === active) ?? tabs[tabs.length - 1];
  const auth = browserSession.authStateOf(activeTab.tabId);
  const session = safeDescribe(activeTab.tabId);

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="browser-panel">
      {/* Tab strip */}
      <div
        className="flex items-center gap-1 px-2 py-1.5 shrink-0 overflow-x-auto"
        style={{ borderBottom: '1px solid var(--gia-border)' }}
      >
        {tabs.map(t => {
          const isActive = t.tabId === activeTab.tabId;
          return (
            <button
              key={t.tabId}
              onClick={() => setActive(t.tabId)}
              data-testid={`browser-tab-${t.tabId}`}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] max-w-[160px] transition-all shrink-0"
              style={{
                background: isActive ? 'rgba(20,184,166,0.14)' : 'transparent',
                color: isActive ? '#14b8a6' : 'var(--gia-muted)',
                border: `1px solid ${isActive ? 'rgba(20,184,166,0.3)' : 'transparent'}`,
              }}
              title={`${t.title || t.url}\n${t.url}`}
            >
              <Globe size={11} />
              <span className="truncate">{t.title || hostOf(t.url)}</span>
            </button>
          );
        })}
      </div>

      {/* URL + session facts */}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 shrink-0 text-[10px]"
        style={{ borderBottom: '1px solid var(--gia-border)', color: 'var(--gia-muted)' }}
      >
        <span className="truncate font-mono flex-1" title={activeTab.url}>{activeTab.url}</span>
        {session?.includes('cookies for this site: none') === false && (
          <span className="flex items-center gap-1 shrink-0" title="This tab has a session cookie">
            <Cookie size={10} />
            <span className="text-emerald-500">signed in</span>
          </span>
        )}
        {session && (
          <span className="flex items-center gap-1 shrink-0 opacity-70" title={session}>
            <History size={10} />
            {session.match(/position (\d+)/)?.[1] ?? '1'}
          </span>
        )}
        <button
          onClick={() => window.open(activeTab.url, '_blank', 'noopener')}
          className="shrink-0 p-1 rounded hover:opacity-70 transition-opacity"
          title="Open in your own browser — useful when a real login is required"
        >
          <ExternalLink size={10} />
        </button>
      </div>

      {/* Auth wall — the honest answer to "why can't it log in" */}
      {auth && (
        <div
          className="flex items-start gap-1.5 px-2.5 py-1.5 shrink-0 text-[10px]"
          style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171' }}
          data-testid="browser-auth-wall"
        >
          <ShieldAlert size={11} className="shrink-0 mt-px" />
          <span className="leading-relaxed">
            <strong>{KIND_LABEL[auth.kind] ?? 'Blocked'}</strong> — {auth.reason}
          </span>
        </div>
      )}

      {/* The live tab itself */}
      <div className="flex-1 min-h-0 relative bg-white">
        <div ref={frameHost} className="absolute inset-0" data-testid="browser-frame-host" />
      </div>

      {/* Close */}
      <div className="flex justify-end px-2 py-1 shrink-0" style={{ borderTop: '1px solid var(--gia-border)' }}>
        <button
          onClick={() => browserSession.close(activeTab.tabId)}
          className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg transition-all"
          style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171' }}
        >
          <X size={10} /> Close tab
        </button>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

/** Never let a diagnostic string break the panel render. */
function safeDescribe(tabId: string): string | null {
  try {
    const res = browserSession.describe(tabId);
    return res.ok ? res.message : null;
  } catch {
    return null;
  }
}

export default BrowserPanel;