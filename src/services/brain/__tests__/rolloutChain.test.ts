import { describe, it, expect } from 'vitest';
import { rolloutSerialize, rolloutParse, rolloutVerify, rolloutParseWithLines, RolloutLine } from '../rollout';

/**
 * Hash-chain tests (gia-rollout-2, W13 TESTIMONY). Serialization is pure, so
 * these are direct unit tests — the chain is recomputable from the file text
 * alone, which is exactly what `rolloutVerify` does.
 */

function msg(id: string, content: string, timestamp = 1700000000000) {
  return { id, role: 'user', content, timestamp };
}

describe('rollout hash chain (gia-rollout-2)', () => {
  it('chains every line: p matches the previous line, verify passes', () => {
    const text = rolloutSerialize({
      id: 'sess-1',
      messages: [msg('u1', 'hello'), msg('u2', 'world', 1700000001000)],
    });
    const lines = text.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(2);
    // Meta is the genesis: p is empty, h covers it.
    expect(lines[0].p).toBe('');
    expect(typeof lines[0].h).toBe('string');
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].p).toBe(lines[i - 1].h);
    }
    const v = rolloutVerify(text);
    expect(v).toEqual({ verified: true, brokenAt: null, unchained: false });
  });

  it('detects an edited line (h recomputes differently)', () => {
    const text = rolloutSerialize({ id: 's', messages: [msg('u1', 'original text')] });
    const lines = text.split('\n');
    const parsed = JSON.parse(lines[1]) as Record<string, unknown>;
    parsed.content = 'tampered';
    lines[1] = JSON.stringify(parsed);
    const v = rolloutVerify(lines.join('\n'));
    expect(v.verified).toBe(false);
    expect(v.brokenAt).toBe(2);
  });

  it('detects an inserted line (p breaks at the insertion point)', () => {
    const text = rolloutSerialize({ id: 's', messages: [msg('u1', 'one'), msg('u2', 'two')] });
    const lines = text.split('\n');
    const fake = JSON.stringify({ type: 'message', id: 'evil', role: 'user', content: 'inserted' });
    lines.splice(2, 0, fake);
    const v = rolloutVerify(lines.join('\n'));
    expect(v.verified).toBe(false);
    expect(v.brokenAt).toBe(3);
  });

  it('detects a dropped line (the survivor carries a stale p)', () => {
    const text = rolloutSerialize({ id: 's', messages: [msg('u1', 'one'), msg('u2', 'two'), msg('u3', 'three')] });
    const lines = text.split('\n');
    lines.splice(2, 1); // drop the middle history line
    const v = rolloutVerify(lines.join('\n'));
    expect(v.verified).toBe(false);
    expect(v.brokenAt).toBe(3);
  });

  it('treats a torn last line as a break at that point, not silent corruption', () => {
    const text = rolloutSerialize({ id: 's', messages: [msg('u1', 'one'), msg('u2', 'two')] });
    const torn = text.slice(0, text.length - 20);
    const v = rolloutVerify(torn);
    expect(v.verified).toBe(false);
    expect(v.brokenAt).not.toBeNull();
  });

  it('reports gia-rollout-1 files as unchained, not broken', () => {
    const v1 = [
      JSON.stringify({ type: 'meta', format: 'gia-rollout-1', sessionId: 's', appVersion: '1.0.0', createdAt: null }),
      JSON.stringify({ type: 'message', id: 'm1', role: 'user', content: 'hi' }),
      JSON.stringify({ type: 'summary', counts: { messages: 1, toolCalls: 0, toolOutputs: 0 } }),
    ].join('\n');
    expect(rolloutVerify(v1)).toEqual({ verified: false, brokenAt: null, unchained: true });
  });

  it('reports a mixed hashed/unhashed file as broken, not unchained', () => {
    // Strip the chain fields from the LAST line only: a hashed prefix with an
    // unhashed tail is a break at the tail, not an un-chained file.
    const raw = rolloutSerialize({ id: 's', messages: [msg('u1', 'one'), msg('u2', 'two')] }).split('\n');
    const last = JSON.parse(raw[raw.length - 1]) as Record<string, unknown>;
    const { p: _p, h: _h, ...bare } = last;
    raw[raw.length - 1] = JSON.stringify(bare);
    const v = rolloutVerify(raw.join('\n'));
    expect(v.verified).toBe(false);
    expect(v.brokenAt).toBe(raw.length);
  });

  it('is deterministic: same session in, same chained bytes out', () => {
    const session = { id: 'det', messages: [msg('u1', 'alpha'), msg('u2', 'beta')] };
    expect(rolloutSerialize(session)).toBe(rolloutSerialize(session));
  });

  it('parse keeps the hash fields so citations can carry them', () => {
    const text = rolloutSerialize({ id: 's', messages: [msg('u1', 'hello')] });
    const parsed = rolloutParse(text);
    const first = parsed.messages[0] as RolloutLine & { h?: string; p?: string };
    expect(typeof first.h).toBe('string');
    expect(typeof first.p).toBe('string');
  });

  it('parse-with-lines reports true physical line numbers, skipping nothing silently', () => {
    const text = rolloutSerialize({ id: 's', messages: [msg('u1', 'hello')] });
    const raw = text.split('\n');
    const { meta, entries } = rolloutParseWithLines(text);
    expect(meta).not.toBeNull();
    // First history entry sits on physical line 2 (meta is line 1).
    expect(entries[0].physicalLine).toBe(2);
    // The last entry is the summary line, at the physical end.
    expect(entries[entries.length - 1].physicalLine).toBe(raw.length);
    // A skipped garbage middle line does NOT shift numbering.
    const withGarbage = [raw[0], 'not json', ...raw.slice(1)].join('\n');
    const shifted = rolloutParseWithLines(withGarbage);
    expect(shifted.entries[0].physicalLine).toBe(3);
  });
});
