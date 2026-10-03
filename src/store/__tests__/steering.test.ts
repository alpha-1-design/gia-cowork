import { describe, it, expect, beforeEach } from 'vitest';
import { useGiaStore } from '../useGiaStore';

/**
 * The queue answers "what do I say next". Steering answers "wait, not like
 * that" — and the whole value is that it arrives *during* the turn.
 *
 * Two properties are load-bearing and both are easy to get wrong:
 *
 *   1. Draining is destructive. The runner calls `takeSteering` once per tool
 *      group; if the notes survived, the agent would re-read the same
 *      correction on every subsequent step and act on it repeatedly.
 *   2. It is session-scoped. A correction typed into one conversation must
 *      never be handed to another conversation's agent.
 */

describe('steering notes', () => {
  beforeEach(() => {
    useGiaStore.setState({ steeringNotes: [] } as never);
  });

  it('delivers a note exactly once', () => {
    useGiaStore.getState().addSteering('s1', 'actually use Tailwind, not CSS modules');

    const first = useGiaStore.getState().takeSteering('s1');
    expect(first.map(n => n.text)).toEqual(['actually use Tailwind, not CSS modules']);

    // Second drain must be empty, or the agent re-reads it every step.
    expect(useGiaStore.getState().takeSteering('s1')).toEqual([]);
  });

  it('does not deliver one session\'s steering to another', () => {
    useGiaStore.getState().addSteering('s1', 'wrong repo');
    useGiaStore.getState().addSteering('s2', 'wrong session');

    expect(useGiaStore.getState().takeSteering('s1').map(n => n.text)).toEqual(['wrong repo']);
    expect(useGiaStore.getState().takeSteering('s2').map(n => n.text)).toEqual(['wrong session']);
  });

  it('preserves order when several notes arrive in one batch', () => {
    useGiaStore.getState().addSteering('s1', 'first');
    useGiaStore.getState().addSteering('s1', 'second');
    useGiaStore.getState().addSteering('s1', 'third');
    expect(useGiaStore.getState().takeSteering('s1').map(n => n.text))
      .toEqual(['first', 'second', 'third']);
  });

  it('gives every note a distinct id so React keys do not collide', () => {
    useGiaStore.getState().addSteering('s1', 'same text');
    useGiaStore.getState().addSteering('s1', 'same text');
    const notes = useGiaStore.getState().steeringNotes;
    expect(notes).toHaveLength(2);
    expect(notes[0].id).not.toBe(notes[1].id);
  });

  it('leaves the queue alone — steering is a separate channel', () => {
    useGiaStore.setState({ queuedMessages: [] } as never);
    useGiaStore.getState().enqueueMessage({
      id: 'q1', sessionId: 's1', text: 'later question', attachments: [], queuedAt: 1,
    });
    useGiaStore.getState().addSteering('s1', 'now, correction');

    useGiaStore.getState().takeSteering('s1');
    expect(useGiaStore.getState().queuedMessages).toHaveLength(1);
  });

  it('returns empty when nothing is pending, rather than undefined', () => {
    expect(useGiaStore.getState().takeSteering('nobody')).toEqual([]);
  });
});