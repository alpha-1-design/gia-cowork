import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { scheduleRollout, cancelScheduledRollout, recordRolloutNow } from '../rolloutRecorder';

/**
 * The recorder's mechanics: coalescing, cancellation, and the desktop-only
 * gate. The write edge is mocked so no test touches a filesystem, and the
 * platform gate is mocked per-test (Node is never Tauri on its own).
 */

const writeCalls: { sessionId: string; text: string }[] = [];
let tauri = false;

vi.mock('../rollout', () => ({
  rolloutSerialize: (session: { id: string }) => `META ${session.id}`,
  rolloutWrite: async (sessionId: string, text: string) => {
    writeCalls.push({ sessionId, text });
    return `~/gia-rollouts/rollout-${sessionId}.jsonl`;
  },
}));

vi.mock('../../../platform', () => ({ isTauri: () => tauri }));

const session = () => ({ id: 'sess-1', messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }] });

beforeEach(() => {
  writeCalls.length = 0;
  tauri = false;
  cancelScheduledRollout('sess-1');
});
afterEach(() => cancelScheduledRollout('sess-1'));

describe('rolloutRecorder', () => {
  it('does nothing off the desktop shell — web pays nothing and writes nothing', () => {
    scheduleRollout(session(), 10);
    expect(writeCalls).toHaveLength(0);
  });

  it('coalesces a burst of message adds into ONE trailing write', async () => {
    tauri = true;
    scheduleRollout(session(), 10);
    scheduleRollout(session(), 10);
    scheduleRollout(session(), 10);
    await new Promise((r) => setTimeout(r, 40));
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]).toMatchObject({ sessionId: 'sess-1', text: 'META sess-1' });
  });

  it('cancellation drops the pending write', async () => {
    tauri = true;
    scheduleRollout(session(), 20);
    cancelScheduledRollout('sess-1');
    await new Promise((r) => setTimeout(r, 50));
    expect(writeCalls).toHaveLength(0);
  });

  it('a record failure is swallowed — the recorder never breaks the turn', async () => {
    tauri = true;
    const writeSpy = writeCalls;
    expect(await recordRolloutNow(session())).toBe('~/gia-rollouts/rollout-sess-1.jsonl');
    expect(writeSpy).toHaveLength(1);
  });
});
