import { z } from 'zod';
import ToolRegistry from '../ToolRegistry';
import { categorizeTool } from '../../utils/toolCategories';
import { defineTool } from './defineTool';
import type { Tool } from './types';

/**
 * Deferred tool loading (W3, R1 #6).
 *
 * The registry has grown past 290 tools. Advertising every one of them with a
 * full JSON schema on every request costs prompt tokens and dilutes the
 * model's attention — the same failure mode the skills block already guards
 * against — and most conversations touch a handful of tools at most.
 *
 * The shape is the one the harness research (R1) described: a small always-on
 * core (filesystem, terminal, web, memory, tasks, messaging, clarification)
 * plus a single `tool_search` tool. When the registry exceeds
 * DEFERRED_THRESHOLD tools, the schema builders advertise only the core, and
 * the compact index (id + one-line description + category) is emitted as a
 * system-prompt block. The model finds a non-core tool with `tool_search`,
 * gets its full schema back as the tool's output, and can then call it by id
 * like any core tool — no re-registration needed, because the tool loop
 * resolves ids against the live registry (toolRunner → GiaTools.getTool) and
 * validates against the FULL schema map, not the advertised subset.
 *
 * Everything here is synchronous and pure over the registry singleton, so the
 * builders stay cheap enough to run per request.
 */

/** Tools that are always fully advertised, in deferred mode or not. */
export const CORE_TOOL_IDS: ReadonlySet<string> = new Set([
  // Filesystem
  'filesystem_read',
  'filesystem_write',
  'list_files',
  // Terminal / execution
  'terminal_run',
  // Web
  'web_search',
  'read_url',
  // Memory (the registry's actual memory ids — there is no bare "memory_list" tool)
  'save_memory',
  'forget_memory',
  // Tasks
  'task_create',
  'task_read',
  'task_update',
  'task_delete',
  'task_move',
  // Messaging + user interaction
  'messaging_send',
  'request_clarification',
  // The searcher itself — always available so deferred mode is escapable.
  'tool_search',
]);

/**
 * Above this registered-tool count the builders switch to compact-index mode.
 * 64 is comfortably above the core set plus the handful of tools the hand-
 * written prompt table covers, and far below the ~290 the registry actually
 * holds — so the mode engages exactly when the schema payload is the problem.
 */
export const DEFERRED_THRESHOLD = 64;

/** One-line description budget for the compact index (why-commented at use). */
const INDEX_DESCRIPTION_MAX = 100;

/** Cap on how many full schemas one tool_search call returns. Unbounded would recreate the payload problem one query at a time. */
const SEARCH_RESULT_LIMIT = 12;

/** Collapse whitespace and clamp so an index row stays one row. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > INDEX_DESCRIPTION_MAX ? `${flat.slice(0, INDEX_DESCRIPTION_MAX - 1)}…` : flat;
}

export interface CompactToolIndexEntry {
  id: string;
  description: string;
  category: string;
}

/**
 * The compact index: every registered tool as one row, from the tool's own
 * description field (never a hand-maintained copy — that is how the
 * description regression locked shut in toolDescriptions.test.ts happened).
 * Categories come from utils/toolCategories.ts, the single classifier the
 * command palette already uses, so the index groups the way the UI does.
 */
export function buildCompactToolIndex(): CompactToolIndexEntry[] {
  return ToolRegistry.getAll().map((tool) => ({
    id: tool.id,
    description: oneLine(tool.description ?? ''),
    category: categorizeTool(tool.id).category,
  }));
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Relevance search over id / description / category tokens. Returns FULL tool
 * objects — the caller (the tool_search tool) hands their schemas straight to
 * the model, which is what makes a deferred tool callable in the same turn.
 * Id matches weigh heaviest (a name is the strongest signal), category next,
 * description last; ties break alphabetically so results are deterministic.
 */
export function searchToolSchemas(query: string): Tool[] {
  // Deduped: a repeated token must not multiply its weight. "run a SQL query
  // against a database" contains "a" twice, and with the old per-occurrence
  // substring scoring that alone gave +6 to every id containing the letter
  // "a" (296 of them) — db_query, whose id has no "a" at all, ranked 45th of
  // 296 hits and fell off the result page entirely.
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return [];
  const scored = ToolRegistry.getAll()
    .map((tool) => {
      const category = categorizeTool(tool.id).category.toLowerCase();
      // Word-boundary matching over id/category/description words. Substring
      // matching let short tokens hit inside larger words — "a" matched
      // "neura", "database" matched nothing extra but "run" hit "neura_query"'s
      // tail — drowning real matches in stopword noise. A whole-word hit
      // scores the field's full weight; a prefix hit ("term" → "terminal")
      // still counts at the field's minimum so recall doesn't collapse.
      const idWords = tokenize(tool.id);
      const categoryWords = tokenize(category);
      const descriptionWords = tokenize(tool.description ?? '');
      let score = 0;
      for (const token of tokens) {
        if (idWords.includes(token)) score += 3;
        else if (idWords.some(w => w.startsWith(token) || token.startsWith(w))) score += 1;
        if (categoryWords.includes(token)) score += 2;
        else if (categoryWords.some(w => w.startsWith(token) || token.startsWith(w))) score += 1;
        if (descriptionWords.includes(token)) score += 1;
      }
      return { tool, score };
    })
    .filter((entry) => entry.score > 0);
  scored.sort((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id));
  return scored.slice(0, SEARCH_RESULT_LIMIT).map((entry) => entry.tool);
}

/**
 * Deferred mode is a property of the registry's live size, not a setting the
 * model or UI flips: small installs keep today's behaviour exactly, large
 * ones switch to the compact index. `forceFull` lets the orchestrator request
 * the complete payload where a caller needs it (e.g. schema-only flows).
 */
export function isDeferredModeActive(forceFull = false): boolean {
  return !forceFull && ToolRegistry.getAll().length > DEFERRED_THRESHOLD;
}

/**
 * Filter a full schema record down to the core set for deferred mode. The
 * builders pass their merged record through this; in non-deferred mode the
 * record is returned untouched, keeping that path byte-identical.
 */
export function applyDeferredMode<T>(
  record: Record<string, T>,
  forceFull = false,
): Record<string, T> {
  if (!isDeferredModeActive(forceFull)) return record;
  const filtered: Record<string, T> = {};
  for (const id of CORE_TOOL_IDS) {
    if (record[id]) filtered[id] = record[id];
  }
  // The searcher must survive even if it somehow missed registration —
  // without it, deferred mode is a trap with no way out.
  if (!filtered['tool_search'] && toolSearchTool.schema) {
    (filtered as Record<string, unknown>)['tool_search'] = {
      description: toolSearchTool.description,
      required: toolSearchTool.schema.required ?? [],
      properties: toolSearchTool.schema.properties,
    };
  }
  return filtered;
}

const toolSearchTool = defineTool({
  id: 'tool_search',
  name: 'tool_search',
  description:
    'Search the full tool catalog when a tool you need is not listed. Pass a natural-language query describing what you want to do; returns the FULL schemas of matching tools so you can call them by id immediately.',
  category: 'System & Device',
  input: z.object({
    query: z
      .string()
      .describe('What you want to do, e.g. "send a message to a channel", "run a SQL query", "scan network ports"'),
  }),
  execute: ({ query }) => {
    const tools = searchToolSchemas(query);
    if (tools.length === 0) {
      return { success: true, content: 'No tools match that query. Try broader terms.' };
    }
    // Full objects (id, name, description, JSON schema) — the model needs the
    // argument schema to make a valid call, which is the entire point.
    return {
      success: true,
      content: JSON.stringify(
        tools.map((t) => ({ id: t.id, name: t.name, description: t.description, schema: t.schema ?? null })),
        null,
        2,
      ),
    };
  },
});

/** Registration surface for tools/index.ts — one entry in registerAllTools(). */
export const deferredTools: Tool[] = [toolSearchTool];

/**
 * The system-prompt block that pairs with deferred mode: explains the compact
 * index, shows how to call tool_search, and lists the index itself. Wired
 * alongside the schema builders so the prompt and the advertised tool list
 * never disagree about which tools carry full schemas.
 */
export function deferredToolsPromptBlock(): string {
  const index = buildCompactToolIndex();
  const rows = index.map((e) => `| \`${e.id}\` | ${e.description} | ${e.category} |`).join('\n');
  // Count what the model actually cares about — the tools BEYOND the core
  // set. Counting all registered tools made the core sound doubly advertised
  // and the "other N tools" number wrong (V2 clarity audit, (c)-1).
  // S4-31: count the core tools that are ACTUALLY advertised (core ∩ record),
  // not the constant — a core id with no live record would otherwise inflate
  // this number and drift silently.
  const advertisedCore = index.filter((e) => CORE_TOOL_IDS.has(e.id)).length;
  const beyondCore = index.length - advertisedCore;
  return `## Deferred tool catalog
This conversation advertises full schemas for the ${advertisedCore} CORE TOOLS only. The remaining ${beyondCore} tools — of ${index.length} registered in total, every one of them in the compact index below — are discoverable on demand: call \`tool_search\` with a natural-language query and it returns the matching tools' full schemas, after which you call them by id exactly like a core tool.

On providers with native tool calling, the core tools are callable as functions; every tool you find through tool_search is invoked ONLY through a \`\`\`tool fenced block — never as a native function call.

Read the schema tool_search returns BEFORE calling an unfamiliar tool id: the index below says what each tool is for, not its arguments — do not guess argument names from the id.

\`\`\`tool
{ "id": "tool_search", "args": { "query": "what you want to do" } }
\`\`\`

Compact index of every available tool:

| Tool | What it does | Category |
|---|---|---|
${rows}`;
}
