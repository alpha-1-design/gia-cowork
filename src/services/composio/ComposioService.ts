import credentialVault from '../CredentialVault';
import { logger } from '../../utils/logger';
import { isTauri } from '../../platform';

/**
 * ComposioService — OAuth connectors for 1,500+ apps, via Composio's
 * session API (REST v3.1). No SDK: their TypeScript SDK is Node-ESM and
 * server-shaped, while GIA runs in a WebView; the backend's CORS is
 * origin-reflecting, so plain `fetch` with `x-api-key` works everywhere.
 *
 * Design follows Composio's own "harness integration" pattern (their docs
 * call it that): GIA already owns the planner, the tool loop, the permission
 * gate and the traces. Composio sells four things underneath it:
 *
 *   1. the app catalog           → listToolkits()
 *   2. managed OAuth connect     → connect() opens a hosted Connect Link;
 *                                  tokens never touch GIA
 *   3. tool schemas              → searchTools() (meta search by use case)
 *   4. execution                 → executeTool() by slug
 *
 * Identity: GIA is a single-user desktop app, so the Composio user_id is the
 * stable local constant GIA_DESKTOP_USER. Never 'default' (their docs warn:
 * a shared user id exposes other users' connections).
 *
 * Secret discipline: the Composio API key lives in CredentialVault (OS
 * keychain on desktop, sessionStorage in the browser preview). Nothing
 * secret is ever written to localStorage — only the non-secret session id.
 */

const BASE = 'https://backend.composio.dev/api/v3.1';
const VAULT_ID = 'composio';
const SESSION_KEY = 'gia-composio-session';
export const GIA_DESKTOP_USER = 'gia-desktop';

export interface ComposioToolkit {
  slug: string;
  name: string;
  description?: string;
  logo?: string;
  isNoAuth?: boolean;
  meta?: { connected?: boolean; status?: string } | null;
}

export interface ConnectAttempt {
  toolkit: string;
  redirectUrl: string;
  connectedAccountId: string;
}

export interface ComposioSearchHit {
  slug: string;
  name?: string;
  description?: string;
  toolkit?: string;
  inputSchema?: unknown;
}

export interface ComposioExecResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  logId?: string;
}

class ComposioService {
  private key: string | null = null;
  private keyLoaded = false;
  private sessionId: string | null = null;
  /** In-flight connect attempts, by toolkit slug — the polling UI reads these. */
  private pendingConnects = new Map<string, ConnectAttempt>();

  /** Is Composio set up at all (key present)? Never throws. */
  async isConfigured(): Promise<boolean> {
    const key = await this.getApiKey();
    return key.length > 0;
  }

  async getApiKey(): Promise<string> {
    if (this.key !== null) return this.key;
    if (this.keyLoaded) return '';
    this.keyLoaded = true;
    try {
      this.key = await credentialVault.get(VAULT_ID);
    } catch (e) {
      logger.warn('[Composio] key load failed:', e instanceof Error ? e.message : e);
      this.key = '';
    }
    return this.key ?? '';
  }

  async setApiKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) throw new Error('API key cannot be empty');
    await credentialVault.set(VAULT_ID, trimmed);
    this.key = trimmed;
    this.keyLoaded = true;
  }

  async clearConfig(): Promise<void> {
    await credentialVault.delete(VAULT_ID).catch(() => undefined);
    this.key = '';
    this.sessionId = null;
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }

  // ── Session ────────────────────────────────────────────────────────────

  /**
   * A session is the per-user runtime context on Composio's side. Sessions
   * persist server-side and don't expire, so GIA creates one and reuses it.
   */
  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    try { this.sessionId = localStorage.getItem(SESSION_KEY) || null; } catch { /* ignore */ }
    if (this.sessionId) return this.sessionId;
    const body = {
      user_id: GIA_DESKTOP_USER,
      manage_connections: { enable: false }, // the settings page manages connects
      workbench: { enable: false },          // GIA has its own filesystem
    };
    const res = await this.request('tool_router/session', { method: 'POST', body });
    this.sessionId = String(res.session_id || '');
    if (!this.sessionId) throw new Error('Composio did not return a session id');
    try { localStorage.setItem(SESSION_KEY, this.sessionId); } catch { /* ignore */ }
    return this.sessionId;
  }

  async resetSession(): Promise<void> {
    this.sessionId = null;
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }

  // ── Catalog + connection state ─────────────────────────────────────────

  async listToolkits(opts: { search?: string; cursor?: string; limit?: number } = {}): Promise<{ items: ComposioToolkit[]; nextCursor: string | null }> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 30) });
    if (opts.search) params.set('search', opts.search);
    if (opts.cursor) params.set('cursor', opts.cursor);
    const res = await this.request(`toolkits?${params.toString()}`);
    return {
      items: Array.isArray(res.items) ? res.items : [],
      nextCursor: typeof res.next_cursor === 'string' ? res.next_cursor : null,
    };
  }

  /** Merge connection state into the catalog for this user's session. */
  async connectedToolkits(): Promise<ComposioToolkit[]> {
    const sid = await this.ensureSession();
    const res = await this.request(`tool_router/session/${sid}/toolkits?is_connected=true&limit=100`);
    return Array.isArray(res.items) ? res.items : [];
  }

  // ── Connect flow (OAuth, hosted by Composio) ───────────────────────────

  /**
   * Start a connect: returns the hosted Connect Link for the user's browser.
   * No callback_url — there is no local HTTP server to land on in a desktop
   * app; completion is observed by polling waitForConnection().
   */
  async connect(toolkitSlug: string): Promise<ConnectAttempt> {
    const sid = await this.ensureSession();
    const res = await this.request(`tool_router/session/${sid}/link`, {
      method: 'POST',
      body: { toolkit: toolkitSlug },
    });
    const attempt: ConnectAttempt = {
      toolkit: toolkitSlug,
      redirectUrl: String(res.redirect_url || ''),
      connectedAccountId: String(res.connected_account_id || ''),
    };
    if (!attempt.redirectUrl || !attempt.connectedAccountId) {
      throw new Error('Composio did not return a Connect Link');
    }
    this.pendingConnects.set(toolkitSlug, attempt);
    return attempt;
  }

  /**
   * Poll the connected account until auth completes. Resolves connected=true
   * when ACTIVE, connected=false on terminal failure, and throws on transport
   * errors only. Default budget ~90s (OAuth consent screens take a minute).
   */
  async waitForConnection(attempt: ConnectAttempt, timeoutMs = 90_000, pollMs = 2_000): Promise<{ connected: boolean; status: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      let account: { status?: string };
      try {
        account = await this.request(`connected_accounts/${attempt.connectedAccountId}`);
      } catch (e) {
        // Only NETWORK transport errors (fetch failures) are retryable.
        // A config/auth error would loop forever, so it propagates honestly.
        if (!(e instanceof TypeError)) throw e;
        logger.warn('[Composio] poll failed, retrying:', e instanceof Error ? e.message : e);
        continue;
      }
      const status = String(account.status || '').toUpperCase();
      if (status === 'ACTIVE') return { connected: true, status };
      if (['FAILED', 'EXPIRED', 'INACTIVE', 'REVOKED'].includes(status)) {
        this.pendingConnects.delete(attempt.toolkit);
        return { connected: false, status };
      }
    }
    // Still INITIATED when the budget runs out — the user may still be in
    // the consent screen; surface that honestly instead of timing out to a lie.
    return { connected: false, status: 'INITIATED' };
  }

  peekPendingConnect(toolkit: string): ConnectAttempt | undefined {
    return this.pendingConnects.get(toolkit);
  }

  /** Drop a connect attempt without judgement (user closed the browser tab). */
  abandonConnect(toolkit: string): void {
    this.pendingConnects.delete(toolkit);
  }

  async disconnect(connectedAccountId: string): Promise<void> {
    await this.request(`connected_accounts/${connectedAccountId}`, { method: 'DELETE' });
  }

  // ── Tool discovery + execution (the agent surface) ─────────────────────

  /** Meta search: "send an email" → concrete tool slugs with schemas. */
  async searchTools(useCase: string, limit = 5): Promise<ComposioSearchHit[]> {
    const sid = await this.ensureSession();
    const res = await this.request(`tool_router/session/${sid}/execute_meta`, {
      method: 'POST',
      body: { slug: 'COMPOSIO_SEARCH_TOOLS', arguments: { queries: [{ use_case: useCase, limit }] } },
    });
    const data = res.data as { successful?: boolean; data?: { results?: unknown[] } } | undefined;
    const results = Array.isArray(data?.data?.results) ? data?.data?.results : Array.isArray(data) ? data : [];
    return (results as ComposioSearchHit[]).map(hit => ({
      slug: String(hit.slug || hit.name || ''),
      name: hit.name,
      description: hit.description,
      toolkit: hit.toolkit,
      inputSchema: hit.inputSchema,
    })).filter(hit => hit.slug);
  }

  /** Execute one tool by slug as the connected user. */
  async executeTool(toolSlug: string, args: Record<string, unknown> = {}): Promise<ComposioExecResult> {
    const sid = await this.ensureSession();
    const res = await this.request(`tool_router/session/${sid}/execute`, {
      method: 'POST',
      body: { tool_slug: toolSlug, arguments: args },
    });
    // Their envelope: result_type in ('success'|'failed'), plus data/error/log_id.
    // Check result_type, not error — a failed call can have empty error text.
    const resultType = String(res.result_type ?? res.resultType ?? 'success');
    const ok = resultType !== 'failed';
    return {
      ok,
      data: res.data,
      error: ok ? undefined : String(res.error || `Tool execution failed (${resultType})`),
      logId: res.log_id !== undefined ? String(res.log_id) : res.logId !== undefined ? String(res.logId) : undefined,
    };
  }

  // ── Transport ──────────────────────────────────────────────────────────

  private async request(path: string, opts: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {}): Promise<Record<string, unknown>> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error('Composio is not configured — add your API key first.');
    const method = opts.method ?? 'GET';
    const res = await fetch(`${BASE}/${path}`, {
      method,
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const err = await res.json() as { error?: { message?: string }; message?: string };
        detail = err.error?.message || err.message || '';
      } catch { /* non-JSON error body */ }
      throw new Error(`Composio ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error('Composio returned a non-JSON response');
    }
  }

  /** True when running inside the Tauri shell (system-browser connect works). */
  get canOpenSystemBrowser(): boolean {
    return isTauri();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export const composioService = new ComposioService();
export default composioService;
