import { z } from 'zod';
import { defineTool } from './defineTool';
import { queryProvenance } from '../brain/provenance';
import { logger } from '../../utils/logger';

/**
 * TESTIMONY tools (W13) — the past becomes evidence.
 *
 * `provenance` is deliberately read-only and deliberately ordinary: it flows
 * the normal gate path (a pure read rates 'none' and never prompts, but it
 * IS audited like every other tool), it returns quoted, envelope-wrapped
 * data, and it never writes anything. The record has no write path; precedent
 * is not permission.
 */
export const testimonyTools = [
  defineTool({
    id: 'provenance',
    name: 'provenance',
    category: 'Code & Dev',
    description:
      'Search GIA\'s own hash-chained session record (the rollouts) for evidence of what actually happened in past sessions: tool calls, their outputs, claims made and whether they failed. Use it whenever a claim about your own past needs checking ("did that test pass last week?", "what did I write to this config?", "has this tool been failing?") instead of answering from memory. Returns citations with file, line number and hash-verification status. Memory that cannot be cited is "memory, not record" — say so.',
    input: z.object({
      query: z.string().min(2).max(200)
        .describe('Case-insensitive text to find in the record: a tool name, a file path, a phrase from a past claim. Example: "filesystem_write config.json".'),
      sessionId: z.string().max(128).optional()
        .describe('Restrict the search to one session\'s rollout.'),
      limit: z.number().int().min(1).max(50).optional()
        .describe('Max citations to return (default 12).'),
    }),
    execute: async ({ query, sessionId, limit }) => {
      try {
        const result = await queryProvenance({ query, sessionId, limit });
        return { success: true, content: result.enveloped };
      } catch (e) {
        logger.error('[provenance] query failed:', e);
        return { success: false, content: '', error: 'The record could not be searched (it may not exist yet). Nothing was written or changed.' };
      }
    },
  }),
];
