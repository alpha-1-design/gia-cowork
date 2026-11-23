import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, KeyRound, Link2, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { composioService, type ComposioToolkit } from '../../services/composio/ComposioService';

/**
 * ComposioSection — the OAuth connector rail in Settings → Connections.
 *
 * The flow the user drives: paste a Composio API key (from their dashboard —
 * GIA never signs up on their behalf), browse the app catalog, hit Connect on
 * an app. The hosted Connect Link opens in the system browser; Composio holds
 * the OAuth dance and the tokens; GIA polls the connected account until the
 * consent finishes. Completion is observed, never assumed — an attempt that
 * the user abandons stays INITIATED and says so.
 *
 * The API key lives in CredentialVault (OS keychain on desktop). This
 * component only ever holds it in local state between the input and the vault.
 */

type ConnectPhase = 'idle' | 'opening' | 'waiting' | 'done' | 'failed';

const STATUS_PILL: Record<string, { bg: string; fg: string; label: string }> = {
  ACTIVE: { bg: 'rgba(20,184,166,0.12)', fg: '#14b8a6', label: 'Connected' },
  INITIATED: { bg: 'rgba(245,158,11,0.12)', fg: '#f59e0b', label: 'Waiting for consent' },
};

const ComposioSection: React.FC = () => {
  const [configured, setConfigured] = useState<boolean>(false);
  const [keyInput, setKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [catalog, setCatalog] = useState<ComposioToolkit[]>([]);
  const [connected, setConnected] = useState<ComposioToolkit[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connectPhase, setConnectPhase] = useState<Record<string, ConnectPhase>>({});
  const [notice, setNotice] = useState('');
  const catalogForRef = useRef<string | null>(null);

  useEffect(() => {
    void composioService.isConfigured().then(setConfigured);
  }, []);

  const refreshConnected = useCallback(async () => {
    try {
      const list = await composioService.connectedToolkits();
      setConnected(list);
      return list;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load connected apps');
      return [];
    }
  }, []);

  /** Load the catalog (with connection state merged in for the current query). */
  const loadCatalog = useCallback(async (search: string) => {
    const stamp = `${search}`;
    catalogForRef.current = stamp;
    setLoading(true);
    setError('');
    try {
      const [{ items }, conn] = await Promise.all([
        composioService.listToolkits({ search: search || undefined, limit: 30 }),
        composioService.connectedToolkits(),
      ]);
      setConnected(conn);
      const connSlugs = new Map(conn.map(c => [c.slug, c]));
      setCatalog(items.map(item => {
        const c = connSlugs.get(item.slug);
        return c ? { ...item, meta: { connected: true, status: String(c.meta?.status || 'ACTIVE') } } : item;
      }));
    } catch (e) {
      if (catalogForRef.current === stamp) {
        setError(e instanceof Error ? e.message : 'Could not load the app catalog');
      }
    } finally {
      if (catalogForRef.current === stamp) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (configured !== true) return;
    const t = setTimeout(() => { void loadCatalog(query.trim()); }, query ? 350 : 0);
    return () => clearTimeout(t);
  }, [configured, query, loadCatalog]);

  const handleSaveKey = async () => {
    setSavingKey(true);
    setError('');
    try {
      await composioService.setApiKey(keyInput);
      setKeyInput('');
      setConfigured(true);
      setNotice('Composio connected. Browse the catalog and connect your apps.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the key');
    } finally {
      setSavingKey(false);
    }
  };

  const openConnectLink = async (slug: string, redirectUrl: string) => {
    setConnectPhase(p => ({ ...p, [slug]: 'opening' }));
    try {
      const deviceIntegration = (await import('../../services/DeviceIntegration')).default;
      await deviceIntegration.openUrl(redirectUrl);
    } catch {
      window.open(redirectUrl, '_blank', 'noopener');
    }
    setConnectPhase(p => ({ ...p, [slug]: 'waiting' }));
  };

  /** Poll an in-flight attempt to completion, then refresh state. */
  const pollAttempt = async (slug: string) => {
    const attempt = composioService.peekPendingConnect(slug);
    if (!attempt) return;
    const res = await composioService.waitForConnection(attempt);
    if (res.connected) {
      setConnectPhase(p => ({ ...p, [slug]: 'done' }));
      setNotice(`Connected ${slug}.`);
      await refreshConnected();
      await loadCatalog(query.trim());
      setTimeout(() => setConnectPhase(p => ({ ...p, [slug]: 'idle' })), 4000);
    } else if (res.status === 'INITIATED') {
      setConnectPhase(p => ({ ...p, [slug]: 'waiting' }));
      setNotice(`${slug}: still waiting for you to finish consent in the browser. Press Check again when done.`);
    } else {
      setConnectPhase(p => ({ ...p, [slug]: 'failed' }));
      setError(`${slug} connection ended: ${res.status}`);
      composioService.abandonConnect(slug);
    }
  };

  const handleConnect = async (slug: string) => {
    setError('');
    setNotice('');
    try {
      setConnectPhase(p => ({ ...p, [slug]: 'opening' }));
      const attempt = await composioService.connect(slug);
      await openConnectLink(slug, attempt.redirectUrl);
      void pollAttempt(slug);
    } catch (e) {
      setConnectPhase(p => ({ ...p, [slug]: 'failed' }));
      setError(e instanceof Error ? e.message : `Could not start the ${slug} connection`);
    }
  };

  const handleDisconnect = async (slug: string, accountId: string) => {
    setError('');
    try {
      await composioService.disconnect(accountId);
      setConnected(cs => cs.filter(c => c.slug !== slug));
      await loadCatalog(query.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not disconnect ${slug}`);
    }
  };

  const accountIdOf = (t: ComposioToolkit): string | null => {
    const id = (t.meta as { connection?: { id?: string } } | null | undefined)?.connection?.id
      ?? (t as unknown as { connected_account_id?: string }).connected_account_id
      ?? null;
    return id ? String(id) : null;
  };

  // ── Setup state ──────────────────────────────────────────────────────
  if (!configured) {
    return (
      <div className="px-3 py-4 rounded-xl" style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }}>
        <div className="flex items-center gap-2 mb-1">
          <Link2 size={14} style={{ color: '#a855f7' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--gia-text)' }}>OAuth apps via Composio</span>
        </div>
        <p className="text-xs leading-relaxed mb-3" style={{ color: 'var(--gia-muted)' }}>
          Let GIA act on your other apps — Slack, GitHub, Gmail, Notion and 1,500+ more — through Composio's
          managed OAuth. Tokens are held by Composio and never pass through GIA; every action still goes through
          GIA's permission gate.
        </p>
        <div className="flex gap-2 mb-2">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="Composio API key"
            aria-label="Composio API key"
            className="flex-1 px-3 py-2 rounded-lg text-xs outline-none"
            style={{ background: 'var(--gia-bg)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
          />
          <button
            onClick={handleSaveKey}
            disabled={savingKey || !keyInput.trim()}
            className="px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-50"
            style={{ background: 'var(--gia-accent)', color: 'var(--gia-accent-contrast)' }}
          >
            {savingKey ? 'Saving…' : 'Save key'}
          </button>
        </div>
        <a
          href="https://dashboard.composio.dev/~/project/settings/api-keys"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px]"
          style={{ color: 'var(--gia-accent)' }}
        >
          <ExternalLink size={10} /> Get a free API key at dashboard.composio.dev
        </a>
        {error && <p className="text-[11px] mt-2" style={{ color: '#ef4444' }}>{error}</p>}
      </div>
    );
  }

  // ── Connected state ──────────────────────────────────────────────────
  return (
    <div className="px-3 py-4 rounded-xl" style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Link2 size={14} style={{ color: '#a855f7' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--gia-text)' }}>OAuth apps (Composio)</span>
          {connected.length > 0 && (
            <span className="gia-pill" style={{ background: 'rgba(20,184,166,0.12)', color: '#14b8a6', border: '1px solid rgba(20,184,166,0.25)' }}>
              {connected.length} connected
            </span>
          )}
        </div>
        <button
          onClick={() => void loadCatalog(query.trim())}
          aria-label="Refresh app catalog"
          className="p-1 rounded"
          style={{ color: 'var(--gia-muted-2)' }}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Connected list */}
      {connected.length > 0 && (
        <div className="flex flex-col gap-1.5 mb-3" data-testid="composio-connected">
          {connected.map(t => {
            const pill = STATUS_PILL[String(t.meta?.status || 'ACTIVE').toUpperCase()] ?? STATUS_PILL.ACTIVE;
            const accId = accountIdOf(t);
            return (
              <div key={t.slug} className="flex items-center gap-2 px-2.5 py-2 rounded-lg" style={{ background: 'var(--gia-bg)', border: '1px solid var(--gia-border)' }}>
                <ShieldCheck size={13} style={{ color: pill.fg }} />
                <span className="text-xs flex-1 truncate" style={{ color: 'var(--gia-text)' }}>{t.name || t.slug}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: pill.bg, color: pill.fg }}>{pill.label}</span>
                {accId && (
                  <button
                    onClick={() => void handleDisconnect(t.slug, accId)}
                    aria-label={`Disconnect ${t.name || t.slug}`}
                    title="Disconnect this app"
                    className="p-1 rounded"
                    style={{ color: 'var(--gia-muted-2)' }}
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Catalog search */}
      <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg mb-2" style={{ background: 'var(--gia-bg)', border: '1px solid var(--gia-border)' }}>
        <Search size={12} style={{ color: 'var(--gia-muted-2)' }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search 1,500+ apps — slack, github, notion…"
          aria-label="Search Composio app catalog"
          className="flex-1 bg-transparent text-xs outline-none"
          style={{ color: 'var(--gia-text)' }}
        />
      </div>

      {/* Catalog grid */}
      <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto" data-testid="composio-catalog">
        {catalog.map(t => {
          const isConn = !!t.meta?.connected;
          const phase = connectPhase[t.slug] ?? 'idle';
          return (
            <div key={t.slug} className="flex items-center gap-2 px-2.5 py-2 rounded-lg" style={{ background: 'var(--gia-bg)', border: '1px solid var(--gia-border)' }}>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate" style={{ color: 'var(--gia-text)' }}>{t.name || t.slug}</p>
                {t.description && (
                  <p className="text-[10px] truncate" style={{ color: 'var(--gia-muted-2)' }}>{t.description}</p>
                )}
              </div>
              {isConn ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0" style={{ background: STATUS_PILL.ACTIVE.bg, color: STATUS_PILL.ACTIVE.fg }}>✓ connected</span>
              ) : (
                <button
                  onClick={() => void handleConnect(t.slug)}
                  disabled={phase === 'opening' || phase === 'waiting'}
                  className="text-[11px] px-2.5 py-1 rounded-md font-medium shrink-0 disabled:opacity-60"
                  style={{ background: 'var(--gia-accent)', color: 'var(--gia-accent-contrast)' }}
                >
                  {phase === 'opening' ? 'Opening…' : phase === 'waiting' ? 'Waiting…' : 'Connect'}
                </button>
              )}
            </div>
          );
        })}
        {!loading && catalog.length === 0 && (
          <p className="text-[11px] text-center py-3" style={{ color: 'var(--gia-muted-2)' }}>
            {query ? 'No apps match that search.' : 'Catalog is loading…'}
          </p>
        )}
      </div>

      {/* Waiting banner for in-flight consent */}
      {Object.entries(connectPhase).some(([, ph]) => ph === 'waiting') && (
        <div className="mt-2 px-2.5 py-2 rounded-lg text-[11px] flex items-center justify-between gap-2" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#f59e0b' }}>
          <span>Finish the consent screen in your browser — GIA checks automatically.</span>
          {Object.entries(connectPhase).filter(([, ph]) => ph === 'waiting').map(([slug]) => (
            <button key={slug} onClick={() => void pollAttempt(slug)} className="shrink-0 underline">
              Check {slug}
            </button>
          ))}
        </div>
      )}

      {notice && <p className="text-[11px] mt-2" style={{ color: '#14b8a6' }}>{notice}</p>}
      {error && <p className="text-[11px] mt-2" style={{ color: '#ef4444' }}>{error}</p>}

      <div className="flex items-center gap-1.5 mt-3 text-[10px]" style={{ color: 'var(--gia-muted-2)' }}>
        <KeyRound size={9} />
        Key stored in the OS keychain. Actions run through GIA's permission gate; OAuth tokens stay with Composio.
      </div>
    </div>
  );
};

export default ComposioSection;
