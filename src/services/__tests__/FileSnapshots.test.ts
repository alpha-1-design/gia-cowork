import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the platform gate so capture() records even outside the Tauri shell —
// we want to exercise the ring-buffer and revert bookkeeping, not the bridge.
vi.mock('../../platform', () => ({ isTauri: () => true }));

// Stub the host FS bridge: the real DesktopHostFS dynamically imports
// @tauri-apps/api/core, which rejects outside a Tauri window.
const hostFiles = new Map<string, string>();
vi.mock('../DesktopHostFS', () => ({
  default: {
    isAvailable: true,
    readFile: async (path: string) => {
      const v = hostFiles.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    writeFile: async (path: string, content: string) => {
      hostFiles.set(path, content);
      return content.length;
    },
  },
}));

import { fileSnapshots } from '../FileSnapshots';

describe('FileSnapshots', () => {
  beforeEach(() => {
    fileSnapshots.clear();
    hostFiles.clear();
  });

  it('captures the previous content before a write', async () => {
    hostFiles.set('/tmp/a.txt', 'old content');
    const snap = await fileSnapshots.capture('/tmp/a.txt', 'new content', 'filesystem_write');
    expect(snap).not.toBeNull();
    expect(snap!.path).toBe('/tmp/a.txt');
    expect(snap!.previousContent).toBe('old content');
    expect(snap!.newContent).toBe('new content');
    expect(snap!.reverted).toBe(false);
  });

  it('records a null previousContent when the file did not exist', async () => {
    const snap = await fileSnapshots.capture('/tmp/brand-new.txt', 'first');
    expect(snap!.previousContent).toBeNull();
  });

  it('lists snapshots newest first', async () => {
    const a = await fileSnapshots.capture('/tmp/a.txt', 'a');
    const b = await fileSnapshots.capture('/tmp/b.txt', 'b');
    const c = await fileSnapshots.capture('/tmp/c.txt', 'c');
    const ids = fileSnapshots.list().map(s => s.id);
    expect(ids.indexOf(c!.id)).toBeLessThan(ids.indexOf(b!.id));
    expect(ids.indexOf(b!.id)).toBeLessThan(ids.indexOf(a!.id));
  });

  it('separates pending from reverted', async () => {
    const a = await fileSnapshots.capture('/tmp/a.txt', 'a');
    await fileSnapshots.capture('/tmp/b.txt', 'b');
    expect(fileSnapshots.listPending()).toHaveLength(2);

    await fileSnapshots.revert(a!.id);
    expect(fileSnapshots.listPending()).toHaveLength(1);
    expect(fileSnapshots.get(a!.id)!.reverted).toBe(true);
  });

  it('refuses to revert an unknown snapshot', async () => {
    const res = await fileSnapshots.revert('does-not-exist');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it('refuses to revert the same snapshot twice', async () => {
    const snap = await fileSnapshots.capture('/tmp/a.txt', 'a');
    const first = await fileSnapshots.revert(snap!.id);
    expect(first.success).toBe(true);
    const second = await fileSnapshots.revert(snap!.id);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already reverted/i);
  });

  it('reverts a newly-created file to empty rather than failing', async () => {
    const snap = await fileSnapshots.capture('/tmp/new.txt', 'created content');
    expect(snap!.previousContent).toBeNull();
    const res = await fileSnapshots.revert(snap!.id);
    expect(res.success).toBe(true);
    expect(hostFiles.get('/tmp/new.txt')).toBe('');
  });

  it('restores the original bytes on revert', async () => {
    hostFiles.set('/tmp/keep.txt', 'original');
    const snap = await fileSnapshots.capture('/tmp/keep.txt', 'clobbered');
    const res = await fileSnapshots.revert(snap!.id);
    expect(res.success).toBe(true);
    expect(hostFiles.get('/tmp/keep.txt')).toBe('original');
  });

  it('unwinds overlapping writes to the same file in order', async () => {
    // Model the real sequence: snapshot the current disk contents, then the
    // caller actually writes the new contents to disk.
    hostFiles.set('/tmp/same.txt', 'v1');
    const first = await fileSnapshots.capture('/tmp/same.txt', 'v2');
    hostFiles.set('/tmp/same.txt', 'v2');
    const second = await fileSnapshots.capture('/tmp/same.txt', 'v3');
    hostFiles.set('/tmp/same.txt', 'v3');

    // Newest first: reverting the last write restores v2, not v1.
    await fileSnapshots.revert(second!.id);
    expect(hostFiles.get('/tmp/same.txt')).toBe('v2');
    await fileSnapshots.revert(first!.id);
    expect(hostFiles.get('/tmp/same.txt')).toBe('v1');
  });

  it('bounds history so a long session cannot blow storage', async () => {
    for (let i = 0; i < 60; i++) {
      await fileSnapshots.capture(`/tmp/file-${i}.txt`, `content ${i}`);
    }
    const all = fileSnapshots.list();
    expect(all.length).toBeLessThanOrEqual(50);
    // The oldest entries are the ones dropped, so the newest must survive.
    expect(all[0].newContent).toBe('content 59');
  });

  it('revertAll unwinds every pending snapshot', async () => {
    await fileSnapshots.capture('/tmp/a.txt', 'a');
    await fileSnapshots.capture('/tmp/b.txt', 'b');
    await fileSnapshots.capture('/tmp/c.txt', 'c');
    const result = await fileSnapshots.revertAll();
    expect(result.reverted).toBe(3);
    expect(result.failed).toBe(0);
    expect(fileSnapshots.listPending()).toHaveLength(0);
  });

  it('clears all history', async () => {
    await fileSnapshots.capture('/tmp/a.txt', 'a');
    fileSnapshots.clear();
    expect(fileSnapshots.list()).toHaveLength(0);
  });
});
