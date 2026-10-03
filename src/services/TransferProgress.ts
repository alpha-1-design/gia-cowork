import { create } from 'zustand';

export interface TransferTask {
  id: string;
  label: string;
  /** 0..1, or null when the total size is unknown and only activity is known. */
  progress: number | null;
  detail?: string;
  status: 'active' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

interface TransferStore {
  tasks: TransferTask[];
  start: (id: string, label: string, totalBytes?: number) => void;
  update: (id: string, progress: number | null, detail?: string) => void;
  setBytes: (id: string, loaded: number, total: number) => void;
  complete: (id: string) => void;
  fail: (id: string, error: string) => void;
  clear: (id: string) => void;
  activeCount: () => number;
}

/**
 * Global transfer progress.
 *
 * Model downloads, sandbox installs and app updates all reported progress to
 * their own callers, but nothing surfaced it globally — so the biggest and
 * slowest transfers in the app were the ones with the least feedback. Any
 * long-running transfer can register here and the TransferIndicator renders
 * it app-wide.
 *
 * Finished and failed tasks linger briefly so the user sees the outcome
 * rather than a bar that vanishes the instant it completes.
 */

const LINGER_MS = 2500;
const MAX_HISTORY = 20;

let counter = 0;
const nextId = (base: string) => `${base}-${Date.now()}-${++counter}`;

export const useTransferStore = create<TransferStore>((set, get) => ({
  tasks: [],

  start: (id, label, totalBytes) =>
    set((s) => ({
      tasks: [
        ...s.tasks.filter(t => t.id !== id),
        {
          id,
          label,
          // Byte totals give a real percentage; without one we still show
          // indeterminate activity rather than nothing.
          progress: totalBytes && totalBytes > 0 ? 0 : null,
          status: 'active' as const,
          startedAt: Date.now(),
        },
      ].slice(-MAX_HISTORY),
    })),

  update: (id, progress, detail) =>
    set((s) => ({
      tasks: s.tasks.map(t =>
        t.id === id ? { ...t, progress, detail, status: 'active' as const } : t
      ),
    })),

  setBytes: (id, loaded, total) =>
    set((s) => ({
      tasks: s.tasks.map(t =>
        t.id === id && total > 0
          ? { ...t, progress: Math.min(1, loaded / total), detail: `${formatBytes(loaded)} / ${formatBytes(total)}` }
          : t
      ),
    })),

  complete: (id) =>
    set((s) => ({
      tasks: s.tasks.map(t =>
        t.id === id ? { ...t, status: 'done' as const, progress: 1, finishedAt: Date.now() } : t
      ),
    })),

  fail: (id, error) =>
    set((s) => ({
      tasks: s.tasks.map(t =>
        t.id === id ? { ...t, status: 'error' as const, error, finishedAt: Date.now() } : t
      ),
    })),

  clear: (id) => set((s) => ({ tasks: s.tasks.filter(t => t.id !== id) })),

  activeCount: () => get().tasks.filter(t => t.status === 'active').length,
}));

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Convenience wrapper so callers don't juggle ids. */
export const transferProgress = {
  start: (label: string, totalBytes?: number) => {
    const id = nextId('t');
    useTransferStore.getState().start(id, label, totalBytes);
    return id;
  },
  setBytes: (id: string, loaded: number, total: number) => useTransferStore.getState().setBytes(id, loaded, total),
  update: (id: string, progress: number | null, detail?: string) => useTransferStore.getState().update(id, progress, detail),
  complete: (id: string) => useTransferStore.getState().complete(id),
  fail: (id: string, error: string) => useTransferStore.getState().fail(id, error),
  clear: (id: string) => useTransferStore.getState().clear(id),
  isLingering: (t: TransferTask) =>
    t.status !== 'active' && t.finishedAt !== undefined && Date.now() - t.finishedAt < LINGER_MS,
};

export default transferProgress;