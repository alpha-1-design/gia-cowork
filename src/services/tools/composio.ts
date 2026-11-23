import { z } from 'zod';
import { defineTool } from './defineTool';
import composioService from '../composio/ComposioService';
import type { Tool } from './types';

/**
 * Composio tools — the OAuth connector rail.
 *
 * Two tools, deliberately small: GIA's registry is deferred-mode and the
 * permission gate is the authority, so the agent discovers connected-app
 * actions by use case and executes them by slug, exactly as Composio's
 * harness-integration pattern prescribes. Actions are never pre-registered
 * per app (that would be hundreds of schemas); the search meta call keeps
 * the context cost flat no matter how many apps are connected.
 *
 * Gating: both tools ride toolRunner's normal gateToolCall path.
 * `composio_search` is a read (network); `composio_execute` is execution —
 * posting to Slack or creating a GitHub issue asks the user first, like
 * every other GIA tool. Composio holds the OAuth tokens; the tool result
 * is data, never a credential.
 */

export const composioSearch = defineTool({
  id: 'composio_search',
  name: 'composio_search',
  description:
    'Search the user\'s connected apps (via Composio) for concrete actions by use case. ' +
    'Call this before composio_execute when you need to find the right tool slug, e.g. "send a Slack message", "create a GitHub issue". ' +
    'Returns action slugs, descriptions and parameter schemas.',
  category: 'connectors',
  input: z.object({
    use_case: z.string().min(1).describe('What the user wants done, in plain language, e.g. "post a message to a Slack channel"'),
    limit: z.number().int().min(1).max(10).optional().describe('Max results (default 5)'),
  }),
  execute: async ({ use_case, limit }) => {
    try {
      const hits = await composioService.searchTools(use_case, limit ?? 5);
      if (hits.length === 0) {
        return { success: true, content: `No Composio actions found for "${use_case}". The app may not be connected yet — the user can connect it in Settings → Connections.` };
      }
      const lines = hits.map(h =>
        `- ${h.slug}${h.toolkit ? ` (${h.toolkit})` : ''}\n  ${h.description ?? '(no description)'}`,
      );
      return {
        success: true,
        content: `Found ${hits.length} Composio action${hits.length === 1 ? '' : 's'} for "${use_case}":\n\n${lines.join('\n')}\n\nExecute with composio_execute using the slug and the schema's required arguments.`,
      };
    } catch (e) {
      return { success: false, content: '', error: e instanceof Error ? e.message : 'Composio search failed' };
    }
  },
});

export const composioExecute = defineTool({
  id: 'composio_execute',
  name: 'composio_execute',
  description:
    'Execute a connected-app action (via Composio) as the user\'s connected account, e.g. GITHUB_CREATE_AN_ISSUE or SLACK_SEND_DM_MESSAGE. ' +
    'Use composio_search first to find the slug and required arguments. Acts on the user\'s external apps — the permission prompt covers it.',
  category: 'connectors',
  input: z.object({
    tool_slug: z.string().min(1).describe('Composio tool slug, e.g. GITHUB_CREATE_AN_ISSUE (uppercase, underscore-separated)'),
    arguments: z.record(z.string(), z.unknown()).optional().describe('Arguments matching the action\'s input schema'),
  }),
  execute: async ({ tool_slug, arguments: args }, context) => {
    try {
      const res = await composioService.executeTool(tool_slug, args ?? {});
      if (!res.ok) {
        return { success: false, content: '', error: res.error ?? `Composio action ${tool_slug} failed` };
      }
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
      return {
        success: true,
        content: text.length > 8000 ? `${text.slice(0, 8000)}\n…(truncated; log id: ${res.logId ?? 'n/a'})` : text,
      };
    } catch (e) {
      if (context?.signal?.aborted) return { success: false, content: '', error: 'Cancelled' };
      return { success: false, content: '', error: e instanceof Error ? e.message : `Composio action ${tool_slug} failed` };
    }
  },
});

export const composioTools: Tool[] = [composioSearch, composioExecute];
