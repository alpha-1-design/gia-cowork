import { describe, it, expect } from 'vitest';
import { SentenceChunker } from '../SentenceChunker';

describe('SentenceChunker — stream → speakable sentences', () => {
  it('emits complete sentences as they finish, holds fragments', () => {
    const c = new SentenceChunker({ minSentenceChars: 10 });
    expect(c.feed('The quick brown fox')).toEqual([]); // no boundary yet
    expect(c.feed(' jumps over. ')).toEqual(['The quick brown fox jumps over.']);
    expect(c.feed('The lazy')).toEqual([]); // fragment held
    expect(c.pendingChars).toBe(9); // leading space of the consumed '. ' boundary
  });

  it('flush emits the tail so she never swallows her last words', () => {
    const c = new SentenceChunker({ minSentenceChars: 10 });
    c.feed('One full sentence here. And a trailing cut');
    expect(c.flush()).toEqual(['And a trailing cut']);
    expect(c.pendingChars).toBe(0);
  });

  it('never speaks code fences', () => {
    const c = new SentenceChunker({ minSentenceChars: 10 });
    const out = c.feed('Here is the plan. ```js\nconst x = 1;\ny()();\n```\nThat was code.');
    // No fence content may appear in any emitted sentence.
    for (const s of out) {
      expect(s).not.toMatch(/const x|y\(\)/);
    }
    expect(out.some((s) => s.includes('Here is the plan.'))).toBe(true);
    const all = out.join(' ') + ' ' + c.flush().join(' ');
    expect(all).toContain('That was code.');
  });

  it('long unpunctuated runs emit at the runaway cap instead of going silent', () => {
    const c = new SentenceChunker({ minSentenceChars: 10, maxSentenceChars: 80 });
    const run = 'word '.repeat(40); // 200 chars, no boundary
    const out = c.feed(run);
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) expect(s.length).toBeLessThanOrEqual(85);
  });

  it('splits on newlines too (list-style answers)', () => {
    const c = new SentenceChunker({ minSentenceChars: 10 });
    const out = c.feed('First thing to know.\nSecond thing to know.\nThird thing');
    expect(out).toEqual(['First thing to know.', 'Second thing to know.']);
    expect(c.flush()).toEqual(['Third thing']);
  });

  it('reset clears buffer and fence state', () => {
    const c = new SentenceChunker({ minSentenceChars: 10 });
    c.feed('```js\nsome code');
    c.reset();
    expect(c.pendingChars).toBe(0);
    // fence state cleared: next plain text passes through
    expect(c.feed('plain prose here.')).toEqual(['plain prose here.']);
  });
});
