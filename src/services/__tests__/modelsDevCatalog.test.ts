import { describe, it, expect } from 'vitest';
import {
  MODELS_DEV_URL,
  formatContext,
  isFreeModel,
  supportsVision,
  mapModelOption,
  mapProviderModels,
  requiredEnvVars,
  mergeProviderModels,
  type ModelsDevPayload,
  type ModelOption,
} from '../modelsDevCatalog';

/**
 * The app used to fetch `https://opencode.ai/api/providers`, which 404s, and
 * the failure was swallowed — so "opencode's provider list" never arrived.
 */
describe('endpoint', () => {
  it('points at models.dev, not the dead opencode path', () => {
    expect(MODELS_DEV_URL).toBe('https://models.dev/api.json');
    expect(MODELS_DEV_URL).not.toContain('opencode.ai/api/providers');
  });
});

describe('formatContext', () => {
  it('renders large windows in millions', () => {
    expect(formatContext(1_000_000)).toBe('1M');
    expect(formatContext(2_000_000)).toBe('2M');
    expect(formatContext(1_500_000)).toBe('1.5M');
  });

  it('renders ordinary windows in k', () => {
    expect(formatContext(131_072)).toBe('131k');
    expect(formatContext(128_000)).toBe('128k');
  });

  it('omits the field for absent or meaningless values', () => {
    expect(formatContext(undefined)).toBeUndefined();
    expect(formatContext(0)).toBeUndefined();
    expect(formatContext(-5)).toBeUndefined();
  });

  it('handles sub-threshold token counts', () => {
    expect(formatContext(512)).toBe('512');
  });
});

describe('isFreeModel', () => {
  it('is free only when both directions cost nothing', () => {
    expect(isFreeModel({ input: 0, output: 0 })).toBe(true);
    expect(isFreeModel({ input: 0, output: 15 })).toBe(false);
    expect(isFreeModel({ input: 3, output: 15 })).toBe(false);
  });

  it('treats a missing cost block as not free', () => {
    expect(isFreeModel(undefined)).toBe(false);
    expect(isFreeModel({})).toBe(false);
  });
});

describe('supportsVision', () => {
  it('accepts image and video inputs', () => {
    expect(supportsVision({ id: 'a', modalities: { input: ['text', 'image'] } })).toBe(true);
    expect(supportsVision({ id: 'b', modalities: { input: ['text', 'video'] } })).toBe(true);
  });

  it('rejects text-only and missing modalities', () => {
    expect(supportsVision({ id: 'c', modalities: { input: ['text'] } })).toBe(false);
    expect(supportsVision({ id: 'd' })).toBe(false);
  });
});

describe('mapModelOption', () => {
  it('maps fields the picker needs', () => {
    const out = mapModelOption({
      id: 'claude-sonnet-4-5',
      name: 'Claude Sonnet 4.5',
      limit: { context: 200_000 },
      cost: { input: 3, output: 15 },
      modalities: { input: ['text', 'image'] },
      tool_call: true,
    });

    expect(out).toEqual({
      id: 'claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5',
      free: false,
      context: '200k',
      tools: true,
      vision: true,
    });
  });

  it('falls back to the id when the name is unhelpful', () => {
    expect(mapModelOption({ id: 'glm-4.6', name: 'glm-4.6' }).label).toBe('glm-4.6');
    expect(mapModelOption({ id: 'glm-4.6' }).label).toBe('glm-4.6');
  });

  it('defaults tools/vision when the model omits them', () => {
    const out = mapModelOption({ id: 'x' });
    expect(out.tools).toBe(false);
    expect(out.vision).toBe(false);
  });
});

describe('mapProviderModels', () => {
  it('sorts by id so the picker order is stable', () => {
    const out = mapProviderModels({
      id: 'p',
      models: {
        zebra: { id: 'zebra' },
        alpha: { id: 'alpha' },
        mango: { id: 'mango' },
      },
    });
    expect(out.map(m => m.id)).toEqual(['alpha', 'mango', 'zebra']);
  });

  it('returns an empty list for a provider with no models', () => {
    expect(mapProviderModels({ id: 'empty' })).toEqual([]);
    expect(mapProviderModels({ id: 'empty', models: {} })).toEqual([]);
  });
});

describe('requiredEnvVars', () => {
  it('reads the array form', () => {
    expect(requiredEnvVars({ id: 'a', env: ['OPENAI_API_KEY'] })).toEqual(['OPENAI_API_KEY']);
  });

  it('reads the object form', () => {
    expect(requiredEnvVars({ id: 'a', env: { AZURE_RESOURCE_NAME: '', AZURE_API_KEY: '' } })).toEqual([
      'AZURE_RESOURCE_NAME',
      'AZURE_API_KEY',
    ]);
  });

  it('is empty when absent', () => {
    expect(requiredEnvVars({ id: 'a' })).toEqual([]);
  });
});

describe('mergeProviderModels', () => {
  const payload: ModelsDevPayload = {
    known: {
      id: 'known',
      models: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
    },
    unknown: {
      id: 'unknown',
      models: { a: { id: 'a' }, b: { id: 'b' } },
    },
    smaller: {
      id: 'smaller',
      models: { a: { id: 'a' } },
    },
  };

  it('enriches only providers we already ship', () => {
    const existing = new Map<string, ModelOption[]>([
      ['known', [{ id: 'a', label: 'a', free: false }]],
      ['smaller', [{ id: 'a', label: 'a', free: false }, { id: 'b', label: 'b', free: false }]],
    ]);

    const { updated, skipped } = mergeProviderModels(existing, payload);

    expect(updated).toEqual(['known']);
    expect(skipped).toContain('unknown');
    expect(existing.get('known')!.length).toBe(3);
  });

  it('never shrinks an existing catalog', () => {
    const existing = new Map<string, ModelOption[]>([
      ['smaller', [{ id: 'a', label: 'a', free: false }, { id: 'b', label: 'b', free: false }]],
    ]);

    const { updated } = mergeProviderModels(existing, payload);

    expect(updated).not.toContain('smaller');
    expect(existing.get('smaller')!.length).toBe(2);
  });

  it('fills a known provider that had no fallback catalog', () => {
    const existing = new Map<string, ModelOption[]>([['known', []]]);
    const { updated } = mergeProviderModels(existing, payload);

    expect(updated).toEqual(['known']);
    expect(existing.get('known')!.length).toBe(3);
  });

  it('is a no-op for an empty payload', () => {
    const existing = new Map<string, ModelOption[]>([['known', []]]);
    expect(mergeProviderModels(existing, {})).toEqual({ updated: [], skipped: [] });
    expect(existing.get('known')).toEqual([]);
  });
});

/**
 * Regression: if someone reintroduces the opencode endpoint this fails loudly
 * rather than silently reverting the app to 21 providers.
 */
describe('provider parity', () => {
  it('ships the six models.dev-verified providers added for parity', async () => {
    const { FALLBACK_PROVIDERS } = await import('../ProviderRegistry');
    const byId = new Map(FALLBACK_PROVIDERS.map(p => [p.id, p]));

    for (const id of ['zai', 'zhipuai', 'moonshotai', 'minimax', 'alibaba', 'siliconflow']) {
      const p = byId.get(id);
      expect(p, `provider ${id} should exist`).toBeDefined();
      expect(p!.baseUrl).toMatch(/^https:\/\//);
      expect(p!.defaultModel.length).toBeGreaterThan(0);
      expect(p!.label.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate provider ids or aliases', async () => {
    const { FALLBACK_PROVIDERS } = await import('../ProviderRegistry');
    const ids = FALLBACK_PROVIDERS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    const refs: string[] = [];
    for (const p of FALLBACK_PROVIDERS) refs.push(p.id, ...(p.aliases ?? []));
    const dups = refs.filter((r, i) => refs.indexOf(r) !== i);
    expect(dups, `duplicate refs: ${dups.join(', ')}`).toEqual([]);
  });

  it('marks local providers as not needing an API key', async () => {
    const { FALLBACK_PROVIDERS } = await import('../ProviderRegistry');
    const ollama = FALLBACK_PROVIDERS.find(p => p.id === 'ollama');
    expect(ollama?.needsApiKey).toBe(false);
  });
});