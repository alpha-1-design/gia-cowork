import { registerPlugin, PluginListenerHandle } from '@capacitor/core';
import { isTauri } from '../platform';
import { logger } from '../utils/logger';
import { captureScreenDesktop } from './desktopScreenCapture';
import { screenControl } from './screenControl';

export interface ScreenElement {
  type: string;
  text: string;
  className: string;
  contentDescription?: string;
  clickable: boolean;
  longClickable: boolean;
  focusable: boolean;
  editable: boolean;
  scrollable: boolean;
  depth: number;
  bounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  };
}

export interface ScreenCaptureResult {
  screenshotPath?: string;
  text: string;
  elementCount: number;
  elements: ScreenElement[];
  timestamp: number;
}

export interface ScreenAgentPlugin {
  capture(): Promise<ScreenCaptureResult>;
  getScreenContent(): Promise<ScreenCaptureResult>;
  getAccessibilityTree(): Promise<{ tree: string; timestamp: number }>;
  performTap(options: { x: number; y: number }): Promise<void>;
  tapText(options: { text: string }): Promise<{ clicked: boolean; foundOn: string; bounds: ScreenElement['bounds'] }>;
  startWatching(options?: { intervalMs?: number }): Promise<void>;
  stopWatching(): Promise<void>;

  /** Show the floating GIA orb overlay */
  showOrb(): Promise<void>;
  /** Hide the floating GIA orb overlay */
  hideOrb(): Promise<void>;
  /** Get orb status */
  isOrbShowing(): Promise<{ showing: boolean; size: number }>;
  /** Set orb size in dp */
  setOrbSize(options: { size: number }): Promise<void>;

  addListener(eventName: string, handler: (result: Record<string, unknown>) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

function desktopScreenAgentPlugin(): ScreenAgentPlugin {
  return {
    async capture() {
      const dataUrl = await captureScreenDesktop();
      return {
        screenshotPath: undefined,
        text: '',
        elementCount: 0,
        elements: [],
        timestamp: Date.now(),
        ...(dataUrl ? { screenshotPath: dataUrl } : {}),
      } as ScreenCaptureResult;
    },
    async getScreenContent() {
      return this.capture();
    },
    async getAccessibilityTree() {
      return { tree: '', timestamp: Date.now() };
    },
    async performTap(options: { x: number; y: number }) {
      await screenControl.tap(options.x, options.y);
    },
    async tapText() {
      // Desktop has no Android view-tree to resolve text → coordinates. The
      // real primitive is performTap(x, y); expose that instead. Returning
      // "not found" is honest rather than faking a tap on the wrong spot.
      return { clicked: false, foundOn: 'desktop', bounds: {} as ScreenElement['bounds'] };
    },
    async startWatching() {
      // Android accessibility-tree watch — desktop uses one-shot captures.
    },
    async stopWatching() {},
    async showOrb() {
      logger.warn('[GIAScreenAgent] The floating orb overlay is an Android feature — not available on the desktop app.');
    },
    async hideOrb() {},
    async isOrbShowing() {
      return { showing: false, size: 0 };
    },
    async setOrbSize() {
      logger.warn('[GIAScreenAgent] Orb sizing is an Android feature — not available on the desktop app.');
    },
    async addListener() {
      return { remove: () => {} } as PluginListenerHandle;
    },
    async removeAllListeners() {},
  };
}

const GIAScreenAgent = registerPlugin<ScreenAgentPlugin>('GIAScreenAgent', {
  web: () => {
    if (isTauri()) return Promise.resolve(desktopScreenAgentPlugin());
    return import('./GIAScreenAgent.web').then(m => m.GIAScreenAgentWeb);
  },
});

export { GIAScreenAgent };
