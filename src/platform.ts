// Desktop-first platform detection for GIA Cowork.
//
// The app reuses the gia-app (mobile/Android) codebase, so a lot of code was
// written against Capacitor + native Android. This module is the single source
// of truth for "what environment are we actually in" so those features can
// branch to a real desktop (Tauri / Linux) implementation instead of silently
// calling Android-only plugins that don't exist here.

/** True when running inside the Tauri shell (the real GIA Cowork desktop app). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** True when running as a bundled Capacitor native app (Android/iOS). */
export function isCapacitorNative(): boolean {
  try {
    const C = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    return !!C && typeof C.isNativePlatform === 'function' && C.isNativePlatform();
  } catch {
    return false;
  }
}

/** True when running in a plain browser (not Tauri, not a native shell). */
export function isWeb(): boolean {
  return typeof window !== 'undefined' && !isTauri() && !isCapacitorNative();
}

/** GIA Cowork is, first and foremost, a desktop app. */
export const isDesktop = isTauri();
export const isMobile = isCapacitorNative();
