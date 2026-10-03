import { z } from 'zod';
import type { Tool, ToolContext } from './types';
import { browserSession } from '../browser/BrowserSession';

/**
 * Browser session tools — a real tab, and a way to aim at things in it.
 *
 * The tools these replace were called `browser_click`, `browser_fill` and
 * `browser_scroll`, which is exactly the problem. They took a URL and a CSS
 * selector, and they only worked if the user had separately started a
 * Playwright server on port 3091 — an error message pointed at
 * `node server/browse_web.js`, a file that was never in the repository. So the
 * app advertised a browser it could not drive.
 *
 * Two changes, both substantive:
 *
 *  1. **Tabs.** `browser_open` returns a `tabId`; everything after it takes
 *     that id. Nothing is re-fetched from scratch, so a page you typed into
 *     is still the page you are acting on. This is what makes multi-step work
 *     possible, and what every competitor now ships.
 *  2. **Refs instead of selectors.** `browser_snapshot` names every control
 *     and gives it a handle; you click `e14`, not `form > div:nth-child(2) > button`.
 *     The model stops guessing at markup and starts referring to the page.
 *
 * Limits are stated in the descriptions rather than hidden: this is not a
 * logged-in browser profile, so anything that needs a real authenticated
 * session is still out of reach.
 */

function fail(message: string) {
  return { success: false, content: '', error: message };
}

const browserOpenTool: Tool = {
  id: 'browser_open',
  name: 'browser_open',
  description:
    'Open a URL in a new browser tab and return its tabId plus a snapshot of everything on the page. ' +
    'Keep the tabId — every other browser tool needs it. For multi-step work (search, then click a result, ' +
    'then read it) open once and reuse the tab rather than opening each URL separately. ' +
    'Not suitable for anything needing a logged-in session: this is a sandboxed document, not your browser profile.',
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute URL to open, including https://' },
    },
    required: ['url'],
  },
  execute: async (args, ctx?: ToolContext) => {
    const schema = z.object({ url: z.string().min(1).max(2000) });
    const parsed = schema.safeParse(args);
    if (!parsed.success) return fail('browser_open needs a url.');
    const { url } = parsed.data;

    try {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
      ctx?.onProgress?.(0.2, 'Opening tab…');
      ctx?.onThought?.(`🌐 Opening ${withScheme} in a new tab…`);
      const result = await browserSession.open(withScheme, ctx?.signal);
      ctx?.onProgress?.(1, 'Loaded');
      ctx?.onThought?.(`✅ Opened ${result.title || withScheme} — ${result.elementCount} interactive elements`);

      // An auth wall is stated up front, not discovered after five retries. The
      // point is that the user learns the real reason rather than watching the
      // agent fail repeatedly at a page that was never going to open.
      const wall = result.authWall
        ? `\n\n> **This page is not the content you asked for.** ${result.authWall}\n>\n> ${result.advice}`
        : '';

      return {
        success: true,
        content: `**tabId: \`${result.tabId}\`** — pass this to every other browser tool.${wall}\n\n${result.snapshot}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not open that page';
      return fail(`${msg}\n\nIf this is a cross-origin block, use read_url instead — it does not need a browser.`);
    }
  },
};

const browserSnapshotTool: Tool = {
  id: 'browser_snapshot',
  name: 'browser_snapshot',
  description:
    'Re-read the current state of a tab as a list of addressable elements (e14 button "Sign in"). ' +
    'Call this after anything that changes the page — a click, a navigation — because refs from an older ' +
    'snapshot are no longer valid. Pass `query` to filter to elements matching a word, which is much cheaper ' +
    'than reading a large page in full.',
  schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab id returned by browser_open' },
      query: { type: 'string', description: 'Only show elements whose label, role or value contains this text' },
    },
    required: ['tabId'],
  },
  execute: async (args, ctx?: ToolContext) => {
    const schema = z.object({ tabId: z.string().min(1), query: z.string().max(200).optional() });
    const parsed = schema.safeParse(args);
    if (!parsed.success) return fail('browser_snapshot needs a tabId.');
    const { tabId, query } = parsed.data;

    ctx?.onThought?.('📸 Reading the page…');
    const res = browserSession.snapshot(tabId, query);
    if (!res.ok) return fail(res.message);
    return { success: true, content: res.message };
  },
};

const browserClickTool: Tool = {
  id: 'browser_click',
  name: 'browser_click',
  description:
    'Click an element in a tab, addressed by its ref from browser_snapshot (not a CSS selector). ' +
    'Following a link navigates the tab. Always re-snapshot afterwards to see what changed.',
  schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab id returned by browser_open' },
      ref: { type: 'string', description: 'Element ref, e.g. "e14" — from browser_snapshot' },
    },
    required: ['tabId', 'ref'],
  },
  execute: async (args, ctx?: ToolContext) => {
    const schema = z.object({ tabId: z.string().min(1), ref: z.string().min(1) });
    const parsed = schema.safeParse(args);
    if (!parsed.success) return fail('browser_click needs a tabId and an element ref.');
    const { tabId, ref } = parsed.data;

    ctx?.onProgress?.(0.2, 'Clicking…');
    ctx?.onThought?.(`🖱️ Clicking ${ref}…`);
    const res = await browserSession.click(tabId, ref);
    if (!res.ok) return fail(res.message);
    ctx?.onProgress?.(1, 'Clicked');
    return { success: true, content: res.message };
  },
};

const browserTypeTool: Tool = {
  id: 'browser_type',
  name: 'browser_type',
  description:
    'Type text into a field in a tab, addressed by its ref from browser_snapshot. Set submit=true to send ' +
    'the form in the same step; otherwise fill every field first and click submit deliberately, so you can ' +
    'check what you are about to send before you send it.',
  schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab id returned by browser_open' },
      ref: { type: 'string', description: 'Element ref of the field, e.g. "e7" — from browser_snapshot' },
      text: { type: 'string', description: 'Text to type into the field' },
      submit: { type: 'boolean', description: 'Submit the form after typing (default false)' },
    },
    required: ['tabId', 'ref', 'text'],
  },
  execute: async (args, ctx?: ToolContext) => {
    const schema = z.object({
      tabId: z.string().min(1),
      ref: z.string().min(1),
      text: z.string().max(10_000),
      submit: z.boolean().default(false),
    });
    const parsed = schema.safeParse(args);
    if (!parsed.success) return fail('browser_type needs a tabId, an element ref, and the text.');
    const { tabId, ref, text, submit } = parsed.data;

    ctx?.onThought?.(`⌨️ Typing into ${ref}…`);
    const res = browserSession.type(tabId, ref, text, submit);
    if (!res.ok) return fail(res.message);
    return { success: true, content: res.message };
  },
};

const browserScrollTool: Tool = {
  id: 'browser_scroll',
  name: 'browser_scroll',
  description:
    'Scroll a tab. Useful before snapshotting a long page, or to reach content below the fold before reading it.',
  schema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab id returned by browser_open' },
      direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'Where to scroll (default down)' },
    },
    required: ['tabId'],
  },
  execute: async (args, ctx?: ToolContext) => {
    const schema = z.object({
      tabId: z.string().min(1),
      direction: z.enum(['down', 'up', 'top', 'bottom']).default('down'),
    });
    const parsed = schema.safeParse(args);
    if (!parsed.success) return fail('browser_scroll needs a tabId.');
    const { tabId, direction } = parsed.data;

    ctx?.onThought?.(`📜 Scrolling ${direction}…`);
    const res = browserSession.scroll(tabId, direction);
    if (!res.ok) return fail(res.message);
    return { success: true, content: res.message };
  },
};

const browserTabsTool: Tool = {
  id: 'browser_tabs',
  name: 'browser_tabs',
  description:
    'List open browser tabs and their ids. Also handles tab housekeeping: `back`, `forward` and `reload` take a tabId ' +
    'to move that tab, and `close` takes a tabId to close it. Use back/forward after following several links rather ' +
    'than re-opening URLs, which throws away the tab\'s history.',
  schema: {
    type: 'object',
    properties: {
      close: { type: 'string', description: 'Tab id to close. Omit to just list open tabs.' },
      back: { type: 'string', description: 'Tab id to go back in.' },
      forward: { type: 'string', description: 'Tab id to go forward in.' },
      reload: { type: 'string', description: 'Tab id to reload.' },
    },
  },
  execute: async (args) => {
    const close = typeof args.close === 'string' ? args.close : '';
    if (close) {
      const res = browserSession.close(close);
      return res.ok ? { success: true, content: res.message } : fail(res.message);
    }
    for (const key of ['back', 'forward', 'reload'] as const) {
      const target = args[key];
      if (typeof target !== 'string' || !target) continue;
      const res = await browserSession.go(target, key);
      return res.ok ? { success: true, content: res.message } : fail(res.message);
    }
    const tabs = browserSession.list();
    if (!tabs.length) return { success: true, content: 'No tabs open. Use browser_open to start one.' };
    return {
      success: true,
      content: `**${tabs.length} open tab${tabs.length === 1 ? '' : 's'}**\n${tabs.map(t => `- \`${t.tabId}\` ${t.title ? `**${t.title}** ` : ''}${t.url}`).join('\n')}`,
    };
  },
};

export const browserSessionTools: Tool[] = [
  browserOpenTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserScrollTool,
  browserTabsTool,
];