import { registerPlugin, PluginListenerHandle } from '@capacitor/core';
import { isTauri } from '../platform';

export interface GIAIntentPlugin {
  getPendingIntent(): Promise<{ action?: string; hasData?: boolean; text?: string; mimeType?: string; uri?: string; widgetAction?: string }>;
  clearIntent(): Promise<void>;
  addListener(eventName: 'onAssist', handler: (data: { source: string; type: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'onDeepLink', handler: (data: { type: string; uri: string; scheme: string; host: string; path: string; query: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'onShareReceived', handler: (data: { type: string; mimeType: string; text?: string; subject?: string; imageUri?: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'onWidgetAction', handler: (data: { action: string }) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

// Desktop deep-link handling: the Tauri deep-link plugin emits a
// `deep-link://new-url` event whenever the OS hands GIA a URL (e.g. a
// gia:// scheme registered at package time). We surface that as the
// onDeepLink intent. Assist / share / widget intents are Android-only and
// simply no-op on desktop.
function desktopIntentPlugin(): GIAIntentPlugin {
  const deepHandlers = new Set<(d: { type: string; uri: string; scheme: string; host: string; path: string; query: string }) => void>();
  let unlisten: (() => void) | null = null;

  const ensureListener = async () => {
    if (unlisten) return;
    const { listen } = await import('@tauri-apps/api/event');
    unlisten = await listen<string | string[]>('deep-link://new-url', (e) => {
      const urls = Array.isArray(e.payload) ? e.payload : [e.payload];
      const uri = urls[0];
      if (!uri) return;
      let parsed: { type: string; uri: string; scheme: string; host: string; path: string; query: string };
      try {
        const u = new URL(uri);
        parsed = {
          type: 'deep-link',
          uri,
          scheme: u.protocol.replace(':', ''),
          host: u.host,
          path: u.pathname,
          query: u.search,
        };
      } catch {
        parsed = { type: 'deep-link', uri, scheme: '', host: '', path: '', query: '' };
      }
      deepHandlers.forEach((h) => h(parsed));
    });
  };

  return {
    async getPendingIntent() {
      return {};
    },
    async clearIntent() {},
    async addListener(eventName, handler) {
      if (eventName === 'onDeepLink') {
        deepHandlers.add(
          handler as (d: { type: string; uri: string; scheme: string; host: string; path: string; query: string }) => void,
        );
        void ensureListener();
        return {
          remove: () => {
            deepHandlers.delete(
              handler as (d: { type: string; uri: string; scheme: string; host: string; path: string; query: string }) => void,
            );
            return Promise.resolve();
          },
        };
      }
      return { remove: () => Promise.resolve() };
    },
    async removeAllListeners() {
      deepHandlers.clear();
    },
  };
}

const GIAIntent = registerPlugin<GIAIntentPlugin>('GIAIntent', {
  web: () => {
    if (isTauri()) return Promise.resolve(desktopIntentPlugin());
    return import('./GIAIntent.web').then((m) => m.GIAIntentWeb);
  },
});

export { GIAIntent };
