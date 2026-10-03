import { describe, it, expect } from 'vitest';
import {
  inferCapabilities, resolveCapabilities, parseContextWindow,
  capabilityBadges, describeCapabilities, isLikelyLocal,
} from '../ModelCapabilities';

describe('parseContextWindow', () => {
  it('parses plain numbers, k suffixes, and comma-separated values', () => {
    expect(parseContextWindow('128000')).toBe(128000);
    expect(parseContextWindow('128k')).toBe(128000);
    expect(parseContextWindow('1M')).toBe(1000000);
    expect(parseContextWindow('200,000')).toBe(200000);
    expect(parseContextWindow(8192)).toBe(8192);
  });

  it('returns null for anything it cannot read, rather than a wrong number', () => {
    // A wrong context number would make /tokens lie to the user.
    expect(parseContextWindow('lots')).toBeNull();
    expect(parseContextWindow('')).toBeNull();
    expect(parseContextWindow(null)).toBeNull();
    expect(parseContextWindow(0)).toBeNull();
  });
});

describe('inferCapabilities', () => {
  it('knows a flagship vision model can see', () => {
    expect(inferCapabilities('gpt-4o').vision).toBe(true);
    expect(inferCapabilities('claude-sonnet-4-5').vision).toBe(true);
    expect(inferCapabilities('gemini-2.5-flash').vision).toBe(true);
  });

  it('knows a text-only model cannot', () => {
    expect(inferCapabilities('gpt-3.5-turbo').vision).toBe(false);
    expect(inferCapabilities('text-davinci-003').vision).toBe(false);
  });

  it('detects audio input only on models that take it', () => {
    expect(inferCapabilities('gpt-4o-realtime-preview').audioInput).toBe(true);
    expect(inferCapabilities('gpt-4o-mini').audioInput).toBe(false);
  });

  it('detects image generation', () => {
    expect(inferCapabilities('dall-e-3').imageGeneration).toBe(true);
    expect(inferCapabilities('gpt-4o').imageGeneration).toBe(false);
  });

  it('treats embedding, whisper and rerank models as non-tool-calling', () => {
    expect(inferCapabilities('text-embedding-3-large').tools).toBe(false);
    expect(inferCapabilities('whisper-1').tools).toBe(false);
    expect(inferCapabilities('bge-reranker').tools).toBe(false);
  });

  it('detects reasoning models', () => {
    expect(inferCapabilities('o3-mini').reasoning).toBe(true);
    expect(inferCapabilities('deepseek-r1').reasoning).toBe(true);
    expect(inferCapabilities('gpt-4o').reasoning).toBe(false);
  });

  it('marks its own output as inferred', () => {
    // The UI must never present a guess as a guarantee.
    expect(inferCapabilities('gpt-4o').inferred).toBe(true);
  });

  it('handles an empty id without pretending to know anything', () => {
    const c = inferCapabilities('');
    expect(c.vision).toBe(false);
    expect(c.contextWindow).toBeNull();
  });
});

describe('resolveCapabilities', () => {
  it('lets a provider declaration override the guess', () => {
    // A provider that says "no vision" for a model whose name suggests
    // otherwise must be believed.
    const c = resolveCapabilities('gpt-4o', { vision: false });
    expect(c.vision).toBe(false);
    expect(c.inferred).toBe(false);
  });

  it('falls back to inference for anything the provider did not declare', () => {
    const c = resolveCapabilities('claude-sonnet-4-5', { vision: true });
    expect(c.tools).toBe(true);      // still inferred
    expect(c.vision).toBe(true);     // declared
    expect(c.inferred).toBe(false);   // partially declared counts as declared
  });

  it('carries the declared context window through', () => {
    expect(resolveCapabilities('gpt-4o', { context: '128000' }).contextWindow).toBe(128000);
  });

  it('works with no declaration at all', () => {
    expect(resolveCapabilities('gemini-2.5-flash').vision).toBe(true);
  });
});

describe('capabilityBadges', () => {
  it('lists only the capabilities the model actually has', () => {
    const badges = capabilityBadges(inferCapabilities('gpt-4o'));
    const keys = badges.map(b => b.key);
    expect(keys).toContain('vision');
    expect(keys).toContain('tools');
    expect(keys).not.toContain('audio');
    expect(keys).not.toContain('imagegen');
  });

  it('surfaces the capabilities people forget to look for', () => {
    const keys = capabilityBadges(inferCapabilities('gpt-4o-realtime-preview')).map(b => b.key);
    expect(keys).toContain('audio');
  });
});

describe('describeCapabilities', () => {
  it('states both what it can and cannot do', () => {
    const out = describeCapabilities(resolveCapabilities('gpt-4o', { vision: true }));
    expect(out).toMatch(/can read images/);
    expect(out).toMatch(/cannot accept audio input/);
  });

  it('tells her to say so rather than guess when a task needs more', () => {
    expect(describeCapabilities(inferCapabilities('gpt-4o'))).toMatch(/say so plainly/);
  });

  it('marks inferred capabilities as a guide, not a guarantee', () => {
    expect(describeCapabilities(inferCapabilities('gpt-4o'))).toMatch(/inferred/);
    expect(describeCapabilities(resolveCapabilities('gpt-4o', { vision: true }))).not.toMatch(/inferred/);
  });

  it('includes the context window when known', () => {
    expect(describeCapabilities(resolveCapabilities('gpt-4o', { context: '128k' }))).toMatch(/128,000 tokens/);
  });
});

describe('isLikelyLocal', () => {
  it('recognises local providers', () => {
    expect(isLikelyLocal('llama3', 'ollama')).toBe(true);
    expect(isLikelyLocal('anything', 'lmstudio')).toBe(true);
  });

  it('recognises local-looking model names on other providers', () => {
    expect(isLikelyLocal('llama3.2', 'custom')).toBe(true);
  });

  it('does not claim a flagship cloud model is local', () => {
    expect(isLikelyLocal('gpt-4o', 'openai')).toBe(false);
    expect(isLikelyLocal('claude-sonnet-4-5', 'anthropic')).toBe(false);
  });
});