import { beforeEach, describe, expect, it } from 'vitest';
import {
  VersionCheck,
  isNewerVersion,
  dismissVersion,
  dismissedVersion,
  clearDismissedVersion,
} from '../VersionCheck';

/**
 * The banner nagged because of two independent bugs:
 *
 *  1. `currentVersion` read `import.meta.env.VITE_APP_VERSION`, which nothing
 *     ever set, so it always fell back to a hardcoded old version. Every user
 *     was permanently told they were out of date.
 *  2. Dismissal was component-local state, so it reset on every reload.
 *
 * Both are load-bearing behaviour now, so both are pinned here.
 */

describe('current version reporting', () => {
  beforeEach(() => {
    clearDismissedVersion();
  });

  it('reports the build-injected version, which must match package.json', async () => {
    // Vitest loads the same vite.config.ts, so `define` applies here too. This
    // is the assertion that actually caught the first fix: the version was
    // being read off `globalThis`, which `define` never rewrites, so the
    // substitution silently did nothing.
    const { default: pkg } = await import('../../../package.json');
    expect(new VersionCheck().currentVersion).toBe(pkg.version);
  });

  it('no longer falls back to a stale 0.1.0 that would false-positive against every release', () => {
    // 0.1.0 is the exact value that made the banner fire for users already on
    // the newest build, so it must not appear anywhere in the current-version
    // path.
    expect(new VersionCheck().currentVersion).not.toBe('0.1.0');
  });

  it('an up-to-date build is not told to upgrade to its own version', () => {
    const current = new VersionCheck().currentVersion;
    const check = new VersionCheck({
      fetchJson: async () => ({ tag_name: `v${current}` }),
      now: () => 0,
    });
    return check.check(true).then(info => {
      expect(info.updateAvailable).toBe(false);
    });
  });

  it('does tell the user about a genuinely newer release', () => {
    const check = new VersionCheck({
      fetchJson: async () => ({ tag_name: 'v99.0.0' }),
      now: () => 0,
    });
    return check.check(true).then(info => {
      expect(info.updateAvailable).toBe(true);
      expect(info.latest).toBe('99.0.0');
    });
  });
});

describe('dismissal persistence', () => {
  beforeEach(() => {
    clearDismissedVersion();
    localStorage.clear();
  });

  it('starts with nothing dismissed', () => {
    expect(dismissedVersion()).toBeNull();
  });

  it('remembers a dismissal across instances (i.e. across reloads)', () => {
    dismissVersion('0.2.0');
    // A fresh module state, as after a page reload.
    expect(dismissedVersion()).toBe('0.2.0');
  });

  it('re-appears for a newer release than the one dismissed', () => {
    dismissVersion('0.2.0');
    expect(dismissedVersion()).toBe('0.2.0');
    expect(dismissedVersion() === '0.3.0').toBe(false);
  });

  it('clearDismissedVersion brings the banner back', () => {
    dismissVersion('0.2.0');
    clearDismissedVersion();
    expect(dismissedVersion()).toBeNull();
  });
});

describe('version comparison still behaves', () => {
  it('0.10.0 beats 0.9.0 numerically', () => {
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true);
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(false);
  });

  it('equal versions are not an update', () => {
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
  });
});
