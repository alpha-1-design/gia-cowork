import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BrowserPanel } from '../BrowserPanel';
import { browserSession } from '../../services/browser/BrowserSession';

function htmlResponse(body: string, url = 'https://example.com/') {
  return {
    ok: true, status: 200, url,
    headers: { get: (k: string) => (k.toLowerCase() === 'set-cookie' ? 'session=abc; Path=/' : 'text/html') },
    text: async () => body,
  } as unknown as Response;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  browserSession.closeAll();
  fetchSpy = vi.fn(async () => htmlResponse('<h1>Example</h1><button>Click me</button>'));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  browserSession.closeAll();
});

describe('BrowserPanel — making agent browsing visible', () => {
  it('explains itself when the agent is not browsing', () => {
    render(<BrowserPanel />);
    // An empty panel must say why, not sit blank looking broken.
    expect(screen.getByText('No tabs open')).toBeInTheDocument();
  });

  it('appears as soon as the agent opens a page, without a refresh', async () => {
    render(<BrowserPanel />);
    expect(screen.getByText('No tabs open')).toBeInTheDocument();

    await browserSession.open('https://example.com/');

    await waitFor(() => expect(screen.getByTestId('browser-panel')).toBeInTheDocument());
    expect(screen.getByTestId('browser-frame-host')).toBeInTheDocument();
  });

  it('shows the real live frame, not a reconstruction of it', async () => {
    render(<BrowserPanel />);
    const opened = await browserSession.open('https://example.com/');

    await waitFor(() => expect(screen.getByTestId('browser-frame-host')).toBeInTheDocument());
    const host = screen.getByTestId('browser-frame-host');
    // The whole point: the panel hosts the ACTUAL tab document, so what the
    // user sees is genuinely what the agent is acting on.
    expect(host.querySelector('iframe')).not.toBeNull();
    expect(host.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Click me');
    expect(opened.tabId).toBeTruthy();
  });

  it('lists every open tab in the strip', async () => {
    render(<BrowserPanel />);
    const a = await browserSession.open('https://a.example/');
    fetchSpy.mockResolvedValue(htmlResponse('<h1>B</h1>', 'https://b.example/'));
    const b = await browserSession.open('https://b.example/');

    await waitFor(() => expect(screen.getByTestId(`browser-tab-${a.tabId}`)).toBeInTheDocument());
    expect(screen.getByTestId(`browser-tab-${b.tabId}`)).toBeInTheDocument();
    // Tab ids must be distinct, or two live pages share one strip button.
    expect(a.tabId).not.toBe(b.tabId);
  });

  it('keeps every tab alive when the user looks at another one', async () => {
    render(<BrowserPanel />);
    const a = await browserSession.open('https://a.example/');
    fetchSpy.mockResolvedValue(htmlResponse('<h1>B</h1>', 'https://b.example/'));
    const b = await browserSession.open('https://b.example/');

    await waitFor(() => expect(screen.getByTestId(`browser-tab-${a.tabId}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`browser-tab-${a.tabId}`));

    // Switching the view must not close a tab the agent is still using.
    expect(browserSession.has(a.tabId)).toBe(true);
    expect(browserSession.has(b.tabId)).toBe(true);
  });

  it('shows the URL so you know which site is being touched', async () => {
    render(<BrowserPanel />);
    await browserSession.open('https://example.com/private');
    // You cannot judge the risk of an action without knowing which site it is
    // happening on, so the URL is always on screen.
    await waitFor(() => expect(screen.getByText('https://example.com/')).toBeInTheDocument());
  });

  it('warns when the page is a sign-in wall rather than content', async () => {
    fetchSpy.mockResolvedValue(htmlResponse('<form><input type="password"><button>Log in</button></form>'));
    render(<BrowserPanel />);
    await browserSession.open('https://example.com/private');

    // The honest answer to "why can't she just log in" — visible, not inferred.
    await waitFor(() => expect(screen.getByTestId('browser-auth-wall')).toBeInTheDocument());
    expect(screen.getByTestId('browser-auth-wall')).toHaveTextContent(/Sign-in/);
  });

  it('says nothing about auth on an ordinary page', async () => {
    render(<BrowserPanel />);
    await browserSession.open('https://example.com/article');
    await waitFor(() => expect(screen.getByTestId('browser-frame-host')).toBeInTheDocument());
    expect(screen.queryByTestId('browser-auth-wall')).toBeNull();
  });

  it('closes a tab from the panel', async () => {
    render(<BrowserPanel />);
    await browserSession.open('https://example.com/');
    await waitFor(() => expect(screen.getByText('Close tab')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Close tab'));
    expect(browserSession.size).toBe(0);
  });

  it('returns to the empty state when the last tab closes', async () => {
    render(<BrowserPanel />);
    await browserSession.open('https://example.com/');
    await waitFor(() => expect(screen.getByText('Close tab')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Close tab'));
    await waitFor(() => expect(screen.getByText('No tabs open')).toBeInTheDocument());
  });
});