// Real OS input injection for GIA Cowork desktop (Linux / Tauri).
//
// Backed by the Rust `enigo` commands in src-tauri/src/screen.rs. This is the
// "control the screen" half of computer-use: click, double-click, right-click,
// drag, type, key, scroll. On non-Tauri browsers every call is a no-op so the
// UI never hard-fails.

import { isTauri } from '../platform';

async function invokeScreen<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch (e) {
    console.warn(`[screenControl] ${cmd} failed:`, e);
    return null;
  }
}

export interface CapturedArea {
  dataUrl: string;
  width: number;
  height: number;
}

export const screenControl = {
  tap: (x: number, y: number) => invokeScreen('screen_tap', { x, y }),
  doubleTap: (x: number, y: number) => invokeScreen('screen_double_tap', { x, y }),
  rightTap: (x: number, y: number) => invokeScreen('screen_right_tap', { x, y }),
  drag: (fromX: number, fromY: number, toX: number, toY: number) =>
    invokeScreen('screen_drag', { fromX, fromY, toX, toY }),
  typeText: (text: string) => invokeScreen('screen_type_text', { text }),
  key: (key: string) => invokeScreen('screen_key', { key }),
  scroll: (dx: number, dy: number) => invokeScreen('screen_scroll', { dx, dy }),
  captureArea: (x: number, y: number, width: number, height: number) =>
    invokeScreen<CapturedArea>('screen_capture_area', { x, y, width, height }),
};
