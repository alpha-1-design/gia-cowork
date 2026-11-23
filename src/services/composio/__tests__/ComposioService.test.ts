import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * ComposioService — the OAuth connector rail, against the REAL v3.1
 * endpoint shapes (fetched). The mocks assert the wire contract, not an
 * imaginary one: session creation, Connect Link, status polling, meta
 * search, execute-by-slug with the result_type envelope.
 */

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const vault = new Map<string, string>();
vi.mock('../../CredentialVault', () => ({
  default: {
    get: vi.fn(async (id: string) => vault.get(id) ?? ''),
    set: vi.fn(async (id: string, v: string) => { vault.set(id, v); }),
    delete: vi.fn(async (id: string) => { vault.delete(id); }),
  },
}));
vi.mock('../../platform', () => ({ isTauri: () => false }));

import composioService from '../ComposioService';

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vault.clear();
  try { localStorage.clear(); } catch { /* ignore */ }
  fetchMock.mockReset();
  // Reach the private state through a controlled reset: clearConfig wipes it.
  composioService.clearConfig();
});

afterEach(() => {
  composioService.clearConfig();
});

describe('ComposioService — config', () => {
  it('isConfigured flips only after a key is saved; the key round-trips from the vault', async () => {
    expect(await composioService.isConfigured()).toBe(false);
    await composioService.setApiKey('cpk_test_123');
    expect(await composioService.isConfigured()).toBe(true);
    expect(vault.get('composio')).toBe('cpk_test_123');
    expect(await composioService.getApiKey()).toBe('cpk_test_123');
  });

  it('clearConfig wipes the vault entry and the stored session', async () => {
    await composioService.setApiKey('cpk_test_123');
    localStorage.setItem('gia-composio-session', 'sess_old');
    await composioService.clearConfig();
    expect(vault.has('composio')).toBe(false);
    expect(localStorage.getItem('gia-composio-session')).toBeNull();
  });
});

describe('ComposioService — session + catalog', () => {
  it('creates a session once, persists it, and reuses it (no duplicate creates)', async () => {
    await composioService.setApiKey('cpk_test_123');
    fetchMock.mockImplementation(((url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/tool_router/session') && init?.method === 'POST') {
        return Promise.resolve(jsonRes({ session_id: 'sess_1' }));
      }
      return Promise.resolve(jsonRes({ items: [] }));
    }) as typeof fetch);

    // Catalog listing needs NO session (Composio: "listing apps does not need
    // a user id") — the session is created by the first user-scoped call.
    await composioService.listToolkits({ limit: 5 });
    await composioService.connectedToolkits();
    await composioService.connectedToolkits();

    const createCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith('/tool_router/session') && init?.method === 'POST',
    );
    expect(createCalls).toHaveLength(1);
    const [, init] = createCalls[0];
    const body = JSON.parse(init.body);
    expect(body.user_id).toBe('gia-desktop'); // never 'default'
    expect(body.manage_connections).toEqual({ enable: false });
    expect(localStorage.getItem('gia-composio-session')).toBe('sess_1');

    // Every request carries the key header.
    const anyCall = fetchMock.mock.calls[0];
    expect(anyCall[1].headers['x-api-key']).toBe('cpk_test_123');
  });

  it('unconfigured calls fail with an honest error, not a silent one', async () => {
    await expect(composioService.listToolkits()).rejects.toThrow(/not configured/);
  });

  it('HTTP errors surface the API detail from the error envelope', async () => {
    await composioService.setApiKey('cpk_test_123');
    fetchMock.mockResolvedValueOnce(jsonRes({ error: { message: 'Invalid API key' } }, 401));
    await expect(composioService.listToolkits()).rejects.toThrow(/401.*Invalid API key/);
  });
});

describe('ComposioService — connect flow', () => {
  beforeEach(async () => {
    await composioService.setApiKey('cpk_test_123');
  });
  const attempt = () => ({
    redirectUrl: 'https://connect.composio.dev/link/ln_1',
    connectedAccountId: 'ca_1',
    toolkit: 'github',
  });

  it('connect returns the hosted link + account id; no callback_url (desktop, no local server)', async () => {
    await composioService.setApiKey('cpk_test_123');
    fetchMock
      .mockResolvedValueOnce(jsonRes({ session_id: 'sess_1' }))
      .mockResolvedValueOnce(jsonRes({ redirect_url: 'https://connect.composio.dev/link/ln_1', connected_account_id: 'ca_1' }));

    const a = await composioService.connect('github');
    expect(a.redirectUrl).toContain('connect.composio.dev');
    expect(a.connectedAccountId).toBe('ca_1');
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).includes('/link'))!;
    expect(JSON.parse(init.body)).toEqual({ toolkit: 'github' });
  });

  it('waitForConnection resolves connected on ACTIVE and keeps polling through transient errors', async () => {
    const a = attempt();
    fetchMock
      .mockRejectedValueOnce(new TypeError('network blip')) // transient poll error
      .mockResolvedValueOnce(jsonRes({ status: 'INITIATED' }))
      .mockImplementation(() => Promise.resolve(jsonRes({ status: 'ACTIVE' })));

    const res = await composioService.waitForConnection(a, 15_000, 5);
    expect(res).toEqual({ connected: true, status: 'ACTIVE' });
  });

  it('waitForConnection reports terminal failure honestly (FAILED/REVOKED)', async () => {
    const a = attempt();
    fetchMock.mockImplementation(() => Promise.resolve(jsonRes({ status: 'FAILED' })));
    const res = await composioService.waitForConnection(a, 10_000, 5);
    expect(res).toEqual({ connected: false, status: 'FAILED' });
  });

  it('a still-INITIATED wait ends as INITIATED, not as a false "failed"', async () => {
    const a = attempt();
    fetchMock.mockImplementation(() => Promise.resolve(jsonRes({ status: 'INITIATED' })));
    const res = await composioService.waitForConnection(a, 40, 10);
    expect(res.status).toBe('INITIATED');
    expect(res.connected).toBe(false);
  });
});

describe('ComposioService — discovery + execution', () => {
  beforeEach(async () => {
    await composioService.setApiKey('cpk_test_123');
  });
  it('searchTools unwraps the meta-tool envelope into flat hits', async () => {
    await composioService.setApiKey('cpk_test_123');
    fetchMock
      .mockResolvedValueOnce(jsonRes({ session_id: 'sess_1' }))
      .mockResolvedValueOnce(jsonRes({
        data: {
          successful: true,
          data: {
            results: [
              { slug: 'SLACK_SEND_MESSAGE', description: 'Send a message', toolkit: 'slack' },
              { slug: 'GMAIL_SEND_EMAIL', description: 'Send an email', toolkit: 'gmail' },
            ],
          },
        },
      }));

    const hits = await composioService.searchTools('send a message');
    expect(hits.map(h => h.slug)).toEqual(['SLACK_SEND_MESSAGE', 'GMAIL_SEND_EMAIL']);
  });

  it('executeTool succeeds on result_type success and fails on failed (even with empty error text)', async () => {
    await composioService.setApiKey('cpk_test_123');
    fetchMock
      .mockResolvedValueOnce(jsonRes({ session_id: 'sess_1' }))
      .mockResolvedValueOnce(jsonRes({ result_type: 'success', data: { ok: true }, log_id: 'log_1' }));
    const ok = await composioService.executeTool('GITHUB_CREATE_AN_ISSUE', { title: 'x' });
    expect(ok.ok).toBe(true);
    expect(ok.logId).toBe('log_1');

    fetchMock.mockResolvedValueOnce(jsonRes({ result_type: 'failed', error: '', log_id: 'log_2' }));
    const bad = await composioService.executeTool('GITHUB_CREATE_AN_ISSUE', { title: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/failed/);
  });
});
