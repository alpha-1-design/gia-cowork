import { registerPlugin } from '@capacitor/core';
import { isTauri } from '../platform';

export interface GIAMediaPlugin {
  play(options: { path: string; title?: string; artist?: string; albumId?: number }): Promise<void>;
  playUri(options: { uri: string }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  seekTo(options: { position: number }): Promise<void>;
  getStatus(): Promise<{ isPlaying: boolean; currentPosition: number; duration: number; isRunning: boolean }>;
  listSongs(): Promise<{ songs: Array<{ path: string; title: string; artist: string; album: string; duration: number }>; count: number }>;
  searchSongs(options: { query: string }): Promise<{ songs: Array<{ path: string; title: string; artist: string; album: string; duration: number }>; count: number }>;
}

// Desktop alternative to Android media control: wire into the Media Session API
// so the OS media keys / tray can show GIA's now-playing metadata. We can't
// manage a device music library on desktop, so list/search return empty. A full
// desktop player would be a Tauri command + MPRIS bridge — out of scope here.
function desktopMediaPlugin(): GIAMediaPlugin {
  const ms: any = typeof navigator !== 'undefined' ? (navigator as any).mediaSession : null;
  return {
    async play({ title, artist }) {
      if (ms && typeof MediaMetadata !== 'undefined') {
        ms.metadata = new MediaMetadata({ title, artist: artist || 'GIA' });
      }
    },
    async playUri() {},
    async pause() {
      if (ms) ms.playbackState = 'paused';
    },
    async resume() {
      if (ms) ms.playbackState = 'playing';
    },
    async stop() {
      if (ms) ms.playbackState = 'none';
    },
    async seekTo() {},
    async getStatus() {
      return { isPlaying: false, currentPosition: 0, duration: 0, isRunning: false };
    },
    async listSongs() {
      return { songs: [], count: 0 };
    },
    async searchSongs() {
      return { songs: [], count: 0 };
    },
  };
}

const GIAMedia = registerPlugin<GIAMediaPlugin>('GIAMedia', {
  web: () => {
    if (isTauri()) return Promise.resolve(desktopMediaPlugin());
    return import('./GIAMedia.web').then(m => m.GIAMediaWeb);
  },
});

export { GIAMedia };
