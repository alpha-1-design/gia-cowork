import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useTrustStore } from '../useTrustStore';
import { classifyToolRequest, type PermissionRequest } from '../../services/permissions';

function req(toolId: string, args: Record<string, unknown> = {}, risk?: PermissionRequest['risk']) {
  const r = classifyToolRequest(toolId, toolId, args);
  if (risk) r.risk = risk;
  return r;
}

function reset() {
  useTrustStore.setState({
    grants: [], sessionGrants: [], audit: [], armed: true, askThreshold: 'low',
    pendingQueue: [], pending: null,
  });
}

describe('trust store — verdict', () => {
  beforeEach(reset);

  it('allows a read without asking', () => {
    expect(useTrustStore.getState().verdict(req('filesystem_read', { path: 'a.ts' }))).toBe('allow');
  });

  it('asks about an ungranted write', () => {
    expect(useTrustStore.getState().verdict(req('filesystem_write', { path: 'src/a.ts', content: '' }))).toBe('ask');
  });

  it('asks at the configured threshold, not below it', () => {
    useTrustStore.getState().setAskThreshold('high');
    expect(useTrustStore.getState().verdict(req('filesystem_write', { path: 'src/a.ts', content: '' }))).toBe('allow');
    expect(useTrustStore.getState().verdict(req('terminal_run', { command: 'git push' }))).toBe('allow');
    expect(useTrustStore.getState().verdict(req('terminal_run', { command: 'sudo rm x' }))).toBe('ask');
  });
});

describe('trust store — grants', () => {
  beforeEach(reset);

  it('lets a session grant cover the same scope and nothing else', () => {
    const store = useTrustStore.getState();
    store.grant(req('filesystem_write', { path: 'src/a.ts', content: '' }), 'session');

    // Same directory — covered, because "writes under src" is what was granted.
    expect(store.verdict(req('filesystem_write', { path: 'src/b.ts', content: '' }))).toBe('allow');
    // A different directory — not covered. If a grant for `src` leaked into
    // `lib`, then "writes under src" would quietly mean "writes anywhere".
    expect(store.verdict(req('filesystem_write', { path: 'lib/b.ts', content: '' }))).toBe('ask');
  });

  it('keeps session grants and permanent grants separate', () => {
    const store = useTrustStore.getState();
    store.grant(req('filesystem_write', { path: 'src/a.ts', content: '' }), 'always');

    expect(useTrustStore.getState().grants).toHaveLength(1);
    expect(useTrustStore.getState().sessionGrants).toHaveLength(0);
  });

  it('does not duplicate a re-granted scope', () => {
    const store = useTrustStore.getState();
    store.grant(req('filesystem_write', { path: 'src/a.ts', content: '' }), 'always');
    store.grant(req('filesystem_write', { path: 'src/b.ts', content: '' }), 'always');
    expect(useTrustStore.getState().grants).toHaveLength(1);
  });

  it('revokes by scope and clears everything', () => {
    const store = useTrustStore.getState();
    store.grant(req('filesystem_write', { path: 'src/a.ts', content: '' }), 'always');
    store.grant(req('terminal_run', { command: 'git push' }), 'session');
    expect(useTrustStore.getState().verdict(req('filesystem_write', { path: 'src/a.ts', content: '' }))).toBe('allow');

    useTrustStore.getState().revokeAll();
    expect(useTrustStore.getState().grants).toHaveLength(0);
    expect(useTrustStore.getState().sessionGrants).toHaveLength(0);
  });
});

describe('trust store — the kill switch', () => {
  beforeEach(reset);

  it('blocks everything when disarmed, even with a standing grant', () => {
    const store = useTrustStore.getState();
    store.grant(req('terminal_run', { command: 'git push' }), 'always');
    expect(store.verdict(req('terminal_run', { command: 'git push' }))).toBe('allow');

    useTrustStore.getState().setArmed(false);
    // The point of the kill switch is that it works when everything else has
    // been set to "yes". A grant given an hour ago must not survive a panic.
    expect(useTrustStore.getState().verdict(req('terminal_run', { command: 'git push' }))).toBe('block');
    expect(useTrustStore.getState().verdict(req('filesystem_read', { path: 'a.ts' }))).toBe('block');
  });

  it('denies an open prompt rather than leaving it unanswered', () => {
    const store = useTrustStore.getState();
    void store.request(req('terminal_run', { command: 'npm publish' }));
    expect(useTrustStore.getState().pending).not.toBeNull();

    const nowArmed = useTrustStore.getState().toggleArmed();
    expect(nowArmed).toBe(false);
    // A prompt waiting on an answer the user has already given up on must not
    // sit there holding a tool call hostage.
    expect(useTrustStore.getState().pending).toBeNull();
  });

  it('denies every queued prompt, not just the one on the card', async () => {
    const store = useTrustStore.getState();
    const first = store.request(req('terminal_run', { command: 'npm publish' }));
    const second = store.request(req('terminal_run', { command: 'rm -rf build' }));

    useTrustStore.getState().toggleArmed();
    await expect(first).resolves.toBe('deny');
    await expect(second).resolves.toBe('deny');
    expect(useTrustStore.getState().pendingQueue).toHaveLength(0);
  });

  it('toggles back', () => {
    expect(useTrustStore.getState().toggleArmed()).toBe(false);
    expect(useTrustStore.getState().toggleArmed()).toBe(true);
  });
});

describe('trust store — the prompt queue', () => {
  beforeEach(reset);
  afterEach(() => vi.useRealTimers());

  it('resolves the caller with the chosen answer', async () => {
    const store = useTrustStore.getState();
    const pending = store.request(req('filesystem_write', { path: 'src/a.ts', content: '' }));
    useTrustStore.getState().resolve('once');
    await expect(pending).resolves.toBe('once');
    // A one-time answer must not become a standing grant.
    expect(useTrustStore.getState().grants).toHaveLength(0);
    expect(useTrustStore.getState().sessionGrants).toHaveLength(0);
  });

  it('records a session grant from the chosen answer', async () => {
    const pending = useTrustStore.getState().request(req('filesystem_write', { path: 'src/a.ts', content: '' }));
    useTrustStore.getState().resolve('session');
    await expect(pending).resolves.toBe('session');
    expect(useTrustStore.getState().sessionGrants).toHaveLength(1);
  });

  it('queues a second prompt instead of answering it for the user', async () => {
    const first = useTrustStore.getState().request(req('terminal_run', { command: 'rm -rf build' }));
    const second = useTrustStore.getState().request(req('terminal_run', { command: 'npm publish' }));

    // Nothing is answered just because something else asked. The first card
    // stays up; the second lane waits its turn — under a 4-lane 'ask' swarm,
    // denying the older card would fail a lane the user never saw.
    expect(useTrustStore.getState().pendingQueue).toHaveLength(2);
    expect(useTrustStore.getState().pending?.request.headline)
      .toBe(useTrustStore.getState().pendingQueue[0].request.headline);

    useTrustStore.getState().resolve('deny');
    await expect(first).resolves.toBe('deny');
    // The next entry is promoted to the card, and it is still answerable.
    expect(useTrustStore.getState().pending?.request.args.command).toBe('npm publish');
    useTrustStore.getState().resolve('once');
    await expect(second).resolves.toBe('once');
    expect(useTrustStore.getState().pending).toBeNull();
  });

  it('times out each queued entry on its own clock', async () => {
    vi.useFakeTimers();
    const head = useTrustStore.getState().request(req('terminal_run', { command: 'npm publish' }));

    // The second card is enqueued a minute later, so the two clocks differ:
    // each entry expires 120s after ITS enqueue, not after it reaches the head.
    vi.advanceTimersByTime(100_000);
    const queued = useTrustStore.getState().request(req('terminal_run', { command: 'rm -rf build' }));

    vi.advanceTimersByTime(20_001);
    // Silence is consent to nothing — the head expires on schedule, and the
    // buried card is promoted rather than dragged down with it.
    await expect(head).resolves.toBe('deny');
    expect(useTrustStore.getState().pendingQueue).toHaveLength(1);
    expect(useTrustStore.getState().pending?.request.args.command).toBe('rm -rf build');

    vi.advanceTimersByTime(99_999);
    await expect(queued).resolves.toBe('deny');
    expect(useTrustStore.getState().pendingQueue).toHaveLength(0);
  });

  it('defaults to deny when nobody answers', async () => {
    vi.useFakeTimers();
    const pending = useTrustStore.getState().request(req('terminal_run', { command: 'rm -rf ~' }));
    vi.advanceTimersByTime(120_001);
    // Silence is consent to nothing. The safe answer is the one you get for
    // free when the app is closed, backgrounded, or the dialog was missed.
    await expect(pending).resolves.toBe('deny');
  });
});

describe('trust store — audit', () => {
  beforeEach(reset);

  it('records an automatic allow', async () => {
    await useTrustStore.getState().checkTool('filesystem_read', 'filesystem_read', { path: 'a.ts' });
    expect(useTrustStore.getState().audit[0].choice).toBe('auto');
  });

  it('records a kill-switch block distinctly from a user denial', async () => {
    useTrustStore.getState().setArmed(false);
    await useTrustStore.getState().checkTool('filesystem_read', 'filesystem_read', { path: 'a.ts' });
    expect(useTrustStore.getState().audit[0].choice).toBe('blocked');
  });

  it('bounds the log', () => {
    const store = useTrustStore.getState();
    for (let i = 0; i < 60; i++) store.grant(req('filesystem_write', { path: `src/f${i}.ts`, content: '' }), 'once');
    expect(useTrustStore.getState().audit.length).toBeLessThanOrEqual(50);
  });
});

describe('trust store — checkTool end to end', () => {
  beforeEach(reset);

  it('auto-allows a read without ever opening a prompt', async () => {
    const outcome = await useTrustStore.getState().checkTool('filesystem_read', 'filesystem_read', { path: 'a.ts' });
    expect(outcome.allowed).toBe(true);
    expect(useTrustStore.getState().pending).toBeNull();
  });

  it('returns a refusal reason the runner can hand back to the model', async () => {
    useTrustStore.getState().setArmed(false);
    const outcome = await useTrustStore.getState().checkTool('terminal_run', 'terminal_run', { command: 'rm -rf ~' });
    expect(outcome.allowed).toBe(false);
    expect(outcome.refusalReason).toBeTruthy();
  });
});