import { describe, it, expect } from 'vitest';
import { normalizeHarmonyToolCalls } from '../streamParser';

/**
 * gpt-oss "harmony" leak: providers that don't translate the model's internal
 * channels into tool_calls deltas leave raw syntax in `content`. The
 * normalizer must rewrite it into runnable ```tool blocks.
 */
const leaked =
  'Let me create that file.\n<|start|>assistant<|channel|>commentary to=tool id=filesystem_write>{"args":{"path":"hello.txt","content":"hi from gia"}}<|call|>';

const leakedNoId =
  '<|start|>assistant<|channel|>commentary to=tools {"args":{"path":"x.txt"}}<|call|>';

const leakedTopLevelArgs =
  '<|start|>assistant<|channel|>commentary to=tool id=web_search>{"query":"gia"}<|call|>';

describe('normalizeHarmonyToolCalls', () => {
  it('converts a leaked id-bearing harmony call into a ```tool block', () => {
    const out = normalizeHarmonyToolCalls(leaked);
    expect(out).toContain('Let me create that file.');
    expect(out).toContain('```tool');
    expect(out).toContain('"filesystem_write"');
    expect(out).toContain('"hello.txt"');
    expect(out).not.toContain('<|channel|>');
  });

  it('still works when the model omits id=', () => {
    const out = normalizeHarmonyToolCalls(leakedNoId);
    expect(out).toContain('```tool');
    expect(out).toContain('"x.txt"');
  });

  it('accepts top-level args objects (no {"args": ...} wrapper)', () => {
    const out = normalizeHarmonyToolCalls(leakedTopLevelArgs);
    expect(out).toContain('"web_search"');
    expect(out).toContain('"gia"');
  });

  it('unwraps the {"args": {...}} wrapper instead of nesting it', () => {
    const out = normalizeHarmonyToolCalls(leaked);
    // args must be the actual arguments object, not { args: { args: ... } }
    expect(out).not.toContain('"args":{"args"');
  });

  it('leaves plain text untouched', () => {
    expect(normalizeHarmonyToolCalls('just a normal reply')).toBe('just a normal reply');
    expect(normalizeHarmonyToolCalls('')).toBe('');
  });

  it('strips residual harmony markers from surrounding text', () => {
    const out = normalizeHarmonyToolCalls('<|start|>assistant<|channel|>final Here is the answer<|end|>');
    expect(out).toContain('Here is the answer');
    expect(out).not.toContain('<|');
  });

  it('survives malformed JSON args without throwing', () => {
    const bad = '<|start|>assistant<|channel|>commentary to=tool id=t>{not json<|call|>';
    expect(() => normalizeHarmonyToolCalls(bad)).not.toThrow();
    expect(normalizeHarmonyToolCalls(bad)).toContain('```tool');
  });
});
