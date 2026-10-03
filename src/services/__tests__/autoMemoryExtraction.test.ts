import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoMemory } from '../AutoMemory';

/**
 * The bug this guards: entity extraction used to clear its own pending timer
 * and keep only the newest message. In a real conversation — messages seconds
 * apart — that meant nearly everything said was silently dropped, and Neura
 * looked like it was learning only because the graph filled slowly.
 */

const { extractFromText } = vi.hoisted(() => ({
  extractFromText: vi.fn(async (_text: string, _messageId: string) => {}),
}));

vi.mock('../KnowledgeGraphService', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, knowledgeGraphService: { extractFromText } };
});

let mem: AutoMemory;
/** processMessage(text, messageId, role) — real argument order, and async. */
const say = async (text: string, id: string) => { await mem.processMessage(text, id, 'user'); };

describe('entity extraction batching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    extractFromText.mockClear();
    mem = new AutoMemory();
  });

  afterEach(() => {
    mem.flushPending();
    vi.useRealTimers();
  });

  it('extracts every message that arrived inside one debounce window', async () => {
    await say('I moved the production deploy to the release branch last Tuesday afternoon.', 'm1');
    await say('Sarah from the platform team owns the payments integration end to end.', 'm2');
    await say('The payments integration depends on the legacy billing database schema.', 'm3');

    vi.advanceTimersByTime(2500);

    // Three messages, three extractions. Before the fix this was one.
    expect(extractFromText).toHaveBeenCalledTimes(3);
    const texts = extractFromText.mock.calls.map(c => c[0]);
    expect(texts).toContain('Sarah from the platform team owns the payments integration end to end.');
    expect(texts.some(t => t.includes('release branch'))).toBe(true);
  });

  it('does not extract the same message twice', async () => {
    say('The staging cluster lives in eu-west-1 and was rebuilt on Tuesday.', 'm1');
    vi.advanceTimersByTime(2500);
    vi.advanceTimersByTime(5000);
    expect(extractFromText).toHaveBeenCalledTimes(1);
  });

  it('batches a second window separately', async () => {
    await say('the first project is the payments integration rewrite', 'm1');
    vi.advanceTimersByTime(2500);
    await say('the second project is the legacy billing database migration', 'm2');
    vi.advanceTimersByTime(2500);
    expect(extractFromText).toHaveBeenCalledTimes(2);
  });

  it('flushes on demand rather than waiting for the timer', async () => {
    await say('the payments integration was signed off by Sarah this morning', 'm1');
    mem.flushPending();
    expect(extractFromText).toHaveBeenCalledTimes(1);
  });

  it('bounds the buffer during a very long run of messages', async () => {
    for (let i = 0; i < 40; i++) await say(`project ${i} has a documented owner and a staging cluster`, `m${i}`);
    vi.advanceTimersByTime(2500);
    // Bounded, not unbounded — but far more than the old behaviour, which
    // kept exactly one pending text and dropped the rest.
    expect(extractFromText.mock.calls.length).toBeGreaterThan(1);
    expect(extractFromText.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it('skips trivial messages entirely', async () => {
    await say('ok', 'm1');
    await say('thanks', 'm2');
    vi.advanceTimersByTime(2500);
    expect(extractFromText).not.toHaveBeenCalled();
  });
});