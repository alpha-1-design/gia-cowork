import { z } from 'zod';
import { defineTool } from './defineTool';
import { scanProject, renderContextMarkdown, summarizeProfile, chooseContextFilename } from '../ProjectContext';
import { fileSnapshots } from '../FileSnapshots';
import terminalService from '../TerminalService';
import { logger } from '../../utils/logger';

/**
 * Write a file through the shell the scan reads from.
 *
 * A quoted heredoc is used so the shell does not expand backticks, $VAR, or
 * any of the code in the document — the markdown is full of them, and an
 * unquoted heredoc would silently corrupt every command example in it.
 */
async function writeFileViaShell(path: string, content: string): Promise<boolean> {
  // A delimiter that cannot occur in the document.
  let delimiter = 'GIA_EOF';
  while (content.includes(delimiter)) delimiter += '_X';
  const res = await terminalService.exec(
    `cat > ${JSON.stringify(path)} <<'${delimiter}'\n${content}\n${delimiter}`,
    undefined,
    undefined,
    20000,
  );
  return res?.exitCode === 0;
}

/**
 * Project-context tools.
 *
 * GIA drives a real machine but starts every conversation knowing nothing
 * about the code in front of her. These let her read a project's shape — its
 * stack, commands, and conventions — on demand, and leave that knowledge
 * behind as an `AGENTS.md` so the next session starts informed.
 */
export const projectContextTools = [
  defineTool({
    id: 'scan_project',
    name: 'scan_project',
    category: 'Code & Dev',
    description:
      'Analyse the project in a directory: languages, frameworks, package manager, build/test/lint commands, entry points, and the conventions a newcomer would have to infer. Call this BEFORE proposing changes to unfamiliar code — it tells you how the project builds and tests instead of you guessing. Read-only; changes nothing on disk.',
    input: z.object({
      path: z.string().optional().describe('Directory to scan. Defaults to the current working directory.'),
    }),
    execute: async ({ path }) => {
      try {
        const profile = await scanProject(path);
        if (profile.languages.length === 0 && profile.manifests.length === 0) {
          return {
            success: false,
            content: '',
            error: `No recognisable project found in ${profile.root}. Expected a manifest (package.json, Cargo.toml, go.mod, pyproject.toml…) or some source files.`,
          };
        }
        return {
          success: true,
          content: [
            summarizeProfile(profile),
            '',
            '## Commands',
            profile.runCommand ? `- run: ${profile.runCommand}` : null,
            profile.buildCommand ? `- build: ${profile.buildCommand}` : null,
            profile.testCommand ? `- test: ${profile.testCommand}` : null,
            profile.lintCommand ? `- lint: ${profile.lintCommand}` : null,
            '',
            '## Conventions',
            ...profile.conventions.map(c => `- ${c}`),
          ].filter(l => l !== null).join('\n'),
          structuredResult: profile as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('[scan_project] failed:', e);
        return { success: false, content: '', error: `Scan failed: ${msg}` };
      }
    },
  }),

  defineTool({
    id: 'write_project_context',
    name: 'write_project_context',
    category: 'Code & Dev',
    description:
      'Write an AGENTS.md for a project — what it is, how to build and test it, and its conventions — so future sessions start informed. Overwrites an existing context file (CLAUDE.md, .cursorrules) rather than adding a competing one.',
    input: z.object({
      path: z.string().optional().describe('Project directory. Defaults to the current working directory.'),
      filename: z.string().optional().describe('Override the output filename, e.g. AGENTS.md.'),
    }),
    execute: async ({ path, filename }) => {
      try {
        const profile = await scanProject(path);
        const target = filename || chooseContextFilename(profile.topLevel);
        const markdown = renderContextMarkdown(profile);
        const dir = (path || profile.root).replace(/\/+$/, '');

        // Snapshot first so the write is undoable, matching filesystem_write.
        const snap = await fileSnapshots.capture(`${dir}/${target}`, markdown, 'project_context');
        if (!snap) {
          // capture returns null when the file does not exist yet — there is
          // nothing to restore to, which is fine for a first run.
          logger.log('[write_project_context] no previous file to snapshot');
        }

        // Written through the same shell the scan reads, so the file lands in
        // the same filesystem view. DesktopFS would be a different root.
        const ok = await writeFileViaShell(`${dir}/${target}`, markdown);
        if (!ok) {
          return { success: false, content: '', error: `Wrote nothing — could not create ${target} in ${dir}. Check the path and permissions.` };
        }

        // Cache it so the system prompt carries it from the next turn on —
        // writing the file without this would leave GIA still working blind.
        const { useProjectContextStore } = await import('../../store/useProjectContextStore');
        useProjectContextStore.getState().setEntry({
          path: `${dir}/${target}`,
          projectName: profile.name,
          markdown,
          updatedAt: Date.now(),
        });

        return {
          success: true,
          content: [
            `📘 Wrote **${target}** (${markdown.length.toLocaleString()} chars) for **${profile.name}**.`,
            '',
            summarizeProfile(profile),
            snap ? '' : '_This file did not exist before, so there is nothing to undo._',
            '',
            "I'll carry this into every future conversation from now on.",
          ].filter(Boolean).join('\n'),
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('[write_project_context] failed:', e);
        return { success: false, content: '', error: `Could not write project context: ${msg}` };
      }
    },
  }),
];