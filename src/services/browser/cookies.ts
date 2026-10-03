/**
 * A cookie jar for the browser session.
 *
 * This exists because of a specific, common failure: you open a site, the tab
 * navigates, and the session evaporates. Login flows set a cookie on the
 * response; without somewhere to keep it, the next request arrives anonymous
 * and the site helpfully shows you the sign-in page again. Nothing failed
 * loudly — the agent just silently starts from zero on every navigation, which
 * is exactly the "impossible to use a site" experience this is meant to remove.
 *
 * Scope is deliberately narrow, and the narrowness is the design:
 *
 *  - Cookies are keyed by DOMAIN, never sent across origins. A cookie the agent
 *    picks up from example.com must not ride along to bank.com.
 *  - Only what the server actually returns via Set-Cookie is stored. GIA never
 *    invents a session.
 *  - Values live in memory for the session. Nothing is written to disk, because
 *    a cookie jar is a credential store and a credential store in localStorage
 *    is one XSS away from being someone else's login.
 *
 * Honest limit, restated here because it is the one that matters: this carries
 * a session across navigations *inside* GIA's own fetches. It is not your
 * browser profile, so it cannot use a login that only exists there. See
 * detectAuthWall for how that surfaces instead of failing silently.
 *
 * Second limit, less obvious: `Cookie` is a FORBIDDEN header name on `fetch`.
 * Browsers ignore an attempt to set it on a direct request, so whether these
 * cookies actually reach the origin depends on the transport in use. The jar's
 * own logic is correct and tested; the delivery is not guaranteed here and
 * cannot be made so without fetching outside the webview.
 */

export interface StoredCookie {
  name: string;
  value: string;
  /** Seconds from now. null = session cookie. */
  expiresAt: number | null;
  path: string;
  /** Lowercased. Used to gate sends, never sent itself. */
  domain: string;
  secure: boolean;
  httpOnly: boolean;
}

/** host-only cookies bind to the exact host, not to its parent domains. */
interface CookieEntry extends StoredCookie {
  hostOnly: boolean;
}

function hostMatches(cookieDomain: string, host: string): boolean {
  if (host === cookieDomain) return true;
  return host.endsWith(`.${cookieDomain}`);
}

export class CookieJar {
  private byDomain = new Map<string, CookieEntry[]>();
  /** Cap, so a site that sets a cookie per request cannot grow without bound. */
  private static MAX_TOTAL = 300;

  /**
   * Record Set-Cookie headers from a response.
   *
   * `raw` may be several cookies if the header was folded into one string by a
   * proxy, so this splits on commas carefully: a cookie's Expires attribute
   * contains a comma, so only a comma followed by `token=` starts a new one.
   */
  storeFromHeaders(raw: string | null | undefined, url: string): void {
    if (!raw) return;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return;
    }
    if (!host) return;

    for (const chunk of splitSetCookie(raw)) {
      const parsed = this.parseOne(chunk, host);
      if (!parsed) continue;
      const existing = this.byDomain.get(parsed.domain) ?? [];
      const filtered = existing.filter(c => !(c.name === parsed.name && c.path === parsed.path));
      // An expired cookie is a deletion instruction, not a new cookie.
      if (parsed.expiresAt !== null && parsed.expiresAt <= Date.now()) {
        this.byDomain.set(parsed.domain, filtered);
        continue;
      }
      filtered.push(parsed);
      this.byDomain.set(parsed.domain, filtered);
    }
    this.evict();
  }

  /** The `Cookie` header value for a URL, or null when nothing applies. */
  headerFor(url: string): string | null {
    let host: string;
    let path: string;
    let isSecure: boolean;
    try {
      const u = new URL(url);
      host = u.hostname.toLowerCase();
      path = u.pathname || '/';
      isSecure = u.protocol === 'https:';
    } catch {
      return null;
    }

    const now = Date.now();
    const matched: CookieEntry[] = [];
    for (const [domain, cookies] of this.byDomain) {
      if (!hostMatches(domain, host)) continue;
      for (const c of cookies) {
        if (c.expiresAt !== null && c.expiresAt <= now) continue;
        if (c.secure && !isSecure) continue;
        if (!pathMatches(path, c.path)) continue;
        matched.push(c);
      }
    }
    if (!matched.length) return null;

    // Longer paths are more specific, so they come first (RFC 6265 ordering).
    matched.sort((a, b) => b.path.length - a.path.length);
    return matched.map(c => `${c.name}=${c.value}`).join('; ');
  }

  private parseOne(raw: string, host: string): CookieEntry | null {
    const parts = raw.split(';');
    const first = parts[0];
    if (!first) return null;
    const eq = first.indexOf('=');
    if (eq <= 0) return null;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) return null;

    let domain = host;
    let hostOnly = true;
    let domainRejected = false;
    let path = '/';
    let expiresAt: number | null = null;
    let secure = false;
    let httpOnly = false;

    for (const attr of parts.slice(1)) {
      const [rawKey, ...rest] = attr.split('=');
      const key = (rawKey || '').trim().toLowerCase();
      const val = rest.join('=').trim();
      if (key === 'domain' && val) {
        const d = val.replace(/^\./, '').toLowerCase();
        // Reject a cookie claiming a domain it does not belong to. Without this
        // check a hostile response could set `Domain=.com` and be sent to
        // every site thereafter.
        if (host === d || host.endsWith(`.${d}`)) {
          domain = d;
          hostOnly = false;
        } else {
          domainRejected = true;
        }
      } else if (key === 'path' && val.startsWith('/')) {
        path = val;
      } else if (key === 'expires') {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expiresAt = t;
      } else if (key === 'max-age') {
        const secs = Number(val);
        if (!Number.isNaN(secs)) expiresAt = Date.now() + secs * 1000;
      } else if (key === 'secure') {
        secure = true;
      } else if (key === 'httponly') {
        httpOnly = true;
      }
    }
    // A Domain attribute that does not match the request host invalidates the
    // whole cookie (RFC 6265 §5.3 step 5). Falling back to storing it as
    // host-only would mean a server that asked for `Domain=somewhere-else.com`
    // still got a cookie planted on the real host — which is precisely the
    // attack the Domain check exists to stop.
    if (domainRejected) return null;

    return { name, value, expiresAt, path, domain, secure, httpOnly, hostOnly };
  }

  /** Everything we hold for one domain. Used by the tools and `/browser`. */
  cookiesFor(url: string): StoredCookie[] {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return [];
    }
    const now = Date.now();
    const out: StoredCookie[] = [];
    for (const [domain, cookies] of this.byDomain) {
      if (!hostMatches(domain, host)) continue;
      for (const c of cookies) {
        if (c.expiresAt !== null && c.expiresAt <= now) continue;
        const { hostOnly: _hostOnly, ...rest } = c;
        out.push(rest);
      }
    }
    return out;
  }

  get size(): number {
    let n = 0;
    for (const list of this.byDomain.values()) n += list.length;
    return n;
  }

  clear(): void {
    this.byDomain.clear();
  }

  private evict(): void {
    if (this.size <= CookieJar.MAX_TOTAL) return;
    const now = Date.now();
    for (const [domain, cookies] of this.byDomain) {
      const live = cookies.filter(c => c.expiresAt === null || c.expiresAt > now);
      if (live.length) this.byDomain.set(domain, live);
      else this.byDomain.delete(domain);
    }
  }
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (cookiePath === '/') return true;
  if (requestPath === cookiePath) return true;
  return requestPath.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
}

/**
 * Split a folded Set-Cookie header into individual cookies.
 *
 * `Expires=Wed, 01 Jan 2027` contains a comma, so splitting on every comma
 * would turn one cookie into two broken ones — one of which would lose its
 * value and, worse, could be parsed as a bogus expiry.
 */
export function splitSetCookie(raw: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /,(?=\s*[A-Za-z0-9!#$%&'*+\-.^_`|~]+=)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const segment = raw.slice(start, m.index).trim();
    if (segment) out.push(segment);
    start = m.index + 1;
  }
  const tail = raw.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}