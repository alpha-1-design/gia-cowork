import { logger } from '../utils/logger';

/**
 * Version checking — telling the user they are behind.
 *
 * This was a real gap, not a missing nicety: `GIAUpdate` exposed only
 * `installApk`, which throws on every platform, and nothing in the app
 * referenced it. There was no update check at all, which means a user running
 * a three-week-old build had no way to learn that existed.
 *
 * Kept deliberately small and honest:
 *
 *  - It never blocks anything. A failed check is silent, because a version
 *    lookup failing is not the user's problem and must never interrupt work.
 *  - It runs on a long interval and caches the result, so it cannot become a
 *    network call on app start.
 *  - It reports a comparison, not a promise. It cannot install anything, and it
 *    does not pretend to.
 */

export interface VersionInfo {
  current: string;
  latest: string | null;
  /** True only when `latest` is known to be newer than `current`. */
  updateAvailable: boolean;
  releaseUrl: string | null;
  checkedAt: number;
  error?: string;
}

const RELEASES_URL = 'https://api.github.com/repos/alpha-1-design/gia-cowork/releases/latest';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // six hours
const STORAGE_KEY = 'gia-version-check-v1';

/** Injected so this is testable without a network or a real clock. */
export interface VersionCheckDeps {
  fetchJson: (url: string) => Promise<unknown>;
  now: () => number;
}

const defaultDeps: VersionCheckDeps = {
  fetchJson: async (url) => {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    return res.json();
  },
  now: () => Date.now(),
};

/**
 * Compare dotted version strings.
 *
 * Numeric, not lexicographic — "0.10.0" must beat "0.9.0", and a plain string
 * compare gets that exactly backwards. Pre-release suffixes sort below the
 * matching release, so a `1.2.0-beta` is not reported as an upgrade from
 * `1.1.0` when `1.2.0` is already out.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/i, '').split('-');
    const nums = core.split('.').map(n => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums: nums.slice(0, 3), pre: pre ?? '' };
  };
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  }
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;      // release beats pre-release
  if (!b.pre) return false;
  return a.pre > b.pre;
}

export class VersionCheck {
  private cached: VersionInfo | null = null;
  private inFlight: Promise<VersionInfo> | null = null;
  private deps: VersionCheckDeps;

  constructor(deps: Partial<VersionCheckDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  /** Test seam — swap the fetcher and clock. */
  setDeps(deps: Partial<VersionCheckDeps>) {
    this.deps = { ...this.deps, ...deps };
  }

  get currentVersion(): string {
    // Replaced with a string literal at build time by vite.config.ts `define`.
    // The previous `import.meta.env.VITE_APP_VERSION` was never set by anyone,
    // so this always resolved to a hardcoded 0.1.0 fallback and the banner told
    // every user -- including those already on the newest build -- that they
    // were permanently out of date.
    //
    // Note this must be a bare identifier: Vite's `define` substitutes
    // identifiers, not property accesses, so `globalThis.__APP_VERSION__`
    // would silently stay undefined at runtime.
    try {
      if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__) return __APP_VERSION__;
    } catch { /* not defined (e.g. plain test run) -- fall through */ }
    return '0.0.0';
  }

  /** Cached result, or null if never checked. Never triggers a fetch. */
  peek(): VersionInfo | null {
    return this.cached ?? this.readStored();
  }

  private readStored(): VersionInfo | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return typeof parsed?.checkedAt === 'number' ? parsed as VersionInfo : null;
    } catch {
      return null;
    }
  }

  private writeStored(info: VersionInfo) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(info)); } catch { /* storage unavailable */ }
  }

  /**
   * Check for a newer release, respecting the cache interval.
   *
   * Concurrent callers share one in-flight request — otherwise a component that
   * mounts twice on startup fires two identical GitHub requests.
   */
  async check(force = false): Promise<VersionInfo> {
    const now = this.deps.now();
    const cached = this.peek();
    if (!force && cached && now - cached.checkedAt < CHECK_INTERVAL_MS) return cached;
    // Always join an in-flight request, even when forced. `force` means "ignore
    // the cache", not "send another copy of a request that is already going" —
    // three components mounting at once should produce one GitHub request.
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async (): Promise<VersionInfo> => {
      const current = this.currentVersion;
      try {
        const data = await this.deps.fetchJson(RELEASES_URL) as { tag_name?: string; html_url?: string };
        const latest = typeof data?.tag_name === 'string' ? data.tag_name.replace(/^v/i, '') : null;
        const info: VersionInfo = {
          current,
          latest,
          // No tag means no comparison is possible, and guessing "yes" would
          // nag every user forever about an update that may not exist.
          updateAvailable: latest ? isNewerVersion(latest, current) : false,
          releaseUrl: typeof data?.html_url === 'string' ? data.html_url : null,
          checkedAt: now,
        };
        this.cached = info;
        this.writeStored(info);
        return info;
      } catch (e) {
        const info: VersionInfo = {
          current, latest: null, updateAvailable: false, releaseUrl: null,
          checkedAt: now, error: e instanceof Error ? e.message : 'check failed',
        };
        this.cached = info;
        // Deliberately not persisted: a failure must not suppress the next
        // real check for six hours.
        logger.debug('[VersionCheck] failed:', info.error);
        return info;
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  reset() {
    this.cached = null;
    this.inFlight = null;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
}

const DISMISS_KEY = 'gia-version-dismissed-v1';

/**
 * Which release the user has already dismissed.
 *
 * Dismissal used to be plain component state, so the banner came back on every
 * reload and every remount -- an update notice you cannot get rid of is worse
 * than no notice at all. Recording the dismissed *version* (rather than a
 * boolean) means it stays gone until a genuinely newer release appears, which
 * is the only time the message is worth showing again.
 */
export function dismissedVersion(): string | null {
  try { return localStorage.getItem(DISMISS_KEY); } catch { return null; }
}

export function dismissVersion(latest: string) {
  try { localStorage.setItem(DISMISS_KEY, latest); } catch { /* ignore */ }
}

export function clearDismissedVersion() {
  try { localStorage.removeItem(DISMISS_KEY); } catch { /* ignore */ }
}

export const versionCheck = new VersionCheck();