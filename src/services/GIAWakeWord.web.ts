import type { PluginListenerHandle } from '@capacitor/core';
import { createOpenWakeWordPlugin, type StartOptions } from './wakeWord/openWakeWordPlugin';

/**
 * Browser wake word. This used to be a stub that only logged a warning, which
 * meant the wake-word toggle did nothing at all on the web build. It is now the
 * same local openWakeWord engine the desktop app uses -- no cloud access key,
 * no speech recogniser, no audio leaving the machine.
 */
export class GIAWakeWordWeb {
  private readonly inner = createOpenWakeWordPlugin('hey gia', (msg) => console.warn(msg));

  startListening(options?: StartOptions): Promise<void> {
    return this.inner.startListening(options);
  }

  stopListening(): Promise<void> {
    return this.inner.stopListening();
  }

  isListening(): Promise<{ listening: boolean }> {
    return this.inner.isListening();
  }

  getPendingWakeWord(): Promise<{ detected: boolean; keyword: string }> {
    return this.inner.getPendingWakeWord();
  }

  addListener(
    _eventName: 'wakeWordDetected',
    handler: (result: { keyword: string }) => void,
  ): Promise<PluginListenerHandle> {
    return this.inner.addListener('wakeWordDetected', handler);
  }

  removeAllListeners(): Promise<void> {
    return this.inner.removeAllListeners();
  }

  lastError(): string | null {
    return this.inner.lastError();
  }

  lastScore(): number {
    return this.inner.lastScore();
  }
}