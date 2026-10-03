import { logger } from '../../utils/logger';
import { collectNodes, buildSnapshot, renderSnapshot, type PageSnapshot } from './snapshot';
import { CookieJar } from './cookies';
import { detectAuthWall, authWallAdvice } from './authWall';
import { corsProxy } from '../CorsProxy';

/**
 * Browser sessions — real tabs with real identity.
 *
 * The previous browser tooling had no concept of a page the agent was *on*.
 * Every call carried a full URL and re-fetched from scratch, so there was no
 * way to do anything with more than one step: you could not open a page, log
 * in, and then navigate from the page you just logged into, because nothing
 * persisted between calls. Multi-step work — the entire reason a browser exists
 * — was impossible by construction.
 *
 * So tabs are first-class here. `open` returns a `tabId`, and every subsequent
 * operation takes that id. That id is also what makes refs meaningful: a ref
 * like `e14` only means something relative to the snapshot you are holding, and
 * holding it means holding a tab.
 *
 * Scope, stated plainly so nobody is misled: each tab is a sandboxed document
 * rendered from fetched HTML. That gives real interaction — clicking, typing,
 * scrolling, link navigation, and state that survives across calls.
 *
 * Two things it is NOT:
 *
 *  - Not your browser profile. Logins that exist only in the user's own browser
 *    are unreachable, and no amount of work in this file changes that.
 *  - Not a guaranteed session. The cookie jar below does capture and replay
 *    cookies correctly, and that is tested. But `Cookie` is a forbidden header
 *    name on `fetch`, so whether the composed header actually reaches the
 *    origin depends on the transport: it survives when the request is proxied
 *    by something that forwards arbitrary headers, and is dropped by a direct
 *    webview fetch. Treat "my session persisted" as conditional on the proxy,
 *    not as guaranteed. Making it unconditional means fetching outside the
 *    webview, which is Rust work.
 *
 * Both limits belong in the tool descriptions, not in a README nobody reads.
 */

/** Cap concurrent tabs. Each one holds a live iframe with real memory. */
export const MAX_TABS = 8;
/** Tab ids are short so they cost nothing in context. */
const TAB_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export interface TabHandle {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  /** Live iframe. Kept in the document for the tab's whole lifetime. */
  frame: HTMLIFrameElement;
  doc: Document | null;
  /** ref -> element, from the most recent snapshot of this tab. */
  refs: Map<string, Element>;
  lastSnapshot: PageSnapshot | null;
  /**
   * Visited URLs for back/forward. The current position is `history[cursor]`;
   * navigating truncates everything after it, which is how real browsers treat
   * going back and then somewhere new.
   */
  history: string[];
  cursor: number;
}

export interface OpenResult {
  tabId: string;
  url: string;
  title: string;
  /** How many interactive elements the page exposed. */
  elementCount: number;
  snapshot: string;
  /** Set when the page is a login/paywall/consent wall rather than content. */
  authWall?: string;
  /** What to do about it, addressed to the model. */
  advice?: string;
}

export interface OpResult {
  ok: boolean;
  message: string;
  /** Set when the action was refused; explains why in model-facing words. */
  reason?: string;
}

let tabSeq = 0;

function makeTabId(): string {
  tabSeq += 1;
  let suffix = '';
  let n = tabSeq;
  // Base-36 from the current sequence, offset so ids never start at 'a000'.
  while (n > 0) {
    suffix = TAB_ID_ALPHABET[n % TAB_ID_ALPHABET.length] + suffix;
    n = Math.floor(n / TAB_ID_ALPHABET.length);
  }
  return `t${suffix}`;
}

function randomDelay(ms: number): Promise<void> {
  const jitter = Math.random() * 150;
  return new Promise(r => setTimeout(r, ms + jitter));
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

function stealthHeaders(): Record<string, string> {
  return {
    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Fetch-Mode': 'navigate',
    'Upgrade-Insecure-Requests': '1',
  };
}

/** Fetch the page and hand back rewritten HTML with a <base> so relative links work. */
export async function fetchPage(url: string, signal?: AbortSignal): Promise<{ html: string; finalUrl: string }> {
  // Two things a plain fetch cannot do, both of which decide whether this is
  // usable or a toy.
  //
  // Cookies: a login sets one on the response. Send them back on the next
  // request or every navigation after a sign-in silently resets to anonymous.
  //
  // Proxy: the app's webview is subject to CORS, so a direct cross-origin
  // fetch of a real website fails before a byte of HTML arrives. Routing
  // through the shared proxy — the same one read_url and the model providers
  // already use — is what makes ordinary sites load at all.
  const jar = browserSession.jar;
  const cookie = jar.headerFor(url);
  const headers = stealthHeaders();
  if (cookie) headers['Cookie'] = cookie;

  const res = await corsProxy.fetch(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: signal ?? AbortSignal.timeout(15000),
  });

  // Set-Cookie is a forbidden header name in a normal browser fetch, so this
  // often yields null — but through a proxy it is frequently passed through,
  // and when it is present the session becomes real rather than simulated.
  jar.storeFromHeaders(
    res.headers?.get?.('set-cookie') ?? null,
    url,
  );

  if (!res.ok) {
    if (res.status === 403) throw new Error(`Blocked (403) — ${new URL(url).hostname} may be behind Cloudflare.`);
    if (res.status === 429) throw new Error(`Rate limited (429) by ${new URL(url).hostname}.`);
    throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  }
  const contentType = res.headers.get('content-type') || '';
  const html = await res.text();
  const baseTag = `<base href="${res.url || url}">`;
  let rewritten = html.includes('<head>') ? html.replace('<head>', `<head>${baseTag}`) : html;
  if (!rewritten.includes(baseTag)) rewritten = rewritten.replace(/<body/i, `<head>${baseTag}</head><body`);
  if (!contentType.includes('text/html')) {
    // Not a page. Return it wrapped so it still renders as text.
    rewritten = `<html><head>${baseTag}</head><body><pre>${html.replace(/[<>&]/g, c => ({ '<': '&lt;', '!': '', '>': '&gt;', '&': '&amp;' }[c] ?? c))}</pre></body></html>`;
  }
  return { html: rewritten, finalUrl: res.url || url };
}

/**
 * Live tab manager.
 *
 * Deliberately a plain object rather than a zustand store: tab identity is
 * runtime state tied to iframes that must exist in a live document, and there
 * is nothing here worth persisting or rendering across app restarts. A tab that
 * outlived the app would point at a document that no longer exists.
 */
class BrowserSession {
  private tabs = new Map<string, TabHandle>();
  private host: HTMLDivElement | null = null;
  private listeners = new Set<() => void>();
  /**
   * Shared across tabs on purpose, scoped by domain inside. A session you
   * started in one tab is still a session when you move to another, which is
   * how a real browser behaves and how a login flow stays signed in.
   */
  readonly jar = new CookieJar();

  /**
   * Observe tab lifecycle.
   *
   * The tab map is deliberately not a zustand store: entries hold live iframes
   * tied to a running document, so there is nothing here worth persisting or
   * rendering across restarts. But React still has to see it, so this is the
   * seam rather than a store — a store would put unfalsifiable DOM objects
   * into devtools and persisted state for no benefit.
   */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  /**
   * Snapshot of tab identity for `useSyncExternalStore`. Must return the SAME
   * reference between real changes, or React re-renders in a loop forever.
   *
   * The cache is keyed on a null sentinel rather than on `.length` — an empty
   * array has length 0, so a length check would miss the cache precisely when
   * there are no tabs and hand back a fresh array on every single read. That
   * is the textbook way to hang a `useSyncExternalStore` consumer.
   */
  private cachedList: { tabId: string; url: string; title: string; ageMs: number }[] | null = null;
  private notify() {
    this.cachedList = null;
    for (const fn of this.listeners) {
      try { fn(); } catch (e) { logger.warn('[BrowserSession] listener failed:', e); }
    }
  }

  /** Stable list for React's external-store contract. */
  listSnapshot = () => {
    if (this.cachedList) return this.cachedList;
    const now = Date.now();
    this.cachedList = [...this.tabs.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(t => ({ tabId: t.id, url: t.url, title: t.title, ageMs: now - t.createdAt }));
    return this.cachedList;
  };

  /**
   * Move a tab's live frame into a container the user can actually see.
   *
   * This is the whole point of the panel. Tabs normally live off-screen so they
   * cost nothing until used; an agent browsing eight pages the user cannot see
   * is exactly the invisible-agent problem the permission gate exists to
   * prevent — you cannot consent to an action you cannot watch. Moving the real
   * frame (rather than re-rendering a copy) keeps the DOM, its scroll position
   * and its state intact, so what is shown is genuinely the tab.
   */
  attachTo(tabId: string, container: HTMLElement | null): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (container) {
      if (tab.frame.parentElement !== container) container.appendChild(tab.frame);
      // The off-screen host styles would fight the panel's own layout.
      Object.assign(tab.frame.style, {
        position: 'static',
        left: '', top: '', width: '100%', height: '100%', border: 'none', display: 'block',
      });
    } else if (tab.frame.parentElement !== this.host && this.host) {
      Object.assign(tab.frame.style, {
        position: 'absolute', left: '-10000px', top: '0',
        width: '1280px', height: '900px',
      });
      this.host.appendChild(tab.frame);
    }
    return true;
  }

  /** Where tab iframes live. Off-screen but NOT display:none — a hidden element
   *  still has a layout box, but `display:none` subtrees skip rendering in some
   *  engines, and we need the document to be live and scriptable. */
  private ensureHost(): HTMLDivElement | null {
    if (typeof document === 'undefined') return null;
    if (this.host && this.host.isConnected) return this.host;
    const el = document.createElement('div');
    el.setAttribute('data-gia-browser-tabs', '');
    Object.assign(el.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      width: '1280px',
      height: '900px',
      pointerEvents: 'none',
      opacity: '0.01',
      zIndex: '-1',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
    this.host = el;
    return el;
  }

  private async renderInto(tab: TabHandle, html: string): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      // JS-heavy pages can take a while; a hard ceiling stops one bad page from
      // stalling the whole turn.
      const timer = setTimeout(done, 8000);
      tab.frame.onload = () => {
        // Give the document a beat to run its own scripts before reading it.
        setTimeout(done, 300);
      };
      tab.frame.srcdoc = html;
    });
    try {
      tab.doc = tab.frame.contentDocument ?? tab.frame.contentWindow?.document ?? null;
    } catch {
      // Cross-origin frames deny this. Our own srcdoc frames should not, but a
      // page that navigated itself away could, and that is not worth crashing on.
      tab.doc = null;
    }
  }

  async open(url: string, signal?: AbortSignal): Promise<OpenResult> {
    const host = this.ensureHost();
    if (!host) throw new Error('No document available — the browser needs a running app window.');

    if (this.tabs.size >= MAX_TABS) {
      // Oldest tab yields, rather than refusing the request outright. The model
      // asked to open something; the useful response is to make room.
      const oldest = [...this.tabs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this.close(oldest.id);
    }

    await randomDelay(150);
    const { html, finalUrl } = await fetchPage(url, signal);

    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
    frame.style.width = '1280px';
    frame.style.height = '900px';
    frame.style.border = 'none';
    host.appendChild(frame);

    const tab: TabHandle = {
      id: makeTabId(), url: finalUrl, title: '', createdAt: Date.now(),
      frame, doc: null, refs: new Map(), lastSnapshot: null,
      history: [finalUrl], cursor: 0,
    };
    this.tabs.set(tab.id, tab);
    this.notify();

    await this.renderInto(tab, html);
    this.notify();
    const snap = this.snapshotOf(tab);
    const wall = detectAuthWall(tab.doc, tab.url);
    return {
      tabId: tab.id,
      url: tab.url,
      title: snap.title,
      elementCount: snap.nodes.length,
      snapshot: renderSnapshot(snap),
      ...(wall.detected ? { authWall: wall.reason, advice: authWallAdvice(wall) } : {}),
    };
  }

  private snapshotOf(tab: TabHandle, query?: string): PageSnapshot {
    if (!tab.doc) {
      return { title: tab.title, url: tab.url, nodes: [], text: '', textTruncated: false };
    }
    tab.title = tab.doc.title || tab.title;

    // One traversal produces both the description and the ref map, so they can
    // never disagree about what e14 was. Rebuilding the map each time is also
    // what makes stale refs fail loudly instead of clicking a re-rendered
    // element the model never saw.
    const collected = collectNodes(tab.doc);
    tab.refs = new Map(collected.map(c => [c.node.ref, c.el]));

    const snap = buildSnapshot(tab.doc, { url: tab.url, query });
    tab.lastSnapshot = snap;
    return snap;
  }

  private get(tabId: string): TabHandle | undefined {
    const tab = this.tabs.get(tabId);
    if (!tab) return undefined;
    return tab;
  }

  list(): { tabId: string; url: string; title: string; ageMs: number }[] {
    const now = Date.now();
    return [...this.tabs.values()].map(t => ({
      tabId: t.id, url: t.url, title: t.title, ageMs: now - t.createdAt,
    }));
  }

  /** Tabs in the order they were opened, which is the order a strip should show. */
  ordered(): TabHandle[] {
    return [...this.tabs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  titleOf(tabId: string): string {
    return this.tabs.get(tabId)?.title ?? '';
  }

  authStateOf(tabId: string): { kind: string; reason: string } | null {
    const tab = this.tabs.get(tabId);
    if (!tab?.doc) return null;
    const wall = detectAuthWall(tab.doc, tab.url);
    return wall.detected ? { kind: wall.kind, reason: wall.reason } : null;
  }

  has(tabId: string): boolean {
    return this.tabs.has(tabId);
  }

  /** Which tabs the caller has open. Phrased for a model that lost track. */
  hint(): string {
    const list = this.list();
    if (!list.length) return 'You have no tabs open. Use browser_open first.';
    return `Open tabs: ${list.map(t => `${t.tabId} (${t.url})`).join(', ')}`;
  }

  snapshot(tabId: string, query?: string): { ok: boolean; message: string; reason?: string } {
    const tab = this.get(tabId);
    if (!tab) return { ok: false, message: `No tab ${tabId}. ${this.hint()}`, reason: 'unknown_tab' };
    if (!tab.doc) return { ok: false, message: `Tab ${tabId} has no accessible document. ${this.hint()}`, reason: 'no_document' };
    const snap = this.snapshotOf(tab, query);
    const total = tab.refs.size;
    return { ok: true, message: renderSnapshot(snap, total) };
  }

  /** Type into an element identified by ref. Does not click, so a form can be
   *  filled before submission is deliberate. */
  type(tabId: string, ref: string, value: string, submit?: boolean): OpResult {
    const tab = this.get(tabId);
    if (!tab) return { ok: false, message: `No tab ${tabId}. ${this.hint()}`, reason: 'unknown_tab' };
    const el = tab.refs.get(ref);
    if (!el) return this.staleRef(tab, ref);

    const input = el as HTMLInputElement | HTMLTextAreaElement;
    input.focus?.();
    input.value = value;
    // A programmatic value assignment does not fire the events a framework
    // listens for, so a React-controlled input would silently ignore this.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    if (submit) {
      const form = (el as HTMLInputElement).form;
      if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return { ok: true, message: `Typed into ${ref} and submitted its form.` };
      }
      const btn = tab.doc?.querySelector('button[type="submit"], input[type="submit"]');
      if (btn) {
        (btn as HTMLElement).click();
        return { ok: true, message: `Typed into ${ref} and clicked submit.` };
      }
      return { ok: true, message: `Typed into ${ref}. No submit control found — use browser_click if there is one.` };
    }
    return { ok: true, message: `Typed ${value.length} character${value.length === 1 ? '' : 's'} into ${ref} "${el.getAttribute('name') || el.getAttribute('type') || ''}".` };
  }

  async click(tabId: string, ref: string): Promise<OpResult> {
    const tab = this.get(tabId);
    if (!tab) return { ok: false, message: `No tab ${tabId}. ${this.hint()}`, reason: 'unknown_tab' };
    const el = tab.refs.get(ref);
    if (!el) return this.staleRef(tab, ref);

    if ((el as HTMLInputElement).disabled) {
      return { ok: false, message: `${ref} is disabled and cannot be clicked.`, reason: 'disabled' };
    }

    const label = el.getAttribute('aria-label') || textOfEl(el);

    // A same-document link is real navigation, and performing it is what makes
    // a multi-step flow possible: click through the page rather than restarting
    // from a URL every time.
    const href = el.getAttribute('href');
    const isRelativeLink = el.tagName.toLowerCase() === 'a' && !!href &&
      !href.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(href);

    if (isRelativeLink && href) {
      let target: string;
      try {
        target = new URL(href, tab.url).toString();
      } catch {
        target = tab.url;
      }
      if (target !== tab.url) {
        await this.navigate(tab, target);
        return { ok: true, message: `Clicked ${ref} ("${label}") — followed the link to ${target}. Re-snapshot tab ${tab.id} to see the new page.` };
      }
    }

    (el as HTMLElement).click?.();
    // Let any handler run before we describe what happened.
    await new Promise(r => setTimeout(r, 150));

    // A click can replace the document without a navigation we tracked. If the
    // document is gone, re-render so the tab is usable rather than dead.
    let live: Document | null = null;
    try { live = tab.frame.contentDocument ?? tab.frame.contentWindow?.document ?? null; } catch { live = null; }
    if (!live || !live.body) {
      await this.navigate(tab, tab.url);
      return { ok: true, message: `Clicked ${ref} ("${label}") and the page reloaded. Re-snapshot tab ${tab.id}.` };
    }
    tab.doc = live;
    return { ok: true, message: `Clicked ${ref} ("${label}"). Re-snapshot tab ${tab.id} to see the result.` };
  }

  /**
   * Fetch and render a URL into an existing tab, preserving its identity.
   *
   * `record` is false for a history traversal. Back and forward must not push
   * new entries, or going back twice would leave you somewhere you never were.
   */
  private async navigate(tab: TabHandle, url: string, record = true): Promise<void> {
    const { html, finalUrl } = await fetchPage(url);
    tab.url = finalUrl;
    tab.refs = new Map();
    if (record) {
      // Going somewhere new after going back discards the forward entries —
      // the same rule every browser follows.
      tab.history = [...tab.history.slice(0, tab.cursor + 1), finalUrl];
      tab.cursor = tab.history.length - 1;
    }
    await this.renderInto(tab, html);
    this.notify();
  }

  /** History-aware navigation, exposed to the tools. */
  async go(tabId: string, where: 'back' | 'forward' | 'reload'): Promise<OpResult> {
    const tab = this.get(tabId);
    if (!tab) return { ok: false, message: `No tab ${tabId}. ${this.hint()}`, reason: 'unknown_tab' };

    if (where === 'reload') {
      await this.navigate(tab, tab.url, false);
      return { ok: true, message: `Reloaded ${tab.url}.` };
    }

    const target = where === 'back' ? tab.cursor - 1 : tab.cursor + 1;
    if (target < 0 || target >= tab.history.length) {
      return {
        ok: false,
        reason: 'history_edge',
        message: `Already at the ${where === 'back' ? 'start' : 'end'} of this tab's history (${tab.history.length} page${tab.history.length === 1 ? '' : 's'} visited).`,
      };
    }
    const previous = tab.cursor;
    // Move the cursor first, so a failed fetch leaves the tab claiming to be
    // where it actually is rather than somewhere it never reached.
    tab.cursor = target;
    try {
      await this.navigate(tab, tab.history[target], false);
    } catch (e) {
      tab.cursor = previous;
      return { ok: false, reason: 'fetch_failed', message: e instanceof Error ? e.message : 'Navigation failed' };
    }
    return { ok: true, message: `Went ${where} to ${tab.url}.` };
  }

  /** Session facts worth showing: history depth and what cookies are held. */
  describe(tabId: string): OpResult {
    const tab = this.get(tabId);
    if (!tab) return { ok: false, message: `No tab ${tabId}. ${this.hint()}`, reason: 'unknown_tab' };
    const cookies = this.jar.cookiesFor(tab.url);
    return {
      ok: true,
      message: [
        `tab ${tab.id} — ${tab.url}`,
        `history: ${tab.history.length} page${tab.history.length === 1 ? '' : 's'} (position ${tab.cursor + 1})`,
        `cookies for this site: ${cookies.length ? cookies.map(c => c.name).join(', ') : 'none'}`,
      ].join('\n'),
    };
  }

  private staleRef(tab: TabHandle, ref: string): OpResult {
    const known = [...tab.refs.keys()];
    return {
      ok: false,
      reason: 'stale_ref',
      message: `${ref} is not on the current snapshot of tab ${tab.id}. Refs change whenever the page does — call browser_snapshot first. Currently available: ${known.slice(0, 12).join(', ') || '(none)'}.`,
    };
  }

  scroll(tabId: string, direction: 'down' | 'up' | 'bottom' | 'top'): OpResult {
    const tab = this.get(tabId);
    if (!tab) return { ok: false, message: `No tab ${tabId}. ${this.hint()}`, reason: 'unknown_tab' };
    const win = tab.frame.contentWindow;
    const scroller = tab.doc?.scrollingElement ?? tab.doc?.body;
    if (!scroller) return { ok: false, message: 'This document has nothing to scroll.', reason: 'no_scroll' };

    const view = scroller.clientHeight || 800;
    if (direction === 'bottom') scroller.scrollTop = scroller.scrollHeight;
    else if (direction === 'top') scroller.scrollTop = 0;
    else scroller.scrollTop += direction === 'down' ? view * 0.9 : -view * 0.9;
    win?.scrollTo?.(scroller.scrollTop, 0);

    const at = Math.round((scroller.scrollTop / Math.max(1, scroller.scrollHeight - view)) * 100);
    return { ok: true, message: `Scrolled ${direction} in ${tab.id} — now ${Math.min(100, Math.max(0, at))}% through the page.` };
  }

  close(tabId: string): OpResult {
    const tab = this.get(tabId);
    if (!tab) return { ok: false, message: `No tab ${tabId}. ${this.hint()}`, reason: 'unknown_tab' };
    tab.frame.remove();
    this.tabs.delete(tabId);
    this.notify();
    return { ok: true, message: `Closed ${tabId} (${tab.url}).` };
  }

  closeAll(): void {
    for (const tab of this.tabs.values()) tab.frame.remove();
    this.tabs.clear();
    // Clearing the jar alongside the tabs is deliberate. "Clear browsing data"
    // that leaves the cookies behind is not clearing anything a user would
    // expect it to clear.
    this.jar.clear();
    this.notify();
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
  }

  get size(): number {
    return this.tabs.size;
  }
}

function textOfEl(el: Element): string {
  const anyEl = el as unknown as { innerText?: string; textContent?: string | null };
  return (anyEl.innerText ?? anyEl.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export const browserSession = new BrowserSession();