import { registerPlugin, PluginListenerHandle } from '@capacitor/core';
import { isTauri } from '../platform';
import { createOpenWakeWordPlugin } from './wakeWord/openWakeWordPlugin';

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

  /** Last failure reason (e.g. 'wake-word-unavailable:no-wasm'), or null. */
  lastError(): string | null;

  /** Most recent ONNX keyword score, for diagnostics in the settings UI. */
  lastScore(): number;
}

// Desktop wake word. This used to run continuous `SpeechRecognition` and
// substring-match the transcript for "gia" -- which needed a full speech
// recogniser running forever, fired on the word appearing anywhere in any
// sentence, and handed raw microphone audio to a speech service. It is now the
// local openWakeWord ONNX engine, shared with the browser build. If the
// environment cannot run it the plugin no-ops; the wake word is optional,
// never fatal, and the failure reason is available via lastError().
function desktopWakeWordPlugin(defaultKeyword = 'hey gia'): GIAWakeWordPlugin {
  const impl = createOpenWakeWordPlugin(defaultKeyword, (msg) => console.warn(msg));
  return {
    async startListening(opts) {
      await impl.startListening(opts);
    },
    async stopListening() {
      await impl.stopListening();
    },
    async isListening() {
      return impl.isListening();
    },
    async getPendingWakeWord() {
      return impl.getPendingWakeWord();
    },
    async addListener(event, handler) {
      return impl.addListener(event, handler);
    },
    async removeAllListeners() {
      await impl.removeAllListeners();
    },
    lastError() {
      return impl.lastError();
    },
    lastScore() {
      return impl.lastScore();
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
