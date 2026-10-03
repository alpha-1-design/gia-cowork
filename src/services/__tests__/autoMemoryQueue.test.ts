import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AutoMemory } from '../AutoMemory';

/**
 * The bug this guards: `processingQueue` held bare strings, and the drain loop
 * analyzed each one using the `messageId` and `role` of whichever call started
 * the loop. So any message that arrived while a slow analysis was in flight got
 * the first caller's role — the branch that decides which extractor runs — and
 * its id was never recorded, so it could be analyzed twice on replay.
 *
 * The failure is invisible in normal use because analysis is usually fast, which
 * is exactly why it needs a test: the shape of the bug is "two things raced",
 * so the test has to actually make them race.
 */

const addMemory = vi.hoisted(() => vi.fn());
const addEntity = vi.hoisted(() => vi.fn());

vi.mock('../../store/useMemoryStore', () => ({
  useMemoryStore: {
    getState: () => ({ addMemory, addEntity, getMemories: () => [], addSessionSummary: vi.fn() }),
  },
}));

vi.mock('../KnowledgeGraphService', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, knowledgeGraphService: { extractFromText: vi.fn() } };
});

describe('AutoMemory queue preserves message identity', () => {
  let mem: AutoMemory;

  beforeEach(() => {
    addMemory.mockClear();
    addEntity.mockClear();
    mem = new AutoMemory();
    // Extraction is off so the assertion below is about role routing, not the
    // entity debounce (covered in autoMemoryExtraction.test.ts).
    mem.updateConfig({ extractEntities: false, extractFacts: false, extractEmotions: false });
  });

  it('analyzes a queued message with its own role, not the first caller\'s', async () => {
    // First call starts the loop; it must not finish before the second lands.
    const gate = { resolve: () => {} };
    const blocked = new Promise<void>((r) => { gate.resolve = r; });
    const spy = vi.spyOn(mem as unknown as { analyzeAndStore: (...a: unknown[]) => Promise<void> },
      'analyzeAndStore').mockImplementationOnce(async () => { await blocked; });

    const first = mem.processMessage('I like dark roast coffee in the morning.', 'm1', 'user');
    // Lands while `first` is still mid-analysis.
    const second = mem.processMessage('I dislike meetings that could have been messages.', 'm2', 'user');

    gate.resolve();
    await first;
    await second;
    // Capture before restoring — `mockRestore` also clears call history.
    const ids = spy.mock.calls.map(c => c[1]);
    spy.mockRestore();

    // m2 must be analyzed under m2's id, not m1's.
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('routes a queued user message to the user extractor', async () => {
    // Replay the same race, but with a differing role, and assert the branch.
    const gate = { resolve: () => {} };
    const blocked = new Promise<void>((r) => { gate.resolve = r; });
    const spy = vi.spyOn(mem as unknown as { analyzeAndStore: (...a: unknown[]) => Promise<void> },
      'analyzeAndStore').mockImplementationOnce(async () => { await blocked; });

    const first = mem.processMessage('I am the owner of the payments service.', 'm1', 'user');
    // An assistant turn queued behind it — under the old bug this was analyzed
    // as if the user had said it, and stored as a user profile fact.
    const second = mem.processMessage('Sure, here is a summary of the migration plan.', 'm2', 'assistant');

    gate.resolve();
    await first;
    await second;
    const roles = spy.mock.calls.map(c => c[2]);
    spy.mockRestore();

    expect(roles).toEqual(['user', 'assistant']);
  });

  it('records every queued id so a replay is not analyzed twice', async () => {
    const gate = { resolve: () => {} };
    const blocked = new Promise<void>((r) => { gate.resolve = r; });
    // Delay the FIRST call but still run the real body, because it is the real
    // body that records ids in `processedMessages`. A no-op stub would skip that
    // recording and make this test assert something the product never promised.
    const inner = (mem as unknown as { analyzeAndStore: (...a: unknown[]) => Promise<void> }).analyzeAndStore.bind(mem);
    const spy = vi.spyOn(mem as unknown as { analyzeAndStore: (...a: unknown[]) => Promise<void> },
      'analyzeAndStore').mockImplementationOnce(async (...args: unknown[]) => {
      await blocked;
      return inner(...args);
    });

    const first = mem.processMessage('I work primarily on the billing platform.', 'm1', 'user');
    const second = mem.processMessage('I always write tests before shipping changes.', 'm2', 'user');
    gate.resolve();
    await first;
    await second;

    // Replay both. The spy must stay attached across `mockClear` — restoring it
    // first would detach it from the instance and make the assertion vacuous.
    spy.mockClear();
    await mem.processMessage('I work primarily on the billing platform.', 'm1', 'user');
    await mem.processMessage('I always write tests before shipping changes.', 'm2', 'user');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});