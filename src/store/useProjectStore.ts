import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { idbStorage } from './idb-storage';
import type { ProjectRecord } from '../services/projects/projectIsolation';

/**
 * The registry of projects GIA has worked in.
 *
 * This exists because the project-isolation feature was written against
 * `sharedData.projects`, and `sharedData` is deliberately *not* persisted — it is
 * per-run scratch space. So the list of "other projects" was empty on every
 * fresh launch, the boundary block could never fire, and the ingress gate had
 * nothing to enforce against. The registry has to be its own persisted store,
 * or "welcome back" has no memory of what it is welcoming you back to.
 *
 * The active id is mirrored into `projectIsolation` so the prompt builder can
 * read it synchronously; this store is the source of truth.
 */

/** How many projects to remember. Beyond this the list is noise, not context. */
export const MAX_KNOWN_PROJECTS = 25;

interface ProjectState {
  projects: ProjectRecord[];
  activeProjectId: string | null;
  /** Insert or refresh a project by id. Returns the stored record. */
  upsert: (record: ProjectRecord) => ProjectRecord;
  setActive: (id: string | null) => void;
  patch: (id: string, patch: Partial<ProjectRecord>) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: [],
      activeProjectId: null,

      upsert: (record) => {
        const existing = get().projects.find((p) => p.id === record.id);
        if (existing) {
          // Preserve restriction and first-seen; refresh the moving parts.
          const merged: ProjectRecord = { ...existing, ...record };
          set((s) => ({ projects: s.projects.map((p) => (p.id === merged.id ? merged : p)) }));
          return merged;
        }
        // Newest first, capped — the prompt lists the others by name, and a
        // 40-project list would crowd out the conversation it belongs in.
        const next = [record, ...get().projects].slice(0, MAX_KNOWN_PROJECTS);
        set({ projects: next });
        return record;
      },

      setActive: (id) => set({ activeProjectId: id }),

      patch: (id, patch) =>
        set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),

      remove: (id) =>
        set((s) => ({
          projects: s.projects.filter((p) => p.id !== id),
          activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
        })),

      clear: () => set({ projects: [], activeProjectId: null }),
    }),
    {
      name: 'gia-projects',
      version: 1,
      storage: createJSONStorage(() => idbStorage),
      partialize: (s) => ({ projects: s.projects, activeProjectId: s.activeProjectId }),
    },
  ),
);

/** Non-hook read, for prompt building and the ingress gate. */
export function knownProjects(): ProjectRecord[] {
  return useProjectStore.getState().projects;
}