import { registerPlugin, PluginListenerHandle } from '@capacitor/core';
import { isTauri } from '../platform';

export interface GIAWakeWordPlugin {
  startListening(options?: {
    accessKey?: string;
    keyword?: string;
    sensitivity?: number;
    customModelPath?: string;
  }): Promise<void>;

  stopListening(): Promise<void>;

  isListening(): Promise<{ listening: boolean }>;

  getPendingWakeWord(): Promise<{ detected: boolean; keyword: string }>;

  addListener(
    eventName: 'wakeWordDetected',
    handler: (result: { keyword: string }) => void
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}

// Desktop alternative to a native Porcupine wake-word engine: continuous Web
// Speech recognition that watches for a keyword. Requires the SpeechRecognition
// API (Chromium-based webviews) and microphone permission. If unavailable, the
// plugin simply no-ops — the wake word is optional, never fatal.
function desktopWakeWordPlugin(defaultKeyword = 'gia'): GIAWakeWordPlugin {
  const SR: any =
    (typeof window !== 'undefined' && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;
  const handlers = new Set<(r: { keyword: string }) => void>();
  let listening = false;
  let recognition: any = null;

  return {
    async startListening(opts) {
      if (!SR) return;
      const keyword = (opts?.keyword || defaultKeyword).toLowerCase();
      recognition = new SR();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      recognition.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const transcript = String(e.results[i][0].transcript).toLowerCase();
          if (transcript.includes(keyword)) {
            handlers.forEach((h) => h({ keyword }));
          }
        }
      };
      recognition.onerror = () => {};
      recognition.onend = () => {
        if (listening && recognition) {
          try {
            recognition.start();
          } catch {
            /* ignore restart failures */
          }
        }
      };
      listening = true;
      try {
        recognition.start();
      } catch {
        /* already started */
      }
    },
    async stopListening() {
      listening = false;
      try {
        recognition?.stop();
      } catch {
        /* ignore */
      }
    },
    async isListening() {
      return { listening };
    },
    async getPendingWakeWord() {
      return { detected: false, keyword: '' };
    },
    async addListener(_event, handler) {
      handlers.add(handler);
      return { remove: () => { handlers.delete(handler); return Promise.resolve(); } };
    },
    async removeAllListeners() {
      handlers.clear();
    },
  };
}

const GIAWakeWord = registerPlugin<GIAWakeWordPlugin>('GIAWakeWord', {
  web: () => {
    if (isTauri()) return Promise.resolve(desktopWakeWordPlugin());
    return import('./GIAWakeWord.web').then(m => m.GIAWakeWordWeb);
  },
});

export { GIAWakeWord };
