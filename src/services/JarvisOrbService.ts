import { isTauri } from '../platform';
import { logger } from '../utils/logger';
import { useJarvisStore, type JarvisState } from '../store/useJarvisStore';
import { captureScreenDesktop } from './desktopScreenCapture';
import visionService from './VisionService';
import visionRouter, { type VisionTask } from './vision/VisionRouter';

/**
 * JarvisOrbService — the driver behind the floating "GIA's eyes" orb.
 *
 * Loop (all of it is on-device — screenshots never leave the machine, unless
 * you're using a cloud vision provider: when a local model is missing, the
 * screen capture falls back to the active provider's vision capability — the
 * same provider your chat already uses. Only text ever reaches the brain):
 *   1. SEE    captureScreenDesktop(ambient) at a slow cadence (no window
 *             hide/show, so the orb stays on screen without flicker)
 *   2. THINK  run the local vision models (caption / OCR / objects / classify)
 *             or the provider's vision model, and distill the screen into one
 *             compact text observation
 *   3. FEED   push the observation into the jarvis store → GIA reads it via
 *             the jarvis_look tool and a short "screen awareness" block in her
 *             system context
 *
 * While GIA is acting (automation, headless tools), setActing() flips the orb
 * to 'acting' and triggers an immediate fresh capture AFTER the action so she
 * can verify the result actually landed — the observe → act → verify loop.
 *
 * Ambient cadence is intentionally slow (20s) and pauses while the screen is
 * locked: always-on 3–5s screen recording burns CPU and is exactly the
 * Capture-everything behaviour the industry keeps getting flamed for.
 */

const AMBIENT_INTERVAL_MS = 20_000;
const OBSERVATION_MAX_LEN = 1100;

function truncate(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

interface TaskResult {
  task: VisionTask;
  text: string;
  source: 'local' | 'provider';
  model: string;
}

/**
 * Compose one compact sentence from every task that came back. Tracks whether
 * any of it was answered by the cloud provider (VisionRouter fallback) so the
 * feed can stay honest about where the analysis happened.
 */
function observationFrom(results: TaskResult[]): { text: string; viaProvider: boolean } {
  const parts: string[] = [];
  let viaProvider = false;
  for (const r of results) {
    if (r.source === 'provider') viaProvider = true;
    switch (r.task) {
      case 'caption':
        if (r.text) parts.push(`screen: ${truncate(r.text, 300)}`);
        break;
      case 'ocr':
        if (r.text) parts.push(`on-screen text: ${truncate(r.text, 420)}`);
        break;
      case 'detect':
        if (r.text) parts.push(`objects: ${r.text}`);
        break;
      case 'classify':
        if (r.text) parts.push(`classifies as: ${r.text}`);
        break;
    }
  }
  if (!parts.length) parts.push('nothing legible on screen');
  return { text: truncate(parts.join(' · '), OBSERVATION_MAX_LEN), viaProvider };
}

class JarvisOrbService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs = AMBIENT_INTERVAL_MS;
  private inFlight = false;
  private _enabled = false;
  private _paused = false;
  private _acting = false;
  private _listening = false;
  private _speaking = false;
  private _webCapNoteShown = false;

  get enabled(): boolean {
    return this._enabled;
  }

  private refreshState(): JarvisState {
    const { setState, enabled, paused } = useJarvisStore.getState();
    if (!enabled) return 'off';
    if (paused) return 'idle';
    if (this._speaking) return 'speaking';
    if (this._listening) return 'listening';
    if (this._acting) return 'acting';
    return 'idle';
  }

  private syncStoreState(): void {
    this._enabled = useJarvisStore.getState().enabled;
    this._paused = useJarvisStore.getState().paused;
    useJarvisStore.getState().setState(this.refreshState());
  }

  /**
   * Turn the floating orb on. Real screen-watching needs the desktop (Tauri)
   * shell, but the orb itself — state, voice cues, model readiness, feed — works
   * everywhere, so the web build demos it too. Safe to call repeatedly (idempotent).
   */
  start(opts: { intervalMs?: number } = {}): void {
    if (this.timer) {
      this.updateVisionReadiness();
      return;
    }
    this.intervalMs = opts.intervalMs ?? AMBIENT_INTERVAL_MS;
    useJarvisStore.getState().setEnabled(true);
    useJarvisStore.getState().clearFeed();
    useJarvisStore.getState().pushFeed('info', isTauri()
      ? 'Jarvis eyes online — watching the screen on-device. Nothing leaves this machine.'
      : 'Jarvis eyes online — orb is live. Real screen-watching needs the desktop app; here she tracks her state and model readiness.');
    useJarvisStore.getState().setError(null);
    this.syncStoreState();

    // First look immediately, then settle into the ambient cadence.
    void this.lookNow();
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      if (this._paused) return;
      void this.lookNow();
    }, this.intervalMs);
    logger.log(`[JarvisOrb] started (ambient interval ${this.intervalMs}ms, desktop=${isTauri()})`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    useJarvisStore.getState().setEnabled(false);
    useJarvisStore.getState().setVisionReady({ caption: false, ocr: false, detection: false, classification: false });
    useJarvisStore.getState().setVisionMode('none');
    useJarvisStore.getState().setError(null);
    this._webCapNoteShown = false;
    this.syncStoreState();
    logger.log('[JarvisOrb] stopped');
  }

  /** One-shot look — used by jarvis_look and after actions. Works even while disabled. */
  async lookNow(): Promise<boolean> {
    if (!isTauri()) {
      this.updateVisionReadiness();
      const store = useJarvisStore.getState();
      if (!this._webCapNoteShown) {
        store.pushFeed(
          'info',
          'Screen capture is desktop-only — in the browser GIA reports her vision models' +
          ` readiness (${['caption', 'ocr', 'detection'].filter((k) => (store.visionReady as Record<string, boolean>)[k]).length || 0}/3) but can't reach the OS screen.`
        );
        this._webCapNoteShown = true;
      }
      return false;
    }
    if (this.inFlight) return false;
    this.inFlight = true;
    const store = useJarvisStore.getState();
    this.updateVisionReadiness();
    const ready = store.visionReady;

    try {
      store.setState('seeing');
      const dataUrl = await captureScreenDesktop({ ambient: true });
      if (!dataUrl) {
        store.pushFeed('error', 'Screen capture unavailable — cannot see the desktop.');
        return false;
      }

      store.setState('thinking');

      // Prefer the local ONNX models; when one isn't loaded, VisionRouter falls
      // back to the active provider's vision capability (e.g. GPT-4o / Gemini /
      // Claude) so the orb works with the vision model you already configured.
      const wanted: VisionTask[] = [];
      if (ready.caption) wanted.push('caption');
      if (ready.ocr) wanted.push('ocr');
      if (ready.detection) wanted.push('detect');
      if (ready.classification) wanted.push('classify');
      if (!wanted.length) wanted.push('caption'); // best effort via provider vision

      const results: TaskResult[] = [];
      for (const task of wanted) {
        try {
          const r = await visionRouter.processImage(dataUrl, task);
          const text = typeof r.result === 'string'
            ? r.result
            : Array.isArray((r.result as { objects?: { label: string }[] })?.objects)
              ? [...new Set((r.result as { objects: { label: string }[] }).objects.map((o) => o.label))].slice(0, 12).join(', ')
              : String(r.result ?? '');
          results.push({ task, text, source: r.source, model: r.modelUsed });
        } catch {
          // one task failing is not fatal
        }
      }

      if (!results.length) {
        store.pushFeed(
          'info',
          'Could not analyze the screen — no local vision models loaded and the active provider has no vision support.'
        );
        store.setState(this.refreshState());
        return false;
      }

      const { text: observation, viaProvider } = observationFrom(results);
      store.setObservation(observation);
      const providerModel = viaProvider
        ? (results.find((r) => r.source === 'provider')?.model ?? 'vision model')
        : null;
      store.setVisionMode(viaProvider ? 'cloud' : 'local', providerModel);
      const srcNote = viaProvider
        ? ` (via ${providerModel})`
        : ' (on-device)';
      store.pushFeed(
        this._acting ? 'verify' : 'observation',
        this._acting ? `after action${srcNote}: ${observation}` : `looking${srcNote}: ${observation}`
      );
      store.setState(this.refreshState());
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('[JarvisOrb] look failed:', msg);
      store.pushFeed('error', `Vision failed: ${msg}`);
      store.setError(msg);
      store.setState(this.refreshState());
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * GIA is about to execute an action on the desktop. Marks the orb 'acting'
   * and, once the action completes (setActing(false)), takes an immediate
   * fresh look so she sees whether the result actually landed.
   */
  setActing(acting: boolean): void {
    if (this._acting === acting) return;
    this._acting = acting;
    if (acting) {
      useJarvisStore.getState().pushFeed('acting', 'acting on the desktop');
    }
    this.syncStoreState();
    if (!acting && this._enabled) {
      // Verify the outcome — observe → act → verify.
      void this.lookNow();
    }
  }

  setSpeaking(speaking: boolean): void {
    if (this._speaking === speaking) return;
    this._speaking = speaking;
    this.syncStoreState();
  }

  /** The user just called GIA by voice (wake word / push-to-talk) — the orb lights up listening. */
  setListening(listening: boolean): void {
    if (this._listening === listening) return;
    this._listening = listening;
    if (this._enabled) {
      if (listening) useJarvisStore.getState().pushFeed('info', 'called by voice — listening');
      this.syncStoreState();
    } else {
      // Eyes off but GIA was still "called" — the dim orb lights up green so
      // there's a visible "she heard you" cue, then returns to off.
      useJarvisStore.getState().setState(listening ? 'listening' : 'off');
    }
  }

  /**
   * One bridge for the voice UI phases (VoiceMode / useVoiceControl):
   * maps the assistant's own voice state machine onto the orb.
   */
  setVoice(phase: 'idle' | 'listening' | 'thinking' | 'speaking'): void {
    this._listening = phase === 'listening';
    this._speaking = phase === 'speaking';
    if (!this._enabled) {
      useJarvisStore.getState().setState(phase === 'idle' ? 'off' : phase);
      return;
    }
    if (phase === 'thinking' && this._enabled) {
      useJarvisStore.getState().setState('thinking');
      return;
    }
    this.syncStoreState();
  }

  /** Pause the ambient loop while the screen is locked (presence loop calls this). */
  setPaused(paused: boolean): void {
    useJarvisStore.getState().setPaused(paused);
    this._paused = paused;
    this.syncStoreState();
    if (paused) {
      useJarvisStore.getState().pushFeed('info', 'screen locked — eyes paused');
    } else {
      useJarvisStore.getState().pushFeed('info', 'screen unlocked — eyes resumed');
      void this.lookNow();
    }
  }

  getLatestObservation(): { text: string; at: number | null } {
    const s = useJarvisStore.getState();
    return { text: s.observation, at: s.lastSeenAt };
  }

  private updateVisionReadiness(): void {
    useJarvisStore.getState().setVisionReady({
      caption: visionService.isCaptionReady(),
      ocr: visionService.isOCRReady(),
      detection: visionService.isDetectionReady(),
      classification: visionService.isClassificationReady(),
    });
  }
}

const jarvisOrbService = new JarvisOrbService();

export { jarvisOrbService };