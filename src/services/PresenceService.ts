/**
 * PresenceService - GIA Cowork only (no mobile equivalent).
 *
 * Wraps the Rust `get_presence` command (src-tauri/src/presence.rs), which
 * reads real screen-lock state via systemd-logind over DBus -- the one
 * lock-state API that's consistent across GNOME, KDE, and most other
 * Linux desktop environments.
 *
 * Scope note: this reports LOCKED / UNLOCKED / UNKNOWN today. It does not
 * yet report keyboard/mouse idle-time (PRESENT vs "unlocked but untouched
 * for 10 minutes") -- that needs X11/Wayland-specific idle detection that
 * hasn't been built yet. Don't infer "the user is actively at the
 * keyboard" from UNLOCKED; it only tells you the screen isn't locked.
 */

export type LockState = 'LOCKED' | 'UNLOCKED' | 'UNKNOWN';

export interface PresenceInfo {
  lockState: LockState;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const presenceService = {
  /** Returns null on non-desktop builds (mobile/web) -- there is no presence signal there. */
  async getPresence(): Promise<PresenceInfo | null> {
    if (!isTauri()) return null;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<{ lock_state: LockState }>('get_presence');
      return { lockState: raw.lock_state };
    } catch (e) {
      console.warn('[PresenceService] get_presence failed:', e);
      return null;
    }
  },
};
