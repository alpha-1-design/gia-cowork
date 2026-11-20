import WebContentSanitizer from '../WebContentSanitizer';

/**
 * CrawlerService — built-in breadth-first web crawler behind the `web_crawl`
 * tool.
 *
 * Why a crawler when read_url exists: read_url fetches ONE page. Mapping a
 * site, gathering across a docs section or following a topic through several
 * pages needs a bounded walk — same-host by default, depth- and page-capped,
 * robots.txt-aware, rate-limited and cancellable. The result is a structured
 * artifact (per-page url/title/status/excerpt/links) the model reads as
 * compact summaries and the UI renders as a list.
 *
 * Threat model: every crawled page is remote text written by whoever owns
 * that host — the same class as WhatsApp messages and single-page fetches.
 * So every page body passes through WebContentSanitizer, which leaves content
 * inside the UNTRUSTED-CONTENT envelope (data for the model, never
 * instructions). Nothing is stored or returned unlabeled. A page the
 * sanitizer scores 'dangerous' (blocked injection) is still recorded — the
 * crawl must report what a site tried to do — but its excerpt carries the
 * sanitizer's warning summary next to the envelope.
 *
 * robots.txt follows the simple RFC 9309 path-prefix rule: groups whose
 * user-agent list contains `*` or any gia line apply, the longest matching
 * Disallow prefix wins, `Disallow:` with no value means allow-all. Best
 * effort, never fatal: an unreachable robots.txt is reported as a note and
 * the crawl proceeds; a 4xx/5xx robots.txt means unrestricted (RFC 9309
 * §2.4.2 — the server says it has no usable policy).
 */

// ── Types ───────────────────────────────────────────────────────────────

/** One fetched (or failed) page of the crawl. */
export interface CrawledPage {
  url: string;
  title: string;
  /** HTTP status, or 0 when the fetch itself failed (network/CORS). */
  status: number;
  /** Sanitized, UNTRUSTED-CONTENT-enveloped excerpt — empty on failures. */
  excerpt: string;
  /** Absolute http(s) hrefs found on the page (all hosts — data, not queue). */
  links: string[];
  fetchedAt: number;
  error?: string;
}

/** Totals for the crawl, for budget display and the tool's compact report. */
export interface CrawlBudget {
  pages: number;
  /** Rough byte count of fetched bodies (html length — chars ≈ bytes). */
  bytes: number;
}

export interface CrawlResult {
  /** Stable id for referencing / re-rendering this crawl artifact. */
  crawlId: string;
  pages: CrawledPage[];
  startedAt: number;
  finishedAt: number;
  budgetUsed: CrawlBudget;
  cancelled?: boolean;
  /** Best-effort reports: robots notes, budget cut-offs, skipped seeds. */
  notes: string[];
}

/** What the fetcher must produce per URL. `html` carries the raw body so
 * the crawler can extract links AND text; error responses may be empty.
 * `finalUrl` is set when the fetcher followed redirects — the service uses
 * it for attribution and scope re-checking (S3-9). */
export interface CrawlerFetchResponse {
  status: number;
  html: string;
  finalUrl?: string;
}

/** Injectable page fetcher — the seam tests replace with a mock; the
 * default uses the same direct-fetch strategy FallbackWebSearch's
 * scrapeDirect uses (the read_url pipeline's last real-fetch resort). */
export type CrawlerFetcher = (url: string) => Promise<CrawlerFetchResponse>;

export interface CrawlOptions {
  /** Hard cap 100 (MAX_PAGES_CAP). Default 25. */
  maxPages?: number;
  /** Hard cap 4 (MAX_DEPTH_CAP). Default 2. Seed pages sit at depth 0. */
  maxDepth?: number;
  /** Only follow links to a seed's hostname(s). Default true. */
  sameHostOnly?: boolean;
  /** Politeness wait between fetches to the same host. Default 1000ms. */
  perHostDelayMs?: number;
  /** Rough byte budget across fetched bodies. Default 5 MB. */
  sizeBudgetBytes?: number;
  /** Optional filter: keep only pages whose title/text contains this. */
  query?: string;
  /** Progress callback between fetches. */
  onProgress?: (progress: { fetched: number; queued: number; lastUrl: string }) => void;
  /** Fetcher override for tests. Default: direct fetch, 15s timeout. */
  fetcher?: CrawlerFetcher;
  /** Deterministic id for tests; defaults to crypto.randomUUID(). */
  crawlId?: string;
}

interface QueueEntry {
  url: string;
  depth: number;
}

interface RobotsGroup {
  agents: string[];
  disallow: string[];
}

interface HostState {
  /** Prefixes that disallow, or null when robots.txt is unusable/absent. */
  disallow: string[] | null;
}

// ── Constants ───────────────────────────────────────────────────────────

const MAX_PAGES_CAP = 100;
const MAX_DEPTH_CAP = 4;
const DEFAULT_MAX_PAGES = 25;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_SAME_HOST = true;
const DEFAULT_PER_HOST_DELAY_MS = 1000;
const DEFAULT_SIZE_BUDGET_BYTES = 5_000_000;
/** Excerpt ceiling before the sanitizer envelope — 2-3 sentences' worth. */
const EXCERPT_CHARS = 480;
const FETCH_TIMEOUT_MS = 15_000;
/** Bounded redirect hops per page fetch (S3-9). */
const MAX_REDIRECT_HOPS = 5;

/** Asset extensions we never enqueue — a crawler maps pages, not files. */
const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.avif',
  '.css', '.js', '.mjs', '.json', '.xml', '.rss', '.atom',
  '.pdf', '.zip', '.gz', '.tar', '.rar', '.7z',
  '.mp3', '.mp4', '.webm', '.ogg', '.wav', '.m4a',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.dmg', '.exe', '.msi', '.apk', '.deb', '.rpm',
]);

// ── Helpers ─────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Canonical form for the visited set: drop the #fragment (same document),
 * lowercase the host, strip a trailing slash on non-root paths. Query strings
 * stay — ?page=2 is a different page by any honest reading.
 */
function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return null;
  }
}

function isAssetUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const dot = path.lastIndexOf('.');
    if (dot === -1) return false;
    return ASSET_EXTENSIONS.has(path.slice(dot));
  } catch {
    return true; // unparseable → not a crawlable page
  }
}

/**
 * Parse robots.txt into Disallow prefixes for the groups that apply to gia:
 * groups matching `*` or any user-agent containing 'gia' (case-insensitive).
 * This is the simple RFC 9309 path-prefix rule — no `*`/`$` wildcards inside
 * paths, no crawl-delay handling; good robots hygiene on real sites is
 * overwhelmingly plain prefixes.
 */
export function parseRobotsDisallows(body: string): string[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastDirectiveWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // Within one record, consecutive user-agent lines merge into the same
    // group; any other directive closes the agent block (RFC 9309 §2.1).
    if (key === 'user-agent') {
      if (!lastDirectiveWasAgent || !current) {
        current = { agents: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastDirectiveWasAgent = true;
    } else if (key === 'disallow' && current) {
      current.disallow.push(value);
      lastDirectiveWasAgent = false;
    } else {
      // allow / crawl-delay / sitemap etc. — not part of this rule set.
      lastDirectiveWasAgent = false;
    }
  }

  const applicable = groups.filter((g) =>
    g.agents.includes('*') || g.agents.some((a) => a.includes('gia')));
  const disallow: string[] = [];
  for (const g of applicable) {
    for (const d of g.disallow) {
      if (!disallow.includes(d)) disallow.push(d);
    }
  }
  return disallow;
}

/** Longest matching Disallow prefix wins (RFC 9309 §3.2.3 simplified). */
export function isDisallowedByRobots(url: string, disallow: string[]): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  let longest = '';
  for (const prefix of disallow) {
    if (prefix.length === 0) continue; // "Disallow:" alone = allow all
    if (path.startsWith(prefix) && prefix.length > longest.length) longest = prefix;
  }
  return longest.length > 0;
}

// ── Default fetcher ─────────────────────────────────────────────────────

/**
 * The real fetch path. A crawler needs raw HTML (links + robots + text), so
 * it cannot go through FallbackWebSearch's markdown pipeline; instead it uses
 * the same strategy that pipeline falls back to — a direct fetch with browser
 * headers, which is also what WebFetchService's Strategy 1 does. CORS-blocked
 * pages simply record status 0 and are skipped; read_url (with its proxy
 * ladder) remains the tool for one hard page.
 */
export const defaultCrawlerFetcher: CrawlerFetcher = async (url) => {
  // Redirects are followed MANUALLY with a bounded hop count (S3-9: with
  // redirect:'follow' an in-scope URL that 30x's off-host is fetched and
  // recorded under its ORIGINAL url — off-host content with wrong
  // attribution and no robots check for the target). Each hop's Location is
  // resolved and re-fetched; the service re-checks host scope + robots
  // against `finalUrl`.
  let current = url;
  for (let hops = 0; hops < MAX_REDIRECT_HOPS; hops++) {
    const res = await fetch(current, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { status: res.status, html: '', finalUrl: current };
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        return { status: res.status, html: '', finalUrl: current };
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return { status: res.status, html: '', finalUrl: current };
      }
      current = next.toString();
      continue;
    }
    return { status: res.status, html: await res.text(), finalUrl: current };
  }
  // Too many hops — treat as a failed page rather than trusting the last
  // target (a redirect loop is itself a signal).
  throw new Error(`Too many redirects (> ${MAX_REDIRECT_HOPS})`);
};

// ── Service ─────────────────────────────────────────────────────────────

class CrawlerService {
  /** Active crawls by id — the cancel seam between fetches. */
  private active = new Map<string, { cancelled: boolean }>();

  /**
   * Crawl from seed URLs. Same-host breadth-first with depth/page/size
   * budgets, robots.txt checked per host before its first page fetch, and a
   * politeness delay per host. Never throws for an unreachable page —
   * failures are recorded in the result, not raised.
   */
  async crawl(seeds: string[], opts: CrawlOptions = {}): Promise<CrawlResult> {
    const crawlId = opts.crawlId ?? (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `crawl-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
    const controller = { cancelled: false };
    this.active.set(crawlId, controller);

    const maxPages = Math.min(Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES), MAX_PAGES_CAP);
    const maxDepth = Math.min(Math.max(0, opts.maxDepth ?? DEFAULT_MAX_DEPTH), MAX_DEPTH_CAP);
    const sameHostOnly = (opts.sameHostOnly ?? DEFAULT_SAME_HOST) !== false;
    const perHostDelayMs = Math.max(0, opts.perHostDelayMs ?? DEFAULT_PER_HOST_DELAY_MS);
    const sizeBudget = Math.max(1, opts.sizeBudgetBytes ?? DEFAULT_SIZE_BUDGET_BYTES);
    const query = opts.query?.trim().toLowerCase() || null;
    const fetcher = opts.fetcher ?? defaultCrawlerFetcher;

    const notes: string[] = [];
    const startedAt = Date.now();
    const budgetUsed: CrawlBudget = { pages: 0, bytes: 0 };
    /** Every fetched page — budget counts all of them, filter or not. */
    const fetched: CrawledPage[] = [];
    /** The pages the result reports (query-filtered when a query is set). */
    const resultPages: CrawledPage[] = [];

    // Allowed hosts come from the seeds themselves — a multi-seed crawl can
    // legitimately span the hosts its user named, but nothing else.
    const allowedHosts = new Set<string>();
    const queue: QueueEntry[] = [];
    const seen = new Set<string>();
    for (const seed of seeds) {
      const normalized = normalizeUrl(seed);
      if (!normalized || isAssetUrl(normalized)) {
        notes.push(`Skipped invalid seed: ${seed}`);
        continue;
      }
      allowedHosts.add(new URL(normalized).hostname.toLowerCase());
      if (!seen.has(normalized)) {
        seen.add(normalized);
        queue.push({ url: normalized, depth: 0 });
      }
    }

    const robotsCache = new Map<string, HostState>();
    const lastFetchAt = new Map<string, number>();

    // Lazily resolve a host's robots policy exactly once per crawl. The
    // robots.txt fetch shares the host's politeness window (lastFetchAt is
    // stamped right before it), so it cannot hammer the host either.
    const robotsDisallows = async (host: string): Promise<string[] | null> => {
      const cached = robotsCache.get(host);
      if (cached) return cached.disallow;
      const state: HostState = { disallow: null };
      robotsCache.set(host, state);
      try {
        const res = await fetcher(`https://${host}/robots.txt`);
        if (res.status >= 200 && res.status < 300) {
          // 2xx with a body → the site's actual policy applies.
          state.disallow = parseRobotsDisallows(res.html);
        }
        // 4xx/5xx → unrestricted, per RFC 9309; disallow stays null.
      } catch {
        // Unreachable robots.txt is a report note, never a crawl failure.
        notes.push(`robots.txt unreachable for ${host} — proceeding unrestricted (best effort).`);
      }
      return state.disallow;
    };

    while (queue.length > 0) {
      // Cancel and budget checks sit between fetches, never mid-fetch.
      if (controller.cancelled) break;
      if (fetched.length >= maxPages) {
        notes.push(`Page budget reached (${maxPages} pages) — queue had ${queue.length} left.`);
        break;
      }
      if (budgetUsed.bytes >= sizeBudget) {
        notes.push(`Size budget reached (${budgetUsed.bytes} bytes) — stopping.`);
        break;
      }

      const entry = queue.shift()!;
      const host = new URL(entry.url).hostname.toLowerCase();

      // Politeness: never hit one host faster than perHostDelayMs.
      const last = lastFetchAt.get(host);
      if (last !== undefined && perHostDelayMs > 0) {
        const wait = perHostDelayMs - (Date.now() - last);
        if (wait > 0) await sleep(wait);
        if (controller.cancelled) break; // slept long enough to re-check
      }

      const disallow = await robotsDisallows(host);
      if (disallow && isDisallowedByRobots(entry.url, disallow)) {
        notes.push(`robots.txt disallows ${entry.url} — skipped.`);
        lastFetchAt.set(host, Date.now());
        continue;
      }
      if (controller.cancelled) break;

      lastFetchAt.set(host, Date.now());
      opts.onProgress?.({ fetched: fetched.length, queued: queue.length, lastUrl: entry.url });

      let page: CrawledPage;
      try {
        const res = await fetcher(entry.url);
        const fetchedAt = Date.now();
        // Redirect attribution (S3-9): the page that actually rendered may
        // live at finalUrl. Re-check scope + robots against it — off-host
        // targets are recorded as out-of-scope failures, never parsed.
        const landedUrl = res.finalUrl || entry.url;
        let landedHost = '';
        try { landedHost = new URL(landedUrl).hostname.toLowerCase(); } catch { /* treated below */ }
        if (landedUrl !== entry.url && (!landedHost || (sameHostOnly && !allowedHosts.has(landedHost)))) {
          page = {
            url: entry.url, title: '', status: res.status, excerpt: '',
            links: [], fetchedAt,
            error: `Redirected off-scope to ${landedUrl} — not followed.`,
          };
          notes.push(`Redirect off-scope: ${entry.url} → ${landedUrl}`);
          fetched.push(page);
          budgetUsed.pages += 1;
          continue;
        }
        if (landedUrl !== entry.url) {
          // Same-host redirect: honor the target host's robots before use.
          const landDisallow = await robotsDisallows(landedHost);
          if (landDisallow && isDisallowedByRobots(landedUrl, landDisallow)) {
            page = {
              url: entry.url, title: '', status: res.status, excerpt: '',
              links: [], fetchedAt, error: 'Redirect target disallowed by robots.txt.',
            };
            notes.push(`robots.txt disallows redirect target ${landedUrl} — skipped.`);
            fetched.push(page);
            budgetUsed.pages += 1;
            continue;
          }
        }
        const ok = res.status >= 200 && res.status < 300;
        if (!ok) {
          page = {
            url: entry.url, title: '', status: res.status, excerpt: '',
            links: [], fetchedAt, error: `HTTP ${res.status}`,
          };
        } else {
          // DOMParser — the same parser the repo's HTML paths use.
          const doc = new DOMParser().parseFromString(res.html, 'text/html');
          // Script/style bodies ARE textContent — left in, an injected
          // <script>ignore previous instructions…</script> would sail into
          // the excerpt. Drop the executable/invisible nodes first.
          doc.querySelectorAll('script,style,noscript,template').forEach((el) => el.remove());
          const title = doc.querySelector('title')?.textContent?.trim()
            || new URL(entry.url).hostname;
          const links = collectLinks(doc, landedUrl);
          // Clip before sanitizing: the excerpt is 2-3 sentences, and the
          // sanitizer's regex passes shouldn't chew a whole megabyte page
          // just to keep its first paragraph.
          const rawText = (doc.body?.textContent ?? '').slice(0, EXCERPT_CHARS);
          // Every stored word goes through the sanitizer, which leaves it
          // inside the UNTRUSTED-CONTENT envelope before anything is kept.
          const sanitized = WebContentSanitizer.sanitize(rawText, `crawl:${landedUrl}`);
          const warning = sanitized.safe ? '' : `⚠️ ${WebContentSanitizer.summarize(sanitized)} — `;
          page = {
            url: landedUrl,
            title,
            status: res.status,
            excerpt: `${warning}${sanitized.content}`,
            links,
            fetchedAt,
          };
          budgetUsed.bytes += res.html.length;
        }
      } catch (e) {
        page = {
          url: entry.url, title: '', status: 0, excerpt: '', links: [],
          fetchedAt: Date.now(),
          error: e instanceof Error ? e.message : 'Fetch failed',
        };
      }

      fetched.push(page);
      budgetUsed.pages = fetched.length;

      // Links of every fetched page expand the walk — including pages the
      // query filter will drop from the result. A site section's index page
      // is often not itself a match; its links are how the crawl reaches
      // the pages that are.
      if (entry.depth < maxDepth) {
        for (const link of page.links) {
          if (seen.size >= maxPages * 4) break; // bound the seen-set too
          const normalized = normalizeUrl(link);
          if (!normalized || seen.has(normalized)) continue;
          const linkHost = new URL(normalized).hostname.toLowerCase();
          if (sameHostOnly && !allowedHosts.has(linkHost)) continue;
          seen.add(normalized);
          queue.push({ url: normalized, depth: entry.depth + 1 });
        }
      }

      // Query filter — applied after expansion, on the kept text only.
      if (query && page.title) {
        const haystack = `${page.title}\n${page.excerpt}`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      resultPages.push(page);
    }

    if (controller.cancelled) {
      notes.push(`Cancelled after ${fetched.length} page(s); ${queue.length} queued URLs dropped.`);
    }
    this.active.delete(crawlId);
    return {
      crawlId,
      pages: resultPages,
      startedAt,
      finishedAt: Date.now(),
      budgetUsed,
      ...(controller.cancelled ? { cancelled: true } : {}),
      notes,
    };
  }

  /**
   * Stop a running crawl between fetches. Safe to call for unknown ids
   * (already-finished crawls) — it just reports false.
   */
  cancel(crawlId: string): boolean {
    const controller = this.active.get(crawlId);
    if (!controller) return false;
    controller.cancelled = true;
    return true;
  }

  /** Whether a crawl id still has a live loop (UI cancel-button state). */
  isRunning(crawlId: string): boolean {
    return this.active.has(crawlId);
  }
}

/** Absolute http(s) hrefs from the parsed document — data for pages[].links,
 * independent of what the queue is allowed to follow. */
function collectLinks(doc: Document, baseUrl: string): string[] {
  const links: string[] = [];
  const anchors = doc.querySelectorAll('a[href]');
  for (let i = 0; i < anchors.length; i++) {
    const href = anchors[i].getAttribute('href');
    if (!href) continue;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // fragment / empty
    if (/^(mailto:|tel:|javascript:|data:)/i.test(trimmed)) continue;
    try {
      const resolved = new URL(trimmed, baseUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
      if (isAssetUrl(resolved.toString())) continue;
      if (!links.includes(resolved.toString())) links.push(resolved.toString());
    } catch {
      // Malformed href — ignore.
    }
  }
  return links;
}

export const crawlerService = new CrawlerService();
export default CrawlerService;
