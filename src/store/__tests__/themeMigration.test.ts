import { describe, it, expect } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { useGiaStore } from '../useGiaStore';

/**
 * The migration that actually delivers the new default.
 *
 * Without it, Obsidian Aurora only ever reaches new installs: every existing
 * user has `'dark'` written to IndexedDB and stays on the old look forever,
 * which makes "the default is Obsidian Aurora" true only for people who have
 * not opened the app yet.
 *
 * The asymmetry is the interesting part. `'dark'` was the previous default, so
 * a stored `'dark'` is indistinguishable from "never chose" and gets migrated.
 * `'light'` and `'system'` were always deliberate departures and are left alone
 * — the app does not overrule a choice someone actually made.
 */

/** The migrate function as declared on the persisted store. */
const migrateOf = (() => {
  // The options object is captured by zustand/persist, not exported. Reaching it
  // through the store instance keeps the test against the real implementation
  // rather than a copy of the logic that could drift.
  const anyStore = useGiaStore as unknown as {
    persist?: { getOptions?: () => { migrate?: (s: unknown, v: number) => unknown } };
  };
  return anyStore.persist?.getOptions?.()?.migrate;
})();

describe('theme migration (v3 -> v4)', () => {
  it('migrates a legacy dark theme to Obsidian Aurora', () => {
    if (!migrateOf) throw new Error('migrate not exposed');
    const out = migrateOf({ theme: 'dark' }, 3) as { theme: string };
    expect(out.theme).toBe('obsidian-aurora');
  });

  it('migrates a missing theme to Obsidian Aurora', () => {
    if (!migrateOf) throw new Error('migrate not exposed');
    const out = migrateOf({}, 3) as { theme: string };
    expect(out.theme).toBe('obsidian-aurora');
  });

  it('leaves a deliberate light choice alone', () => {
    if (!migrateOf) throw new Error('migrate not exposed');
    const out = migrateOf({ theme: 'light' }, 3) as { theme: string };
    expect(out.theme).toBe('light');
  });

  it('leaves a deliberate system choice alone', () => {
    if (!migrateOf) throw new Error('migrate not exposed');
    const out = migrateOf({ theme: 'system' }, 3) as { theme: string };
    expect(out.theme).toBe('system');
  });

  it('leaves someone already on Obsidian Aurora untouched', () => {
    if (!migrateOf) throw new Error('migrate not exposed');
    const out = migrateOf({ theme: 'obsidian-aurora' }, 3) as { theme: string };
    expect(out.theme).toBe('obsidian-aurora');
  });

  it('does not re-migrate a state already at the current version', () => {
    if (!migrateOf) throw new Error('migrate not exposed');
    const out = migrateOf({ theme: 'dark' }, 4) as { theme: string };
    expect(out.theme).toBe('dark');
  });

  it('still performs the older message-tree migration', () => {
    if (!migrateOf) throw new Error('migrate not exposed');
    const out = migrateOf({
      theme: 'dark',
      sessions: [{ id: 's1', messages: [{ id: 'm1', role: 'user', content: 'hi' }] }],
    }, 2) as { theme: string; sessions: { messages: { message: { branchId: string } }[] }[] };

    expect(out.theme).toBe('obsidian-aurora');
    expect(out.sessions[0].messages[0].message.branchId).toBeTruthy();
  });
});

describe('store sanity', () => {
  it('builds a working vanilla store from the same state shape', () => {
    // Cheap guard that the store module still constructs outside React, which
    // the tool layer relies on.
    expect(createStore(() => useGiaStore.getState())).toBeTruthy();
  });
});