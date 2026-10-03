import { describe, it, expect, beforeEach } from 'vitest';
import { exportConfig, validateConfig, exportConfigString } from '../ConfigEditor';
import { useGiaStore } from '../../store/useGiaStore';
import { useProviderStore } from '../../store/useProviderStore';

describe('config export', () => {
  beforeEach(() => {
    useProviderStore.setState({
      providers: {
        openai: { apiKey: 'sk-super-secret', model: 'gpt-4o', enabled: true },
      },
      activeProvider: 'openai',
    });
  });

  it('never exports provider credentials', () => {
    const cfg = exportConfig();
    expect(cfg.providers.openai.apiKey).not.toBe('sk-super-secret');
    expect(cfg.providers.openai.apiKey).toContain('redacted');
  });

  it('keeps credentials out of the serialised document entirely', () => {
    expect(exportConfigString()).not.toContain('sk-super-secret');
  });

  it('still exports the non-secret provider settings', () => {
    const cfg = exportConfig();
    expect(cfg.providers.openai.model).toBe('gpt-4o');
    expect(cfg.providers.openai.enabled).toBe(true);
  });
});

describe('config validation', () => {
  it('rejects a non-object document', () => {
    expect(validateConfig('nope').ok).toBe(false);
    expect(validateConfig([]).ok).toBe(false);
    expect(validateConfig(null).ok).toBe(false);
  });

  it('accepts a minimal valid document', () => {
    const result = validateConfig({ behaviour: { webSearch: true } });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects an out-of-range proactiveness', () => {
    expect(validateConfig({ identity: { proactiveness: 5 } }).ok).toBe(false);
    expect(validateConfig({ identity: { proactiveness: 'high' } }).ok).toBe(false);
  });

  it('rejects non-boolean feature toggles only via provider types', () => {
    // Feature booleans are checked at apply time; the type guard here is for
    // structurally wrong sections.
    const result = validateConfig({ providers: { openai: { enabled: 'yes' } } });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('enabled');
  });

  it('rejects a non-object providers section', () => {
    expect(validateConfig({ providers: ['openai'] }).ok).toBe(false);
  });

  it('warns but does not fail on unknown sections', () => {
    const result = validateConfig({ behaviour: {}, somethingNew: { a: 1 } });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toContain('somethingNew');
  });

  it('warns that a redacted apiKey will be left untouched', () => {
    // Round-tripping an export must not overwrite real credentials.
    const result = validateConfig({ providers: { openai: { apiKey: '***redacted***' } } });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toContain('redacted');
  });

  it('rejects a non-string activeProvider', () => {
    expect(validateConfig({ activeProvider: 42 }).ok).toBe(false);
  });
});