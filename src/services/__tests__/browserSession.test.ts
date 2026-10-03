import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { browserSession } from '../browser/BrowserSession';

/**
 * These exercise tab IDENTITY and the ref lifecycle — the two things that were
 * impossible before and are the entire reason this module exists.
 *
 * Network is stubbed at fetch, so `open()` runs the real path end to end
 * without touching the network.
 */

function htmlResponse(body: string) {
  return {
    ok: true,
    status: 200,
    url: 'https://example.com/',
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => body,
  } as unknown as Response;
}

const FORM = `
  <h1>Sign in</h1>
  <label for="e">Email</label><input id="e" type="email" />
  <label for="p">Password</label><input id="p" type="password" />
  <button type="submit">Sign in</button>
`;

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  browserSession.closeAll();
  fetchSpy = vi.fn(async () => htmlResponse(FORM));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  browserSession.closeAll();
});

describe('tabs have identity', () => {
  it('returns a tab id and keeps it usable across calls', async () => {
    const first = await browserSession.open('https://example.com');
    expect(first.tabId).toMatch(/^t/);

    // This is the capability that did not exist before: acting on the page you
    // are already on, rather than re-fetching a URL and losing all state.
    expect(browserSession.has(first.tabId)).toBe(true);
    expect(browserSession.list()).toHaveLength(1);
  });

  it('gives each tab a distinct id', async () => {
    const a = await browserSession.open('https://a.example');
    const b = await browserSession.open('https://b.example');
    expect(a.tabId).not.toBe(b.tabId);
    expect(browserSession.list()).toHaveLength(2);
  });

  it('closes only the tab asked for', async () => {
    const a = await browserSession.open('https://a.example');
    const b = await browserSession.open('https://b.example');
    browserSession.close(a.tabId);
    expect(browserSession.has(a.tabId)).toBe(false);
    expect(browserSession.has(b.tabId)).toBe(true);
  });

  it('tells the model what it has open when it loses track', () => {
    expect(browserSession.hint()).toMatch(/no tabs open/i);
  });

  it('caps how many tabs can be open at once', async () => {
    for (let i = 0; i < 10; i++) await browserSession.open(`https://e${i}.example`);
    // Bounded, because each tab is a live document holding real memory. The
    // limit evicts the oldest rather than refusing, so the tool still works.
    expect(browserSession.size).toBeLessThanOrEqual(8);
  }, 20_000);
});

describe('refs resolve to real elements', () => {
  it('addresses an element by ref from the snapshot', async () => {
    const opened = await browserSession.open('https://example.com');
    const ref = opened.snapshot.match(/(e\d+) button "Sign in"/)?.[1];
    expect(ref).toBeTruthy();

    const res = await browserSession.click(opened.tabId, ref!);
    expect(res.ok).toBe(true);
  });

  it('types into a field by ref and fires the events a form listens for', async () => {
    const opened = await browserSession.open('https://example.com');
    const ref = opened.snapshot.match(/(e\d+) textbox "Email"/)?.[1];
    expect(ref).toBeTruthy();

    const res = browserSession.type(opened.tabId, ref!, 'me@example.com');
    expect(res.ok).toBe(true);

    const snap = browserSession.snapshot(opened.tabId);
    // A programmatic value assignment alone would be invisible to a
    // framework-controlled input, so this is the assertion that matters.
    expect(snap.message).toContain('me@example.com');
  });

  it('refuses a ref that is not on the current snapshot, and says why', async () => {
    const opened = await browserSession.open('https://example.com');
    const res = await browserSession.click(opened.tabId, 'e999');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('stale_ref');
    // The error teaches the recovery, rather than just refusing.
    expect(res.message).toMatch(/browser_snapshot/);
  });

  it('reports an unknown tab with the list of real ones', async () => {
    const a = await browserSession.open('https://example.com');
    const res = await browserSession.click('t-nope', 'e1');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown_tab');
    expect(res.message).toContain(a.tabId);
  });
});

describe('operations', () => {
  it('scrolls and reports position', async () => {
    const opened = await browserSession.open('https://example.com');
    const res = browserSession.scroll(opened.tabId, 'bottom');
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/through the page/);
  });

  it('refuses to click a disabled control', async () => {
    fetchSpy.mockResolvedValue(htmlResponse('<button disabled>Nope</button>'));
    const opened = await browserSession.open('https://example.com');
    const ref = opened.snapshot.match(/(e\d+) button "Nope"/)?.[1];
    const res = await browserSession.click(opened.tabId, ref!);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('disabled');
  });
});

describe('navigation history', () => {
  it('goes back and forward through visited pages', async () => {
    fetchSpy.mockResolvedValue(htmlResponse('<a href="/next">Next page</a>'));
    const opened = await browserSession.open('https://a.example/');
    const tab = opened.tabId;
    const ref = opened.snapshot.match(/(e\d+) link "Next page"/)?.[1];
    expect(ref).toBeTruthy();

    // Following the link records a history entry and moves us to page B.
    fetchSpy.mockResolvedValue(htmlResponse('<h1>Page B</h1>'));
    await browserSession.click(tab, ref!);
    expect(browserSession.describe(tab).message).toMatch(/history: 2 pages \(position 2\)/);

    const back = await browserSession.go(tab, 'back');
    expect(back.ok).toBe(true);
    expect(browserSession.describe(tab).message).toMatch(/position 1\)/);

    const forward = await browserSession.go(tab, 'forward');
    expect(forward.ok).toBe(true);
    expect(browserSession.describe(tab).message).toMatch(/position 2\)/);
  }, 20_000);

  it('does not add a history entry for going back', async () => {
    const opened = await browserSession.open('https://a.example/');
    const before = browserSession.describe(opened.tabId).message;
    expect(before).toMatch(/history: 1 page \(position 1\)/);
    // Going back from the first page is an error, not a new entry.
    const res = await browserSession.go(opened.tabId, 'back');
    expect(res.reason).toBe('history_edge');
    expect(browserSession.describe(opened.tabId).message).toMatch(/history: 1 page \(position 1\)/);
  });

  it('reports where a tab is', async () => {
    const opened = await browserSession.open('https://a.example/');
    expect(browserSession.describe(opened.tabId).message).toMatch(/^tab \w+ — https:\/\//);
  });
});

describe('sessions survive navigation', () => {
  it('sends a stored cookie on the next request', async () => {
    const first = {
      ...htmlResponse('<h1>Login</h1>'),
      headers: {
        get: (k: string) => (k.toLowerCase() === 'set-cookie' ? 'session=abc; Path=/' : 'text/html'),
      },
    } as unknown as Response;
    fetchSpy.mockResolvedValueOnce(first);

    await browserSession.open('https://example.com/login');
    expect(browserSession.jar.headerFor('https://example.com/dashboard')).toBe('session=abc');

    // The replay is the point: without it every navigation after a sign-in
    // would arrive anonymous and the site would show the login form again.
    fetchSpy.mockResolvedValue(htmlResponse('<h1>Dashboard</h1>'));
    await browserSession.open('https://example.com/dashboard');
    const sent = fetchSpy.mock.calls.at(-1)?.[1]?.headers as Record<string, string>;
    expect(sent.Cookie).toBe('session=abc');
  });

  it('does not leak a session to another site', async () => {
    fetchSpy.mockResolvedValue({
      ...htmlResponse('<h1>Login</h1>'),
      headers: { get: (k: string) => (k.toLowerCase() === 'set-cookie' ? 'session=abc; Path=/' : 'text/html') },
    } as unknown as Response);
    await browserSession.open('https://example.com/login');

    fetchSpy.mockResolvedValue(htmlResponse('<h1>Other</h1>'));
    await browserSession.open('https://other.test/page');
    const sent = fetchSpy.mock.calls.at(-1)?.[1]?.headers as Record<string, string>;
    expect(sent.Cookie).toBeUndefined();
  });

  it('clears cookies when all tabs are closed', () => {
    browserSession.jar.storeFromHeaders('a=1; Path=/', 'https://example.com/');
    browserSession.closeAll();
    // "Clear browsing data" that leaves cookies behind is not clearing
    // anything a person would expect it to clear.
    expect(browserSession.jar.size).toBe(0);
  });
});

describe('auth walls are surfaced, not discovered by retrying', () => {
  it('reports a sign-in page instead of pretending it is content', async () => {
    fetchSpy.mockResolvedValue(htmlResponse(
      '<h1>Sign in</h1><form><input type="password"><button>Log in</button></form>'));
    const opened = await browserSession.open('https://example.com/private');
    expect(opened.authWall).toBeTruthy();
    expect(opened.advice).toMatch(/credentials|own browser/i);
  });

  it('says nothing when the page is real content', async () => {
    fetchSpy.mockResolvedValue(htmlResponse('<article><h1>A real page</h1><p>Actual prose about things.</p></article>'));
    const opened = await browserSession.open('https://example.com/article');
    expect(opened.authWall).toBeUndefined();
  });
});

function refOf(ref: string): string {
  return ref;
}