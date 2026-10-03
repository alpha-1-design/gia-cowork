import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The service imports isTauri() from platform, which reads window at call time.
// Presenter mode is desktop-only, so fake the Tauri marker before each test.
function withTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

import {
  __resetPresenterMode,
  __setPresenterBackend,
  attachTrayBridge,
  enterPresenterMode,
  exitPresenterMode,
  isPresenting,
  presenterSupported,
  subscribe,
  togglePresenterMode,
  type PresenterBackend,
} from '../PresenterMode';

function makeBackend(): PresenterBackend & { hide: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn> } {
  return { hide: vi.fn().mockResolvedValue(undefined), show: vi.fn().mockResolvedValue(undefined) };
}

describe('PresenterMode', () => {
  beforeEach(() => {
    __resetPresenterMode();
    withTauri(true);
    document.body.innerHTML = '';
    delete document.body.dataset.presenting;
  });

  afterEach(() => {
    __resetPresenterMode();
    withTauri(false);
    document.body.innerHTML = '';
  });

  it('reports support only in the desktop shell', () => {
    expect(presenterSupported()).toBe(true);
    withTauri(false);
    expect(presenterSupported()).toBe(false);
  });

  it('refuses to enter outside the desktop app without touching anything', async () => {
    withTauri(false);
    const backend = makeBackend();
    __setPresenterBackend(backend);

    const res = await enterPresenterMode();

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/desktop app/i);
    expect(backend.hide).not.toHaveBeenCalled();
    expect(isPresenting()).toBe(false);
  });

  it('hides on enter and shows on exit', async () => {
    const backend = makeBackend();
    __setPresenterBackend(backend);

    await enterPresenterMode();
    expect(backend.hide).toHaveBeenCalledTimes(1);
    expect(isPresenting()).toBe(true);

    await exitPresenterMode();
    expect(backend.show).toHaveBeenCalledTimes(1);
    expect(isPresenting()).toBe(false);
  });

  it('treats a repeated enter as a no-op rather than stacking hides', async () => {
    const backend = makeBackend();
    __setPresenterBackend(backend);

    await enterPresenterMode();
    await enterPresenterMode();
    await enterPresenterMode();

    expect(backend.hide).toHaveBeenCalledTimes(1);

    // The critical part: one show for one enter, so the app is not stuck hidden.
    await exitPresenterMode();
    expect(backend.show).toHaveBeenCalledTimes(1);
  });

  it('exits cleanly when the hide itself fails', async () => {
    const backend = makeBackend();
    backend.hide.mockRejectedValue(new Error('window gone'));
    __setPresenterBackend(backend);

    const res = await enterPresenterMode();

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('window gone');
    // State must not flip on a failed hide, or exit would skip the restore.
    expect(isPresenting()).toBe(false);
  });

  it('always restores in-app chrome even when the window show fails', async () => {
    const el = document.createElement('div');
    el.setAttribute('data-presenter-hide', '');
    document.body.appendChild(el);

    const backend = makeBackend();
    backend.show.mockRejectedValue(new Error('no window'));
    __setPresenterBackend(backend);

    await enterPresenterMode();
    expect(el.style.display).toBe('none');

    const res = await exitPresenterMode();

    // The user must not be left with a blank app.
    expect(el.style.display).toBe('');
    expect(document.body.dataset.presenting).toBeUndefined();
    expect(res.ok).toBe(false);
  });

  it('restores each hidden element exactly once, even on a double exit', async () => {
    const el = document.createElement('div');
    el.setAttribute('data-presenter-hide', '');
    el.style.display = 'flex';
    document.body.appendChild(el);

    const backend = makeBackend();
    __setPresenterBackend(backend);

    await enterPresenterMode();
    expect(el.style.display).toBe('none');

    await exitPresenterMode();
    await exitPresenterMode();

    // A pre-existing inline style must survive the round trip.
    expect(el.style.display).toBe('flex');
    expect(backend.show).toHaveBeenCalledTimes(1);
  });

  it('hides floating chrome that mounts after presenter mode starts', async () => {
    const backend = makeBackend();
    __setPresenterBackend(backend);
    await enterPresenterMode();

    // A notification arriving mid-call would otherwise land on the shared screen.
    const late = document.createElement('div');
    late.setAttribute('data-presenter-hide', '');
    document.body.appendChild(late);
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 0));

    expect(late.style.display).toBe('none');

    await exitPresenterMode();
    expect(late.style.display).toBe('');
  });

  it('leaves non-opted-in content alone', async () => {
    const normal = document.createElement('div');
    document.body.appendChild(normal);

    const backend = makeBackend();
    __setPresenterBackend(backend);
    await enterPresenterMode();

    expect(normal.style.display).toBe('');

    await exitPresenterMode();
  });

  it('toggles and reports the resulting state', async () => {
    const backend = makeBackend();
    __setPresenterBackend(backend);

    expect(await togglePresenterMode()).toBe('active');
    expect(isPresenting()).toBe(true);
    expect(await togglePresenterMode()).toBe('off');
    expect(isPresenting()).toBe(false);
  });

  it('notifies subscribers and supports unsubscribe', async () => {
    const backend = makeBackend();
    __setPresenterBackend(backend);
    const seen: string[] = [];
    const off = subscribe(s => seen.push(s));

    await enterPresenterMode();
    await exitPresenterMode();
    off();
    await enterPresenterMode();

    expect(seen).toEqual(['active', 'off']);
  });

  it('a throwing subscriber does not break the state transition', async () => {
    const backend = makeBackend();
    __setPresenterBackend(backend);
    subscribe(() => { throw new Error('bad listener'); });

    const res = await enterPresenterMode();

    expect(res.ok).toBe(true);
    expect(isPresenting()).toBe(true);
  });

  it('restores chrome without re-showing the window when the tray already did', async () => {
    const el = document.createElement('div');
    el.setAttribute('data-presenter-hide', '');
    document.body.appendChild(el);

    const backend = makeBackend();
    __setPresenterBackend(backend);
    await enterPresenterMode();

    // This is the tray path: the window is on screen, only the webview state
    // is stale. Calling show() again would steal focus mid-call.
    const res = await exitPresenterMode({ windowAlreadyShown: true });

    expect(res.ok).toBe(true);
    expect(backend.show).not.toHaveBeenCalled();
    expect(el.style.display).toBe('');
    expect(isPresenting()).toBe(false);
  });

  it('bridges the tray event so a hidden app can always be recovered', async () => {
    const listeners: Array<(e: unknown) => void> = [];
    vi.doMock('@tauri-apps/api/event', () => ({
      listen: vi.fn(async (_name: string, cb: (e: unknown) => void) => {
        listeners.push(cb);
        return () => { listeners.length = 0; };
      }),
    }));

    const el = document.createElement('div');
    el.setAttribute('data-presenter-hide', '');
    document.body.appendChild(el);

    const backend = makeBackend();
    __setPresenterBackend(backend);
    const detach = await attachTrayBridge();

    await enterPresenterMode();
    expect(el.style.display).toBe('none');

    // User clicks "Show GIA Cowork" in the tray.
    listeners.forEach(cb => cb({}));
    await new Promise(r => setTimeout(r, 0));

    expect(isPresenting()).toBe(false);
    expect(el.style.display).toBe('');
    expect(document.body.dataset.presenting).toBeUndefined();

    detach();
    vi.doUnmock('@tauri-apps/api/event');
  });
});
