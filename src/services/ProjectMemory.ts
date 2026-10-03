import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { idbStorage } from '../store/idb-storage';

/**
 * Project memory — GIA's own notes on what she works on.
 *
 * `/init` writes a one-time snapshot of a project. This is the other half:
 * the durable record she accumulates *while working*, the way a good developer
 * keeps a running log of decisions, gotchas, and "why it is built this way."
 *
 * The distinction matters. A scanned AGENTS.md says what the project *is*.
 * Project memory says what *happened* — the thing that broke twice, the
 * approach that was tried and rejected, the reason a weird-looking line
 * exists. That knowledge is not derivable by re-reading the code, and it is
 * exactly what is missing six weeks later.
 *
 * Entries are keyed by project, so switching projects does not blend two
 * codebases' notes together.
 */

export type ProjectMemoryKind =
  | 'decision'  // a choice was made, and why
  | 'gotcha'    // something here will bite you
  | 'architecture' // how a part of the system fits together
  | 'convention'  // a pattern this codebase follows
  | 'todo';     // unfinished work, deliberately parked

export interface ProjectMemoryEntry {
  id: string;
  project: string;
  kind: ProjectMemoryKind;
  title: string;
  body: string;
  /** File paths this entry is about — lets an agent recall it when relevant. */
  paths: string[];
  createdAt: number;
  updatedAt: number;
  /**
   * Monotonic ordering key.
   *
   * Two notes written in the same millisecond have an identical `updatedAt`,
   * so a timestamp sort left them in insertion order and "most recent first"
   * quietly showed the older one. This is the same trap the file-snapshot
   * undo list hit.
   */
  seq?: number;
}

interface ProjectMemoryState {
  entries: ProjectMemoryEntry[];
  /** `paths` is optional — plenty of notes are about the project as a whole. */
  add: (entry: Omit<ProjectMemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'seq' | 'paths'> & { paths?: string[] }) => ProjectMemoryEntry;
  update: (id: string, patch: Partial<Pick<ProjectMemoryEntry, 'title' | 'body' | 'kind' | 'paths'>>) => void;
  remove: (id: string) => void;
  list: (project: string) => ProjectMemoryEntry[];
  clearProject: (project: string) => void;
}

function seq(): string {
  return `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Monotonic counter, persisted alongside the entries.
 *
 * Restarting from 0 would collide with existing notes, so it is seeded above
 * whatever is already stored and only ever moves forward.
 */
function nextSeq(entries: ProjectMemoryEntry[]): number {
  const highest = entries.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
  counter = Math.max(counter, highest) + 1;
  return counter;
}
let counter = 0;

export const useProjectMemoryStore = create<ProjectMemoryState>()(
  persist(
    (set, get) => ({
      entries: [],

      add: (entry) => {
        const now = Date.now();
        // Re-adding the same kind+title for a project updates in place rather
        // than piling up near-duplicates — the second time you learn a gotcha
        // you want to sharpen it, not start a new row.
        const existing = get().entries.find(
          e => e.project === entry.project && e.kind === entry.kind &&
               e.title.toLowerCase() === entry.title.toLowerCase(),
        );
        if (existing) {
          const updated = { ...existing, body: entry.body, paths: entry.paths ?? existing.paths, updatedAt: now, seq: nextSeq(get().entries) };
          set({
            entries: get().entries.map(e => (e.id === existing.id ? updated : e)),
          });
          return updated;
        }
        const created: ProjectMemoryEntry = { ...entry, paths: entry.paths ?? [], id: seq(), createdAt: now, updatedAt: now, seq: nextSeq(get().entries) };
        set({ entries: [created, ...get().entries] });
        return created;
      },

      update: (id, patch) =>
        set({
          entries: get().entries.map(e => (e.id === id ? { ...e, ...patch, updatedAt: Date.now(), seq: nextSeq(get().entries) } : e)),
        }),

      remove: (id) => set({ entries: get().entries.filter(e => e.id !== id) }),

      list: (project) =>
        get()
          .entries.filter(e => e.project === project)
          // seq first, timestamp as the fallback for entries persisted before
          // seq existed.
          .sort((a, b) => (b.seq ?? b.updatedAt) - (a.seq ?? a.updatedAt)),

      clearProject: (project) => set({ entries: get().entries.filter(e => e.project !== project) }),
    }),
    {
      name: 'gia-project-memory',
      storage: createJSONStorage(() => idbStorage),
      partialize: (s) => ({ entries: s.entries }),
    },
  ),
);

// ── prompt injection ────────────────────────────────────────────────────

/** Cap on injected memory — enough to be useful, not enough to crowd out the conversation. */
export const MAX_MEMORY_CHARS = 5000;

const KIND_LABEL: Record<ProjectMemoryKind, string> = {
  decision: 'Decisions',
  gotcha: 'Gotchas',
  architecture: 'Architecture',
  convention: 'Conventions',
  todo: 'Parked work',
};

const KIND_HINT: Record<ProjectMemoryKind, string> = {
  decision: 'choices already made — do not silently re-litigate them',
  gotcha: 'things here that will bite you if you do not know',
  architecture: 'how the pieces fit together',
  convention: 'patterns this codebase follows',
  todo: 'deliberately unfinished — check before starting something similar',
};

/**
 * Render project memory for the system prompt.
 *
 * Grouped by kind because that is how the knowledge is actually used: when
 * about to change something, you need to know the gotcha, not the todo list.
 * Paths are included so an entry can be recalled when the agent touches that
 * file. Returns '' when there is nothing — an empty heading teaches nothing.
 */
export function renderMemoryForPrompt(entries: ProjectMemoryEntry[]): string {
  if (!entries.length) return '';

  const grouped = new Map<ProjectMemoryKind, ProjectMemoryEntry[]>();
  for (const e of entries) {
    if (!grouped.has(e.kind)) grouped.set(e.kind, []);
    grouped.get(e.kind)!.push(e);
  }

  const sections: string[] = [];
  let used = 0;

  // Gotchas first — they are the entries that prevent repeat mistakes.
  const order: ProjectMemoryKind[] = ['gotcha', 'decision', 'architecture', 'convention', 'todo'];
  for (const kind of order) {
    const list = grouped.get(kind);
    if (!list?.length) continue;

    const lines: string[] = [];
    for (const e of list) {
      if (used >= MAX_MEMORY_CHARS) break;
      const paths = e.paths.length ? ` _(${e.paths.slice(0, 3).join(', ')})_` : '';
      const line = `- **${e.title}**${paths}\n  ${e.body}`;
      if (used + line.length > MAX_MEMORY_CHARS) break;
      lines.push(line);
      used += line.length;
    }
    if (lines.length) {
      sections.push(`### ${KIND_LABEL[kind]}\n_${KIND_HINT[kind]}._\n${lines.join('\n')}`);
    }
  }

  if (!sections.length) return '';

  return [
    '## What I have learned about this project',
    '',
    '_My own notes from working in it. Treat these as established unless the user says otherwise._',
    '',
    sections.join('\n\n'),
    '',
    'Record something new with `project_memory` when you learn it — a decision you made and why, a trap you hit, or how a part of the system fits together. That is what makes the next session better than this one.',
  ].join('\n');
}