import type { PluginListenerHandle } from '@capacitor/core';
import type { GIAOverlayPlugin } from './GIAOverlay';
import { isTauri } from '../platform';

type OverlayHandler = (result: { dataUrl?: string; text?: string; cancelled?: boolean }) => void;
type ListenerMap = Map<string, Array<OverlayHandler>>;

export class GIAOverlayWeb implements GIAOverlayPlugin {
  private listeners: ListenerMap = new Map();

  // On desktop the floating overlay is a native Tauri window (needs a Rust
  // command), and on plain web it is unsupported. We degrade gracefully
  // instead of throwing — but log honestly so a desktop build never looks
  // like it "works" when it isn't showing anything. Circle-to-search itself
  // still works via screen capture.
  async startOverlay(): Promise<void> {
    if (isTauri()) {
      console.warn('[GIAOverlay] Floating overlay requires an Android build — circle-to-search still works via screen capture.');
    }
    return;
  }

  async hideOverlay(): Promise<void> {
  }

  async isOverlayVisible(): Promise<{ visible: boolean }> {
    return { visible: false };
  }

  addListener(
    eventName: 'overlayResult',
    handler: (result: { dataUrl?: string; text?: string; cancelled?: boolean }) => void,
  ): Promise<PluginListenerHandle> {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, []);
    }
    this.listeners.get(eventName)!.push(handler);
    return Promise.resolve({
      remove: () => {
        const arr = this.listeners.get(eventName);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx !== -1) arr.splice(idx, 1);
        }
        return Promise.resolve();
      },
    });
  }

  async removeAllListeners(): Promise<void> {
    this.listeners.clear();
  }
}
