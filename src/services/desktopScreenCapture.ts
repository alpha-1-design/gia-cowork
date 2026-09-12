// Desktop screen capture for GIA Cowork (Linux / Tauri).
//
// On desktop we have a REAL OS primitive: the Rust `screen_capture` command
// (X11 + Wayland via portals). We prefer that over the web Screen Capture API
// because it captures the whole desktop without a user "pick a window" prompt
// and doesn't require the Chromium getDisplayMedia permission flow. The web
// path remains as a fallback for non-Tauri browsers.

import { isTauri } from '../platform';

export interface CaptureScreenOptions {
  /**
   * Ambient (always-on jarvis-eyes) capture: skip hiding GIA's own window
   * before the screenshot and showing it again afterwards. One-shot captures
   * hide/show so the desktop isn't photoshopped over GIA itself, but doing
   * that on a repeating timer makes the whole UI flash. Ambient capture may
   * include GIA in the shot — acceptable for eye candy; the analysis still
   * describes the actual desktop.
   */
  ambient?: boolean;
}

/**
 * Capture the current screen and return a PNG data URL, or null if capture is
 * unavailable or the user cancels. Fully wrapped so a missing/denied API never
 * crashes the app.
 */
export async function captureScreenDesktop(opts: CaptureScreenOptions = {}): Promise<string | null> {
  if (isTauri()) {
    let hidden = false;
    if (!opts.ambient) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        // Hide GIA's own window first so captures show the desktop, not a
        // screenshot of GIA screenshotting itself.
        try {
          hidden = await invoke<boolean>('hide_for_capture');
        } catch {
          // Not fatal — capture may still be useful.
        }
      } catch {
        // Native window control unavailable — keep going.
      }
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<{ dataUrl: string; width: number; height: number }>(
        'screen_capture'
      );
      if (res?.dataUrl) return res.dataUrl;
    } catch {
      // Native capture unavailable (e.g. no display server) — fall back.
    } finally {
      if (hidden && !opts.ambient) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('show_after_capture');
        } catch {
          // Nothing we can do if the window can't be restored.
        }
      }
    }
  }
  return webCapture();
}

async function webCapture(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
    return null;
  }
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    if (!track) return null;

    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    return canvas.toDataURL('image/png');
  } catch {
    return null;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}
