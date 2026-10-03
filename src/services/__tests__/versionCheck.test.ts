import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isNewerVersion, VersionCheck } from '../VersionCheck';

describe('isNewerVersion', () => {
  it('compares numerically, not as strings', () => {
    // The whole reason this function exists: "0.10.0" > "0.9.0" numerically,
    // but a string compare gets it exactly backwards.
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true);
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(false);
  });

  it('compares each position', () => {
    expect(isNewerVersion('1.2.0', '1.1.9')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
    expect(isNewerVersion('1.1.1', '1.1.1')).toBe(false);
  });

  it('tolerates a v prefix and missing segments', () => {
    expect(isNewerVersion('v1.2.0', '1.1.0')).toBe(true);
    expect(isNewerVersion('1.2', '1.1.9')).toBe(true);
  });

  it('sorts a release above its own pre-release', () => {
    expect(isNewerVersion('1.2.0', '1.2.0-beta')).toBe(true);
    expect(isNewerVersion('1.2.0-beta', '1.2.0')).toBe(false);
  });
});

describe('VersionCheck', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reports an available update', async () => {
    const vc = new VersionCheck({
      fetchJson: async () => ({ tag_name: 'v9.9.9', html_url: 'https://example/releases/9.9.9' }),
      now: () => 1_000_000,
    });
    const info = await vc.check(true);
    expect(info.updateAvailable).toBe(true);
    expect(info.latest).toBe('9.9.9');
    expect(info.releaseUrl).toContain('9.9.9');
  });

  it('says nothing is new when the build is current', async () => {
    const vc = new VersionCheck({
      fetchJson: async () => ({ tag_name: 'v0.0.1' }),
      now: () => 1_000_000,
    });
    expect((await vc.check(true)).updateAvailable).toBe(false);
  });

  it('does not nag when the release tag is missing', async () => {
    const vc = new VersionCheck({
      fetchJson: async () => ({ html_url: 'https://example' }),
      now: () => 1_000_000,
    });
    const info = await vc.check(true);
    // Guessing "yes" would nag every user forever about an update that may not exist.
    expect(info.latest).toBeNull();
    expect(info.updateAvailable).toBe(false);
  });

  it('fails quietly instead of showing an error', async () => {
    const vc = new VersionCheck({
      fetchJson: async () => { throw new Error('offline'); },
      now: () => 1_000_000,
    });
    const info = await vc.check(true);
    // Whether GitHub is reachable is not the user's problem.
    expect(info.updateAvailable).toBe(false);
    expect(info.error).toBeTruthy();
  });

  it('does not retry for hours after a failure', async () => {
    let calls = 0;
    let clock = 1_000_000;
    const vc = new VersionCheck({
      fetchJson: async () => { calls++; throw new Error('offline'); },
      now: () => clock,
    });
    await vc.check();
    await vc.check();
    // A failure must not suppress the next real check for six hours.
    expect(calls).toBe(1);

    clock += 7 * 60 * 60 * 1000;
    await vc.check();
    expect(calls).toBe(2);
  });

  it('serves a recent successful result from cache', async () => {
    let calls = 0;
    let clock = 1_000_000;
    const vc = new VersionCheck({
      fetchJson: async () => { calls++; return { tag_name: 'v9.9.9' }; },
      now: () => clock,
    });
    await vc.check(true);
    await vc.check();
    expect(calls).toBe(1);

    clock += 7 * 60 * 60 * 1000;
    await vc.check();
    expect(calls).toBe(2);
  });

  it('shares one request between concurrent callers', async () => {
    let calls = 0;
    const vc = new VersionCheck({
      fetchJson: async () => { calls++; return { tag_name: 'v9.9.9' }; },
      now: () => 1_000_000,
    });
    // A component that mounts twice must not fire two identical requests.
    await Promise.all([vc.check(true), vc.check(true), vc.check(true)]);
    expect(calls).toBe(1);
  });
});