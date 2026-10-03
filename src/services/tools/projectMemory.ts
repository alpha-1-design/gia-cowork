import { z } from 'zod';
import { defineTool } from './defineTool';
import { useProjectMemoryStore, type ProjectMemoryKind } from '../ProjectMemory';
import { useProjectContextStore } from '../../store/useProjectContextStore';
import { logger } from '../../utils/logger';

/**
 * Project-memory tools.
 *
 * This is the difference between an agent that works in a codebase once and
 * one that gets better at it. `/init` captures what a project *is*; these
 * capture what *happened* — the decision and its reason, the trap that cost an
 * hour, the approach that was tried and did not work.
 *
 * None of that is recoverable by re-reading the code, which is precisely why
 * it has to be written down at the moment it is learned. Everything recorded
 * here is injected into the system prompt on later turns.
 */

const KIND_HINT = 'decision (a choice and why) | gotcha (a trap) | architecture (how it fits together) | convention (a pattern) | todo (parked work)';

export const projectMemoryTools = [
  defineTool({
    id: 'project_memory',
    name: 'project_memory',
    category: 'Code & Dev',
    description:
      'Record something you learned about the current project so future sessions know it too. Use it for: a decision you made AND the reason (so nobody silently reverses it six weeks later), a gotcha that cost you time, how a subsystem fits together, or work you deliberately parked. Do NOT use it for things the code already states plainly — a note restating the code is noise. Re-using the same kind+title updates the entry instead of duplicating it.',
    input: z.object({
      kind: z.enum(['decision', 'gotcha', 'architecture', 'convention', 'todo'])
        .describe(KIND_HINT),
      title: z.string().min(3).max(120).describe('Short, specific label. "Auth tokens expire at 1h, refresh is silent" beats "Auth notes".'),
      body: z.string().min(10).max(2000)
        .describe('The detail: what happened, and WHY. The reason is the part that cannot be re-derived from the code.'),
      project: z.string().optional().describe('Project name. Defaults to the active one.'),
      paths: z.array(z.string()).optional()
        .describe('File paths this is about, so it is recalled when you touch them.'),
    }),
    execute: ({ kind, title, body, project, paths }) => {
      const name = (project || '').trim() || activeProjectName();
      const entry = useProjectMemoryStore.getState().add({
        project: name,
        kind: kind as ProjectMemoryKind,
        title: title.trim(),
        body: body.trim(),
        paths: (paths || []).map(p => p.trim()).filter(Boolean).slice(0, 8),
      });
      logger.log(`[project_memory] ${entry.kind} "${entry.title}" on ${name}`);
      return {
        success: true,
        content: `📓 Noted on **${name}**: _${kind}_ — **${entry.title}**\n\nI'll carry this into future sessions and bring it up when relevant.`,
      };
    },
  }),

  defineTool({
    id: 'project_memory_list',
    name: 'project_memory_list',
    category: 'Code & Dev',
    description:
      'List what you have recorded about a project — decisions, gotchas, architecture notes, conventions, parked work. Use this to recall context you wrote earlier rather than re-deriving it.',
    input: z.object({
      project: z.string().optional().describe('Project name. Defaults to the active one.'),
      kind: z.enum(['decision', 'gotcha', 'architecture', 'convention', 'todo']).optional(),
      query: z.string().optional().describe('Free-text filter over title, body, and paths.'),
    }),
    execute: ({ project, kind, query }) => {
      const name = (project || '').trim() || activeProjectName();
      let list = useProjectMemoryStore.getState().list(name);
      if (kind) list = list.filter(e => e.kind === kind);
      if (query) {
        const q = query.toLowerCase();
        list = list.filter(e =>
          e.title.toLowerCase().includes(q) ||
          e.body.toLowerCase().includes(q) ||
          e.paths.some(p => p.toLowerCase().includes(q)),
        );
      }
      if (!list.length) {
        return {
          success: true,
          content: `No ${kind ? `${kind} ` : ''}notes recorded for **${name}**${query ? ` matching "${query}"` : ''} yet.`,
        };
      }
      const lines = list.slice(0, 40).map(e =>
        `- **${e.title}** _(${e.kind}${e.paths.length ? ` · ${e.paths.slice(0, 2).join(', ')}` : ''})_\n  ${e.body}`,
      );
      return {
        success: true,
        content: `## Project notes — ${name} (${list.length})\n\n${lines.join('\n\n')}`,
      };
    },
  }),

  defineTool({
    id: 'project_memory_forget',
    name: 'project_memory_forget',
    category: 'Code & Dev',
    description:
      'Delete a note you recorded about a project. Use when a note turned out to be wrong or no longer true — a stale note is worse than none, because it will be recalled as fact.',
    input: z.object({
      title: z.string().describe('Title of the note to remove.'),
      project: z.string().optional(),
    }),
    execute: ({ title, project }) => {
      const name = (project || '').trim() || activeProjectName();
      const all = useProjectMemoryStore.getState().list(name);
      const match = all.find(e => e.title.toLowerCase() === title.trim().toLowerCase())
        || all.find(e => e.title.toLowerCase().includes(title.trim().toLowerCase()));
      if (!match) {
        return { success: false, content: '', error: `No note matching "${title}" on ${name}. Use project_memory_list to see them.` };
      }
      useProjectMemoryStore.getState().remove(match.id);
      return { success: true, content: `🗑️ Removed **${match.title}** from ${name}.` };
    },
  }),
];

/**
 * Which project these notes belong to.
 *
 * Prefers the project `/init` recorded, then a stable placeholder. Keyed by
 * project so notes from different codebases never bleed together — a gotcha
 * from one repo silently applied to another is worse than no memory at all.
 */
function activeProjectName(): string {
  return useProjectContextStore.getState().entry?.projectName || 'current';
}