import { describe, it, expect } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { useGiaStore } from '../useGiaStore';

/**
 * Theme migration is deliberately quiet.
 *
 * Dark is the clean monochrome default again. A stored `'dark'` is therefore
 * already the right answer, and rewriting it to Obsidian Aurora would overrule
 * someone who chose the neutral look. The migration only has to leave explicit
 * choices alone while the older message-tree migration continues to run.
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
  it('leaves a legacy dark theme on dark', () => {
    if (!migrateOf) throw new Error('migrate not exposed');
    const out = migrateOf({ theme: 'dark' }, 3) as { theme: string };
    expect(out.theme).toBe('dark');
  });

  it('does not invent a theme when one is missing', () => {
    if (!migrateOf) throw new Error('migrate not exposed');
    const out = migrateOf({}, 3) as { theme?: string };
    expect(out.theme).toBeUndefined();
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

    expect(out.theme).toBe('dark');
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
