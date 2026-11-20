import { describe, it, expect, beforeAll } from 'vitest';
import { registerAllTools } from '../tools';
import toolRegistry from '../ToolRegistry';
import { buildOpenAITools, buildAnthropicTools, buildGeminiTools, getAllToolSchemas } from '../brain/toolSchemas';
import {
  CORE_TOOL_IDS,
  DEFERRED_THRESHOLD,
  applyDeferredMode,
  buildCompactToolIndex,
  deferredToolsPromptBlock,
  isDeferredModeActive,
  searchToolSchemas,
} from '../tools/deferred';

/**
 * Deferred tool loading (W3, R1 #6).
 *
 * The failure shape this guards is the same one peerAgentTools.test.ts guards
 * for delegation: a tool can be registered and still never reach the model.
 * Deferred mode makes that failure mode WORSE if it drifts, because the
 * builders now intentionally hide everything outside the core set — so if the
 * index ever misses a registry id, that tool becomes unreachable with no
 * error anywhere. The index-completeness test below is the load-bearing one.
 */

beforeAll(() => {
  registerAllTools();
});

const fullSchemaIds = () => Object.keys(getAllToolSchemas());
const openAINames = (forceFull?: boolean) =>
  buildOpenAITools(forceFull).map((t) => (t as { function: { name: string } }).function.name);

describe('compact index', () => {
  it('covers every registered id — no orphans in either direction', () => {
    const indexIds = buildCompactToolIndex().map((e) => e.id);
    const registryIds = toolRegistry.getAll().map((t) => t.id);
    const indexSet = new Set(indexIds);
    // Forward: every registry tool appears in the index (else it is invisible
    // to tool_search forever).
    for (const id of registryIds) {
      expect(indexSet.has(id), `${id} missing from the compact index`).toBe(true);
    }
    // Backward: the index never lists a tool that is not registered.
    expect(indexIds.length).toBe(registryIds.length);
  });

  it('keeps every row one line and within the ~100-char budget', () => {
    for (const entry of buildCompactToolIndex()) {
      expect(entry.description).not.toMatch(/\r|\n/);
      expect(entry.description.length).toBeLessThanOrEqual(100);
    }
  });

  it('classifies every entry through the shared taxonomy', () => {
    for (const entry of buildCompactToolIndex()) {
      expect(entry.category).toBeTruthy();
    }
  });
});

describe('tool_search relevance', () => {
  it('finds the messaging tool for a natural-language query', () => {
    const hits = searchToolSchemas('send a message to a telegram channel');
    const ids = hits.map((t) => t.id);
    expect(ids).toContain('messaging_send');
  });

  it('finds the database tool for a SQL query', () => {
    const hits = searchToolSchemas('run a SQL query against a database');
    const ids = hits.map((t) => t.id);
    expect(ids).toContain('db_query');
  });

  it('returns full tool objects — schema and executable', () => {
    const [hit] = searchToolSchemas('web search');
    expect(hit).toBeTruthy();
    expect(hit!.id).toBe('web_search');
    // "Full schemas" means the model can form a valid call from the result.
    expect(hit!.schema).toBeTruthy();
    expect(hit!.schema!.properties.query).toBeTruthy();
    expect(typeof hit!.execute).toBe('function');
  });

  it('ranks an exact id match first', () => {
    const hits = searchToolSchemas('neura_query');
    expect(hits[0]?.id).toBe('neura_query');
  });

  it('caps the result set instead of recreating the payload problem', () => {
    // A query this broad matches dozens of tools.
    const hits = searchToolSchemas('the a');
    expect(hits.length).toBeLessThanOrEqual(12);
  });

  it('returns nothing for a query with no tokens or no matches', () => {
    expect(searchToolSchemas('   ')).toEqual([]);
    expect(searchToolSchemas('zzzzqqqqxxxx')).toEqual([]);
  });
});

describe('deferred mode toggle', () => {
  it('engages above the threshold with the real registry', () => {
    expect(toolRegistry.getAll().length).toBeGreaterThan(DEFERRED_THRESHOLD);
    expect(isDeferredModeActive()).toBe(true);
  });

  it('leaves the non-deferred path byte-identical to the full record', () => {
    // forceFull must be indistinguishable from the pre-deferred output.
    expect(openAINames(true)).toEqual(fullSchemaIds());
    expect(buildAnthropicTools(true).map((t) => (t as { name: string }).name)).toEqual(fullSchemaIds());
    expect(buildGeminiTools(true).map((t) => (t as { description?: string }).description))
      .toEqual(fullSchemaIds().map((id) => getAllToolSchemas()[id].description));
  });

  it('emits only core ids in deferred mode', () => {
    const names = openAINames();
    for (const id of names) {
      expect(CORE_TOOL_IDS.has(id), `${id} advertised but not core`).toBe(true);
    }
    // Sanity: a popular non-core tool is genuinely hidden now.
    expect(names).not.toContain('neura_query');
  });

  it('keeps every core id advertised in BOTH modes', () => {
    const full = new Set(fullSchemaIds());
    const deferred = new Set(openAINames());
    for (const id of CORE_TOOL_IDS) {
      expect(full.has(id), `core id ${id} missing from full payload`).toBe(true);
      expect(deferred.has(id), `core id ${id} missing from deferred payload`).toBe(true);
    }
  });

  it('drops below-threshold registries back to the full payload', () => {
    // Simulate a small install: empty the registry, then the mode must not
    // engage — a sparse registry pays no schema tax and must not lose tools.
    const snapshot = toolRegistry.getAll();
    try {
      for (const tool of snapshot) toolRegistry.unregister(tool.id);
      // tool_search comes back with the core set via applyDeferredMode's
      // fallback, but every other registered id must be present again.
      const record = applyDeferredMode(Object.fromEntries([
        // `as const` so the pair infers as a tuple for Object.fromEntries.
        ...snapshot.map((t) => [t.id, { description: t.description, required: [] as string[], properties: {} }] as const),
      ]) as unknown as Record<string, { description: string; required: string[]; properties: Record<string, unknown> }>);
      expect(isDeferredModeActive()).toBe(false);
      expect(Object.keys(record).length).toBe(snapshot.length);
    } finally {
      // Restore the shared singleton for the rest of the suite.
      for (const tool of snapshot) toolRegistry.register(tool);
    }
  });

  it('always re-advertises tool_search even if it missed registration', () => {
    // Deferred mode is escapable by construction: strip tool_search from the
    // registry and the filtered record must still carry it.
    const had = toolRegistry.get('tool_search');
    try {
      if (had) toolRegistry.unregister('tool_search');
      const record = applyDeferredMode(getAllToolSchemas()) as Record<string, unknown>;
      expect(record['tool_search']).toBeTruthy();
    } finally {
      if (had) toolRegistry.register(had);
    }
  });
});

describe('provider builders in deferred mode', () => {
  it('advertises tool_search as a real callable function (OpenAI shape)', () => {
    const fn = buildOpenAITools()
      .map((t) => (t as { function: { name: string; description?: string; parameters?: Record<string, unknown> } }).function)
      .find((f) => f.name === 'tool_search');
    expect(fn).toBeTruthy();
    expect(fn!.description).toBeTruthy();
    expect(fn!.parameters).toBeTruthy();
  });

  it('advertises tool_search in the Anthropic and Gemini shapes too', () => {
    const anthropicNames = buildAnthropicTools().map((t) => (t as { name: string }).name);
    expect(anthropicNames).toContain('tool_search');
    const geminiNames = buildGeminiTools().map((t) => (t as { name: string }).name);
    expect(geminiNames).toContain('tool_search');
  });
});

describe('tool_search execution', () => {
  it('returns full schemas as content the model can act on', async () => {
    const tool = toolRegistry.get('tool_search');
    expect(tool).toBeTruthy();
    const result = await tool!.execute({ query: 'ssh remote command' });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.content) as { id: string; schema: unknown }[];
    expect(parsed.some((t) => t.id === 'ssh_connect')).toBe(true);
    expect(parsed.find((t) => t.id === 'ssh_connect')!.schema).toBeTruthy();
  });
});

describe('system-prompt block', () => {
  it('explains tool_search and lists the whole index', () => {
    const block = deferredToolsPromptBlock();
    expect(block).toContain('tool_search');
    expect(block).toContain('```tool');
    for (const id of CORE_TOOL_IDS) {
      expect(block).toContain(`\`${id}\``);
    }
    expect(block.split('\n').length).toBeGreaterThan(CORE_TOOL_IDS.size);
  });
});
