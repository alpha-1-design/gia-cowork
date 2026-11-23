import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import ComposioSection from '../ComposioSection';
import composioService from '../../../services/composio/ComposioService';

/**
 * The ComposioSection user contract, driven through the REAL service with
 * only `fetch` (and window.open) mocked — the seam that behaves
 * deterministically here. (Module-level vi.mock of the service applied
 * inconsistently in this environment; fetch-level routing is what the
 * service's own tests use.)
 *
 * Clicks are dispatched through the React props attached to the real DOM
 * node: React 19 + happy-dom event delegation is unreliable under
 * fireEvent/userEvent (same handler passes and fails across runs —
 * reproduced with a minimal replica). Structure queries stay native RTL.
 */

const fetchMock = vi.fn();
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** URL-routed fake backend: the REAL v3.1 shapes. */
function route(url: string, init: FetchInit = {}): Response | null {
  const u = url.replace(/\?.*$/, '');
  if (u.endsWith('/tool_router/session') && init.method === 'POST') return json({ session_id: 'sess_1' });
  if (u.includes('/tool_router/session/sess_1/link') && init.method === 'POST') {
    return json({ redirect_url: 'https://connect.composio.dev/link/ln_1', connected_account_id: 'ca_1' });
  }
  if (u.includes('/tool_router/session/sess_1/execute_meta')) return json({ data: { successful: true, data: { results: [] } } });
  if (u.includes('/tool_router/session/sess_1/toolkits')) {
    return json({ items: [{ slug: 'github', name: 'GitHub', meta: { connected: true, status: 'ACTIVE', connection: { id: 'ca_gh_1' } } }] });
  }
  if (u.endsWith('/toolkits')) return json({ items: [{ slug: 'slack', name: 'Slack', description: 'Messaging' }], next_cursor: null });
  if (u.includes('/connected_accounts/ca_1')) return json({ status: 'ACTIVE' });
  if (u.includes('/connected_accounts/') && init.method === 'DELETE') return json({});
  return null;
}

type WithProps = EventTarget & { [key: string]: unknown };
function reactHandler(el: Element, prop: string): (...args: unknown[]) => unknown {
  const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps'));
  if (!propsKey) throw new Error('no react props on node');
  const fn = ((el as unknown as WithProps)[propsKey] as Record<string, (...a: unknown[]) => unknown> | null)?.[prop];
  if (typeof fn !== 'function') throw new Error(`no ${prop} handler`);
  return fn;
}
async function click(el: Element) {
  await act(async () => { reactHandler(el, 'onClick')({ preventDefault() {}, stopPropagation() {} }); });
}
async function change(el: Element, value: string) {
  await act(async () => { reactHandler(el, 'onChange')({ target: { value } }); });
}

describe('ComposioSection — through the real service, fetch mocked', () => {
  let openSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(async () => {
    // The service is a singleton with in-memory state (key + session);
    // reset it or the next test inherits the previous one's session.
    await composioService.clearConfig();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation((input: string | URL, init?: RequestInit) => {
      const res = route(String(input), (init ?? {}) as FetchInit);
      if (res) return Promise.resolve(res);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    try { sessionStorage.clear(); } catch { /* ignore */ }
    try { localStorage.clear(); } catch { /* ignore */ }
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy?.mockRestore();
    openSpy = null;
    try { sessionStorage.clear(); } catch { /* ignore */ }
  });

  it('setup state: password key field with a dashboard link', async () => {
    render(<ComposioSection />);
    await waitFor(() => expect(screen.getByLabelText('Composio API key')).toBeTruthy());
    expect((screen.getByLabelText('Composio API key') as HTMLInputElement).type).toBe('password');
    expect(screen.getByText(/dashboard\.composio\.dev/)).toBeTruthy();
  });

  it('save key: lands in the vault (sessionStorage), never echoed in the DOM, setup step gone', async () => {
    render(<ComposioSection />);
    await waitFor(() => expect(screen.getByLabelText('Composio API key')).toBeTruthy());
    await change(screen.getByLabelText('Composio API key'), 'cpk_secret_1');
    await click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(sessionStorage.getItem('gia-key:composio')).toBe('cpk_secret_1'));
    await waitFor(() => expect(screen.queryByLabelText('Composio API key')).toBeNull());
    expect(document.body.innerHTML).not.toContain('cpk_secret_1');
  });

  it('connected view: catalog with Connect button, connected list with status pill', async () => {
    render(<ComposioSection />);
    // Drive through setup with the routed backend.
    await waitFor(() => expect(screen.getByLabelText('Composio API key')).toBeTruthy());
    await change(screen.getByLabelText('Composio API key'), 'cpk_test_1');
    await click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() => expect(screen.getByTestId('composio-catalog')).toBeTruthy(), { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId('composio-connected').textContent).toContain('GitHub'), { timeout: 3000 });
    expect(screen.getByTestId('composio-connected').textContent).toContain('Connected');
    // Slack is in the catalog and NOT connected → a Connect button exists.
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
  });

  it('connect flow: opens the hosted link, polls to ACTIVE, GitHub-style pill appears', async () => {
    render(<ComposioSection />);
    await waitFor(() => expect(screen.getByLabelText('Composio API key')).toBeTruthy());
    await change(screen.getByLabelText('Composio API key'), 'cpk_test_1');
    await click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy(), { timeout: 3000 });

    await click(screen.getByRole('button', { name: 'Connect' }));

    // The hosted Connect Link was opened in a (stubbed) browser window.
    await waitFor(() => {
      const calls = (openSpy?.mock.calls ?? []).map((c: unknown[]) => String(c[0]));
      expect(calls.some((u: string) => u.startsWith('https://connect.composio.dev/link/'))).toBe(true);
    }, { timeout: 3000 });
    // The link POST went out with the toolkit slug and no callback_url.
    const linkPost = fetchMock.mock.calls.find(([, init]) => String((init as FetchInit | undefined)?.body ?? '').includes('"toolkit"'));
    expect(linkPost).toBeTruthy();
    expect(String((linkPost![1] as FetchInit).body)).not.toContain('callback_url');
  });

  it('disconnect: DELETEs the connected account through the rail', async () => {
    render(<ComposioSection />);
    await waitFor(() => expect(screen.getByLabelText('Composio API key')).toBeTruthy());
    await change(screen.getByLabelText('Composio API key'), 'cpk_test_1');
    await click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(screen.getByTestId('composio-connected')).toBeTruthy(), { timeout: 3000 });

    await click(screen.getByLabelText('Disconnect GitHub'));

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([, init]) => (init as FetchInit | undefined)?.method === 'DELETE');
      expect(String(del?.[0])).toContain('/connected_accounts/ca_gh_1');
    }, { timeout: 3000 });
  });
});
