import { logger } from '../utils/logger';
import { isTauri } from '../platform';

/**
 * Presenter mode — GIA gets out of the way.
 *
 * When GIA is helping someone on a call and takes control of the machine,
 * her own window appears in their screen share. That is the single most
 * embarrassing failure mode for an agent that drives a desktop: the user looks
 * like they are being watched by a chatbot while trying to look professional.
 *
 * Presenter mode hides the main window and every floating piece of GIA chrome
 * (the Jarvis orb, toasts, overlays) so a screen share shows only the user's
 * work. Restoring is the part that matters — a window that never comes back is
 * a broken app — so the state machine guarantees the restore path runs, runs
 * exactly once, and can be force-repaired from a stale in-memory state.
 *
 * The window show/hide is delegated to an injectable backend so the state
 * machine can be tested without a Tauri shell. The default backend calls the
 * real `hide_for_capture` / `show_after_capture` commands.
 */

export type PresenterState = 'off' | 'active';

/** Mirrors PRESENTER_EXIT_EVENT in src-tauri/src/lib.rs. */
const PRESENTER_EXIT_EVENT = 'gia://presenter-exit';

export interface PresenterBackend {
  hide(): Promise<void>;
  show(): Promise<void>;
}

export type Listener = (state: PresenterState) => void;

let state: PresenterState = 'off';
let listeners: Listener[] = [];
let backend: PresenterBackend | null = null;
let resolveBackend: Promise<PresenterBackend> | null = null;
let restoreFns: Array<() => void> = [];

function emit() {
  for (const l of [...listeners]) {
    try { l(state); } catch (e) { logger.warn('[PresenterMode] listener failed:', e); }
  }
}

function setState(next: PresenterState) {
  if (state === next) return;
  state = next;
  emit();
}

async function getBackend(): Promise<PresenterBackend> {
  if (backend) return backend;
  if (resolveBackend) return resolveBackend;
  // Cached so concurrent callers share one backend instance, and so a failed
  // dynamic import is not retried on every call.
  resolveBackend = (async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    return {
      hide: () => invoke('presenter_set', { active: true }).then(() => undefined),
      show: () => invoke('presenter_set', { active: false }).then(() => undefined),
    };
  })();
  return resolveBackend;
}

/**
 * True when the real desktop shell is available. Presenter mode is
 * meaningless in a browser tab (there is no OS window to hide) and in
 * Capacitor, where the equivalent control belongs to the Android host.
 */
export function presenterSupported(): boolean {
  return isTauri();
}

/**
 * Hide GIA so a screen share shows only the user's work.
 *
 * Idempotent by design: a second call returns success without re-running the
 * hide, so overlapping triggers (a shortcut plus a menu item) cannot stack
 * hides and leave the UI stuck off with no matching show.
 */
export async function enterPresenterMode(): Promise<{ ok: boolean; reason?: string }> {
  if (state === 'active') return { ok: true };

  if (!presenterSupported()) {
    return { ok: false, reason: 'Presenter mode needs the GIA Cowork desktop app.' };
  }

  try {
    const b = await getBackend();
    await b.hide();
    // Only now is the app committed to being hidden — if the OS call throws we
    // have not touched the DOM, so there is nothing to undo.
    restoreFns.push(hideFloatingChrome());
    setState('active');
    logger.log('[PresenterMode] Entered — GIA hidden');
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('[PresenterMode] Failed to enter:', e);
    return { ok: false, reason: msg };
  }
}

/**
 * Restore GIA. Safe to call when already off (no-op) and safe to call after a
 * failed enter (also a no-op, because state only flips after the hide lands).
 * Each registered restore runs exactly once even if exit is called twice.
 */
export async function exitPresenterMode(
  opts: { windowAlreadyShown?: boolean } = {},
): Promise<{ ok: boolean; reason?: string }> {
  if (state === 'off') return { ok: true };

  // Flip state first: a listener reacting to 'off' (e.g. re-enabling the tray
  // icon) must not observe a stale 'active', and if the OS show() below throws
  // we still want the DOM restore to have been attempted exactly once.
  setState('off');

  const pending = restoreFns;
  restoreFns = [];
  for (const restore of pending) {
    try { restore(); } catch (e) { logger.warn('[PresenterMode] restore handler failed:', e); }
  }

  try {
    if (!opts.windowAlreadyShown) {
      const b = await getBackend();
      await b.show();
    }
    logger.log('[PresenterMode] Exited — GIA visible again');
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('[PresenterMode] Failed to restore window:', e);
    // Last resort: the user must not be left staring at a vanished app.
    try { window.location.reload(); } catch { /* nothing else to try */ }
    return { ok: false, reason: msg };
  }
}

export function isPresenting(): boolean {
  return state === 'active';
}

/** Flip mode, returning the new state. */
export async function togglePresenterMode(): Promise<PresenterState> {
  if (state === 'active') {
    await exitPresenterMode();
    return 'off';
  }
  const res = await enterPresenterMode();
  return res.ok ? 'active' : 'off';
}

/**
 * Briefly reveal GIA without ending presenter mode — for checking something
 * mid-call. The window comes back but the floating chrome stays hidden, so
 * peeking does not put the orb back on a shared screen.
 */
export async function peekPresenter(): Promise<boolean> {
  if (state !== 'active' || !presenterSupported()) return false;
  try {
    const b = await getBackend();
    await b.show();
    return true;
  } catch (e) {
    logger.warn('[PresenterMode] peek failed:', e);
    return false;
  }
}

export async function unpeekPresenter(): Promise<boolean> {
  if (state !== 'active' || !presenterSupported()) return false;
  try {
    const b = await getBackend();
    await b.hide();
    return true;
  } catch (e) {
    logger.warn('[PresenterMode] unpeek failed:', e);
    return false;
  }
}

export function subscribe(fn: Listener): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter(l => l !== fn); };
}

/**
 * Let the tray menu drive presenter mode.
 *
 * This is the safety net, not a convenience. Once the window is hidden there
 * is no in-app control left to restore it, so if the user brings GIA back from
 * the tray we have to put the in-app chrome back too — otherwise the app
 * reappears with a stale 'active' state and no way out of it.
 *
 * Returns a teardown function.
 */
export async function attachTrayBridge(): Promise<() => void> {
  if (!presenterSupported()) return () => {};
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen(PRESENTER_EXIT_EVENT, () => {
      // The window is already visible — only the in-app restore is missing.
      void exitPresenterMode({ windowAlreadyShown: true });
    });
    return unlisten;
  } catch (e) {
    logger.warn('[PresenterMode] tray bridge unavailable:', e);
    return () => {};
  }
}

/**
 * Hide every element that opted in with `data-presenter-hide`, returning a
 * function that puts each one back exactly as it was.
 *
 * This is attribute-driven rather than a hand-maintained list so a new
 * floating surface cannot accidentally ship without presenter coverage: mark
 * the element and it is handled. The body flag lets CSS key off the same
 * state for animated surfaces that cannot be display-toggled.
 */
function hideFloatingChrome(): () => void {
  if (typeof document === 'undefined') return () => {};

  const floating = Array.from(
    document.querySelectorAll<HTMLElement>('[data-presenter-hide]'),
  );
  const previousDisplays = floating.map(el => el.style.display);
  floating.forEach(el => { el.style.display = 'none'; });

  document.body.dataset.presenting = 'true';
  // Surfaces mounted *after* presenter mode started (a late notification, a
  // sheet opened by a timer) would otherwise ignore the snapshot above, so
  // observe for late arrivals and hide them too.
  const observer = new MutationObserver(records => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const targets = node.matches('[data-presenter-hide]')
          ? [node]
          : Array.from(node.querySelectorAll<HTMLElement>('[data-presenter-hide]'));
        for (const el of targets) {
          if (el.dataset.presenterHidden === 'true') continue;
          el.dataset.presenterHidden = 'true';
          el.dataset.presenterPrevDisplay = el.style.display;
          el.style.display = 'none';
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    floating.forEach((el, i) => { el.style.display = previousDisplays[i]; });
    // Anything the observer hid arrived after the snapshot.
    document.querySelectorAll<HTMLElement>('[data-presenter-hidden="true"]').forEach(el => {
      el.style.display = el.dataset.presenterPrevDisplay ?? '';
      delete el.dataset.presenterHidden;
      delete el.dataset.presenterPrevDisplay;
    });
    delete document.body.dataset.presenting;
  };
}

/** Test seam: swap the window-hide backend and reset all state. */
export function __setPresenterBackend(b: PresenterBackend | null) {
  backend = b;
  resolveBackend = null;
}

/** Test seam: return to a clean, off, unlistened state. */
export function __resetPresenterMode() {
  state = 'off';
  listeners = [];
  restoreFns = [];
  backend = null;
  resolveBackend = null;
  if (typeof document !== 'undefined') delete document.body.dataset.presenting;
}
