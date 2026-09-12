import { create } from 'zustand';

/**
 * Jarvis ("GIA's eyes") — the floating-orb screen-awareness layer.
 *
 * The floating orb is the desktop counterpart of the Android Screen Orb
 * (GIAScreenAgent.showOrb): a persistent on-screen avatar that stays visible
 * and keeps GIA grounded in what is actually happening on the desktop. When
 * the jarvisEyes flag is on, the orb driver (JarvisOrbService) captures the
 * screen on a slow ambient cadence, runs it through the vision pipeline, and
 * distills what she sees into a compact text observation — which is the ONLY
 * thing that ever reaches the brain. Analysis is on-device when the local
 * models are loaded; if they aren't, the capture falls back to the active
 * provider's vision capability (your chat provider), so the orb still sees.
 * While GIA acts (headless tools, automation, commands), the state flips to
 * 'acting' and an immediate pre/post capture lets her verify the result — the
 * classic perceive → act → verify loop.
 */

export type JarvisState =
  | 'off'      // flag disabled — orb shows dim, everything paused
  | 'idle'     // enabled, breathing slowly, nothing happening
  | 'listening' // the user called GIA by voice / a wake word was heard
  | 'seeing'   // capturing + running vision models on a screen
  | 'thinking' // an observation is being distilled into the feed
  | 'acting'   // GIA is executing an action on the desktop
  | 'speaking' // TTS audio is playing

export type JarvisFeedKind = 'observation' | 'acting' | 'verify' | 'error' | 'info';

export interface JarvisFeedItem {
  id: string;
  kind: JarvisFeedKind;
  text: string;
  at: number;
}

export interface VisionReadiness {
  caption: boolean;
  ocr: boolean;
  detection: boolean;
  classification: boolean;
}

interface JarvisStoreState {
  enabled: boolean;
  paused: boolean;
  state: JarvisState;
  visionReady: VisionReadiness;
  /** Latest distilled "what GIA sees" — text only, produced on-device. */
  observation: string;
  /** Whether the latest look was answered by on-device models or the cloud vision-capable provider. */
  visionMode: 'local' | 'cloud' | 'none';
  /** Provider/model id when visionMode === 'cloud' (e.g. "openai/gpt-4o"). */
  visionSource: string | null;
  lastSeenAt: number | null;
  feed: JarvisFeedItem[];
  error: string | null;

  setEnabled: (enabled: boolean) => void;
  setPaused: (paused: boolean) => void;
  setState: (state: JarvisState) => void;
  setVisionReady: (ready: VisionReadiness) => void;
  setVisionMode: (mode: 'local' | 'cloud' | 'none', source?: string | null) => void;
  setObservation: (text: string, at?: number) => void;
  pushFeed: (kind: JarvisFeedKind, text: string) => void;
  setError: (err: string | null) => void;
  clearFeed: () => void;
}

const MAX_FEED = 16;

let feedSeq = 0;

export const useJarvisStore = create<JarvisStoreState>((set, get) => ({
  enabled: false,
  paused: false,
  state: 'off',
  visionReady: { caption: false, ocr: false, detection: false, classification: false },
  observation: '',
  visionMode: 'none',
  visionSource: null,
  lastSeenAt: null,
  feed: [],
  error: null,

  setEnabled: (enabled) =>
    set({ enabled, state: enabled ? (get().state === 'off' ? 'idle' : get().state) : 'off' }),

  setPaused: (paused) => set({ paused }),

  setState: (state) => set({ state }),

  setVisionReady: (ready) => set({ visionReady: ready }),

  setVisionMode: (mode, source = null) => set({ visionMode: mode, visionSource: source }),

  setObservation: (text, at) =>
    set({ observation: text, lastSeenAt: at ?? Date.now() }),

  pushFeed: (kind, text) => {
    const item: JarvisFeedItem = { id: `jarvis-${++feedSeq}`, kind, text, at: Date.now() };
    set({ feed: [item, ...get().feed].slice(0, MAX_FEED) });
  },

  setError: (error) => set({ error }),

  clearFeed: () => set({ feed: [] }),
}));