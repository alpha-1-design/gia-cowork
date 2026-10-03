import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { idbStorage } from './idb-storage';

/**
 * The project's AGENTS.md, cached for prompt injection.
 *
 * `/init` writes the file; this is how it gets *used*. Without it, `/init`
 * would produce a document nothing reads — which is the same as not having
 * run it at all.
 *
 * Kept deliberately small: a path, the markdown, and when it was written.
 * The markdown is truncated before injection (see `getInjectedContext`) because
 * a 40k-character AGENTS.md would crowd out the conversation.
 */

export interface ProjectContextEntry {
  /** Absolute path of the context file. */
  path: string;
  /** Project name, for the prompt header. */
  projectName: string;
  /** The document contents. */
  markdown: string;
  /** Epoch ms the file was written. */
  updatedAt: number;
}

interface ProjectContextState {
  entry: ProjectContextEntry | null;
  setEntry: (entry: ProjectContextEntry) => void;
  clear: () => void;
}

/** Cap on injected characters — the context file informs, it does not dominate. */
export const MAX_INJECTED_CHARS = 6000;

/**
 * The context block for the system prompt, or '' when there is nothing useful.
 *
 * Trailing sections are dropped rather than hard-truncated, because a
 * convention list cut mid-sentence is worse than one fewer convention.
 */
export function getInjectedContext(entry: ProjectContextEntry | null): string {
  if (!entry || !entry.markdown.trim()) return '';
  let body = entry.markdown.trim();
  if (body.length > MAX_INJECTED_CHARS) {
    const cut = body.slice(0, MAX_INJECTED_CHARS);
    // Back up to the last complete line so we never inject half a sentence.
    const lastBreak = cut.lastIndexOf('\n');
    body = (lastBreak > MAX_INJECTED_CHARS * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd();
    body += `\n\n_[truncated — run \`cat ${entry.path}\` for the full file]_`;
  }
  return [
    `## The project we are working in (${entry.projectName})`,
    '',
    'This project has been initialised. Read this before proposing changes — it records how the project builds, tests, and what conventions it follows. It is a summary, not a substitute for reading the actual files.',
    '',
    body,
  ].join('\n');
}

export const useProjectContextStore = create<ProjectContextState>()(
  persist(
    (set) => ({
      entry: null,
      setEntry: (entry) => set({ entry }),
      clear: () => set({ entry: null }),
    }),
    {
      name: 'gia-project-context',
      storage: createJSONStorage(() => idbStorage),
      partialize: (s) => ({ entry: s.entry }),
    },
  ),
);