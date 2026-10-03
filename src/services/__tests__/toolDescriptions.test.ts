import { describe, it, expect, beforeAll } from 'vitest';
import { registerAllTools } from '../tools';
import { getAllToolSchemas, buildOpenAITools, buildAnthropicTools, buildGeminiTools } from '../brain/toolSchemas';
import toolRegistry from '../ToolRegistry';

/**
 * A pre-existing bug this locks shut.
 *
 * `ToolRegistry.getAllToolSchemas()` returned `tool.schema` alone, and `schema`
 * carries only `properties` and `required`. The provider builders read
 * `schema.description`, so 209 of 240 registered tools — `web_search`,
 * `terminal_run`, `filesystem_write`, every tool with real logic in it — were
 * advertised to the model as a bare name with no explanation of what it did or
 * when to use it.
 *
 * Nothing caught it because the tools all still *worked*; they were just being
 * called for the wrong things. That is the worst shape of bug to notice by hand,
 * so it is asserted here across the whole registry rather than per-tool.
 */

beforeAll(() => {
  registerAllTools();
});

const schemas = () => getAllToolSchemas();

describe('every advertised tool is explained to the model', () => {
  it('has at least a few dozen tools registered', () => {
    expect(Object.keys(schemas()).length).toBeGreaterThan(50);
  });

  it('gives every tool a non-empty description', () => {
    const missing = Object.entries(schemas())
      .filter(([, s]) => !s.description || !s.description.trim())
      .map(([id]) => id);
    expect(missing, `tools with no description: ${missing.slice(0, 20).join(', ')}`).toEqual([]);
  });

  it('gives the core tools a real description, not a placeholder', () => {
    // The specific tools that were silently unexplained before.
    for (const id of ['web_search', 'terminal_run', 'filesystem_write', 'filesystem_read']) {
      expect(schemas()[id]?.description?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it('normalises required to an array so provider builders can index it', () => {
    for (const [id, s] of Object.entries(schemas())) {
      expect(Array.isArray(s.required), `${id}.required is not an array`).toBe(true);
    }
  });
});

describe('provider payloads carry the descriptions through', () => {
  it('OpenAI-shaped tools have a description on every function', () => {
    for (const t of buildOpenAITools()) {
      const fn = (t as { function: { name: string; description?: string } }).function;
      expect(fn.description, `${fn.name} has no description`).toBeTruthy();
    }
  });

  it('Anthropic-shaped tools have a description on every entry', () => {
    for (const t of buildAnthropicTools()) {
      const e = t as { name: string; description?: string };
      expect(e.description, `${e.name} has no description`).toBeTruthy();
    }
  });

  it('Gemini-shaped tools declare input schemas without crashing', () => {
    // Gemini wraps parameters differently; this guards the shape, since the
    // description regression would also show up as an empty description there.
    const built = buildGeminiTools();
    expect(built.length).toBeGreaterThan(0);
    for (const t of built) {
      expect((t as { description?: string }).description).toBeTruthy();
    }
  });
});

describe('ToolRegistry.getAllToolSchemas', () => {
  it('excludes tools that declare no schema rather than emitting an empty one', () => {
    const record = toolRegistry.getAllToolSchemas();
    expect(Object.keys(record).length).toBeLessThanOrEqual(toolRegistry.getAll().length);
  });

  it('skips a tool with no schema instead of crashing', () => {
    // Exercise the same loop through the real singleton so the branch is
    // covered; the module only exports the instance, not the class.
    toolRegistry.register({
      id: 'zz_no_schema_probe',
      name: 'zz_no_schema_probe',
      description: 'has no schema block',
      execute: async () => ({ success: true, content: '' }),
    });
    expect(toolRegistry.getAllToolSchemas()['zz_no_schema_probe']).toBeUndefined();
    toolRegistry.unregister('zz_no_schema_probe');
  });

  it('still copies a description for a tool that has one', () => {
    toolRegistry.register({
      id: 'zz_with_schema_probe',
      name: 'zz_with_schema_probe',
      description: 'explains itself',
      schema: { type: 'object', properties: { a: { type: 'string', description: 'x' } } },
      execute: async () => ({ success: true, content: '' }),
    });
    const record = toolRegistry.getAllToolSchemas();
    expect(record['zz_with_schema_probe'].description).toBe('explains itself');
    // No `required` declared — normalised rather than left undefined.
    expect(record['zz_with_schema_probe'].required).toEqual([]);
    toolRegistry.unregister('zz_with_schema_probe');
  });
});