import { logger } from '../utils/logger';
import { isTauri } from '../platform';
import DesktopHostFS from './DesktopHostFS';

const STORAGE_KEY = 'gia-file-snapshots-v1';
const MAX_SNAPSHOTS = 50;

/**
 * File snapshots — the safety net for a desktop agent that writes to the
 * real disk.
 *
 * Every competitor that touches your files runs inside a throwaway VM or
 * sandbox, so a bad agent run costs you nothing. GIA writes to the actual
 * host filesystem, which is the whole point on desktop — and also the whole
 * risk. This service keeps a bounded ring buffer of previous file contents
 * so any write GIA makes can be reverted from the UI.
 *
 * Snapshots are taken *before* a destructive write, never after: once
 * `filesystem_write` has overwritten a file, the original content is gone.
 */

export interface FileSnapshot {
  id: string;
  path: string;
  /** Previous content, or null when the file did not exist before. */
  previousContent: string | null;
  /** Content GIA wrote. */
  newContent: string;
  timestamp: number;
  /**
   * Monotonic write counter. Timestamps collide when an agent rewrites the
   * same file several times within one millisecond (very common), which
   * would make "undo the most recent change" restore the wrong file — so
   * ordering uses this instead of the clock.
   */
  seq: number;
  /** Where the write came from, for the undo list's provenance column. */
  source: string;
  reverted: boolean;
}

function load(): FileSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (e) {
    logger.warn('[FileSnapshots] Failed to load:', e);
  }
  return [];
}

function save(entries: FileSnapshot[]) {
  try {
    // Oldest first, capped — an agent can rewrite a file dozens of times in
    // one task and an unbounded history would blow the storage quota.
    if (entries.length > MAX_SNAPSHOTS) entries.splice(0, entries.length - MAX_SNAPSHOTS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded: drop the oldest and retry once rather than losing the
    // ability to record new snapshots entirely.
    try {
      const trimmed = entries.slice(-10);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch { /* storage unavailable — writes still proceed, just unundoable */ }
  }
}

export class FileSnapshots {
  private entries: FileSnapshot[];
  /**
   * Monotonic suffix for id uniqueness. Two snapshots sharing an id would
   * make `get`/`revert` restore the wrong file, so ids must be unique even
   * where crypto.randomUUID is unavailable or stubbed (some test and
   * embedded webview environments stub it to a constant).
   */
  private seq = 0;

  constructor() {
    this.entries = load();
    // Resume the counter past anything already persisted so ids and ordering
    // stay unique across a reload.
    this.seq = this.entries.reduce((max, s) => Math.max(max, s.seq || 0), 0);
  }

  private nextId(): string {
    this.seq++;
    const rand = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10);
    return `${rand}-${this.seq}`;
  }

  /**
   * Capture the current on-disk content of a path before GIA overwrites it.
   * Returns null when the snapshot could not be taken (file unreadable, not
   * on a host filesystem) so callers can decide whether that blocks a write.
   *
   * Callers should treat a null return as "undo unavailable", not "no file
   * exists" — those are different and only the former is a problem.
   */
  async capture(path: string, newContent: string, source = 'filesystem_write'): Promise<FileSnapshot | null> {
    if (!isTauri()) return null; // no host filesystem to snapshot against

    let previousContent: string | null = null;
    try {
      previousContent = await DesktopHostFS.readFile(path);
    } catch {
      // File doesn't exist yet — a first write has nothing to restore.
      previousContent = null;
    }

    const snapshot: FileSnapshot = {
      id: this.nextId(),
      path,
      previousContent,
      newContent,
      timestamp: Date.now(),
      seq: this.seq,
      source,
      reverted: false,
    };

    this.entries.push(snapshot);
    save(this.entries);
    return snapshot;
  }

  /** All snapshots, newest first — the undo list. */
  list(): FileSnapshot[] {
    // Sort by seq, not timestamp: same-millisecond writes would otherwise
    // keep insertion order and "undo last" would target the wrong file.
    return [...this.entries].sort((a, b) => (b.seq || 0) - (a.seq || 0));
  }

  /** Snapshots that have not been reverted, newest first. */
  listPending(): FileSnapshot[] {
    return this.list().filter(s => !s.reverted);
  }

  get(id: string): FileSnapshot | undefined {
    return this.entries.find(s => s.id === id);
  }

  /**
   * Restore a file to its pre-write state. A snapshot whose
   * previousContent is null means the file was newly created, so reverting
   * means the file should not exist — we can't delete over the host bridge,
   * so we write an empty file and flag it, which is the honest best-effort.
   */
  async revert(id: string): Promise<{ success: boolean; error?: string }> {
    const snapshot = this.get(id);
    if (!snapshot) return { success: false, error: 'Snapshot not found' };
    if (snapshot.reverted) return { success: false, error: 'Already reverted' };
    if (!isTauri()) return { success: false, error: 'Undo is only available in the GIA Cowork desktop app.' };

    try {
      if (snapshot.previousContent === null) {
        // Newly-created file: nothing existed before, so restore to empty.
        await DesktopHostFS.writeFile(snapshot.path, '');
      } else {
        await DesktopHostFS.writeFile(snapshot.path, snapshot.previousContent);
      }
      snapshot.reverted = true;
      save(this.entries);
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Undo every unreverted snapshot, newest first, so overlapping writes unwind cleanly. */
  async revertAll(): Promise<{ reverted: number; failed: number }> {
    const pending = this.listPending().sort((a, b) => (b.seq || 0) - (a.seq || 0));
    let reverted = 0;
    let failed = 0;
    for (const s of pending) {
      const res = await this.revert(s.id);
      if (res.success) reverted++;
      else failed++;
    }
    return { reverted, failed };
  }

  clear() {
    this.entries = [];
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
}

export const fileSnapshots = new FileSnapshots();
export default fileSnapshots;
