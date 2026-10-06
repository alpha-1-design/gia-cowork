import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FALLBACK_PROVIDERS } from '../ProviderRegistry';
import {
  PROVIDER_INFO,
  providerInfo,
  companyFor,
  descriptionFor,
  docsUrlFor,
} from '../providerInfo';

const ids = FALLBACK_PROVIDERS.map(p => p.id);
const infoIds = Object.keys(PROVIDER_INFO);

/**
 * The bug this file exists to prevent: metadata keyed on a name that does not
 * match the registry id (`novita` vs `novita-ai`, `stepfun` vs `stepfun-ai`).
 * A silent miss means the picker shows a blank company and no link, which is
 * the same "present in the data, invisible in the product" failure that keeps
 * turning up in this project — so assert exact correspondence, both ways.
 */
describe('provider metadata coverage', () => {
  it('covers every registered provider', () => {
    const missing = ids.filter(id => !infoIds.includes(id));
    expect(missing, `no metadata for: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no metadata for providers that do not exist', () => {
    const orphans = infoIds.filter(id => !ids.includes(id));
    expect(orphans, `metadata for unknown id: ${orphans.join(', ')}`).toEqual([]);
  });

  it('is exactly one entry per provider', () => {
    expect(infoIds.length).toBe(ids.length);
    expect(new Set(infoIds).size).toBe(infoIds.length);
    expect(infoIds.length).toBe(71);
  });
});

describe('every provider list surface exposes a key link', () => {
  // The complaint was that the provider list showed names and model ids but
  // nowhere to get a key. Only the model switcher had the link; the Settings
  // capability matrix and the first-run wizard dead-ended on a key field.
  // Asserted against the source so all three are covered without a browser.
  const surfaces: Array<[string, string]> = [
    ['ModelSwitcherSheet (model switcher)', 'src/components/chat/ModelSwitcherSheet.tsx'],
    ['SettingsModule (capability matrix)', 'src/modules/SettingsModule.tsx'],
    ['SetupWizard (first-run key entry)', 'src/components/SetupWizard.tsx'],
  ];

  for (const [name, path] of surfaces) {
    it(`${name} renders a docsUrlFor link`, () => {
      const source = readFileSync(path, 'utf8');
      expect(source, `${name} does not call docsUrlFor`).toContain('docsUrlFor');
      expect(source, `${name} does not bind the url to href`).toContain('href={docsUrlFor');
    });
  }
});

describe('provider metadata quality', () => {
  it('always names a company', () => {
    for (const id of ids) {
      expect(providerInfo(id)?.company?.trim().length, `${id} has no company`).toBeGreaterThan(0);
    }
  });

  it('always has a one-line description', () => {
    for (const id of ids) {
      const d = descriptionFor(id);
      expect(d.trim().length, `${id} has no description`).toBeGreaterThan(0);
      expect(d.trim().length, `${id} description too long for a picker row`).toBeLessThan(140);
    }
  });

  it('links to a real https destination for every hosted provider', () => {
    const local = new Set(['ollama', 'lmstudio', 'local-llm']);
    for (const id of ids) {
      const url = docsUrlFor(id);
      if (local.has(id)) {
        // Local providers are installed, not signed up for.
        expect(url, `${id} should not link anywhere`).toBe('');
        continue;
      }
      expect(url, `${id} has no docs link`).toMatch(/^https:\/\//);
    }
  });

  it('never points at a bare homepage when a key page exists', () => {
    // Guards the important ones against regressing to marketing URLs.
    expect(docsUrlFor('openai')).toContain('/api-keys');
    expect(docsUrlFor('anthropic')).toContain('/keys');
    expect(docsUrlFor('groq')).toContain('/keys');
    expect(docsUrlFor('deepinfra')).toContain('/api_keys');
  });

  it('falls back safely for unknown ids instead of throwing', () => {
    expect(providerInfo('does-not-exist')).toBeUndefined();
    expect(companyFor('does-not-exist')).toBe('does-not-exist');
    expect(descriptionFor('does-not-exist')).toBe('');
    expect(docsUrlFor('does-not-exist')).toBe('');
  });

  it('resolves metadata through the accessor helpers for a sample', () => {
    expect(companyFor('openai')).toBe('OpenAI');
    expect(companyFor('azure')).toBe('Microsoft Azure');
    expect(companyFor('ollama')).toBe('Ollama');
    expect(descriptionFor('groq').length).toBeGreaterThan(0);
  });
});