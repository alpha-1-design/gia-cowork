/**
 * Live audio amplitude.
 *
 * The orb used to signal state purely by swapping colour. Reading the design
 * guidance on ambient assistants, that is the weakest possible signal: colour
 * alone cannot distinguish "hearing you" from "talking", and it cannot tell
 * you anything about *how loud*. Real amplitude lets the orb breathe with the
 * room, and lets listening and speaking move in opposite directions so they
 * are distinguishable without colour at all.
 *
 * When no stream is attached there is nothing real to measure, so the service
 * falls back to a synthesised envelope rather than returning a flat zero —
 * a dead orb reads as broken, and the fallback is clearly marked as synthetic
 * so callers can never mistake it for a real measurement.
 */

export type AudioLevelSource = 'microphone' | 'output' | 'synthetic';

type Listener = (level: number, source: AudioLevelSource) => void;

/** Exponential smoothing — raw RMS jitters far too much to drive animation. */
const SMOOTHING = 0.72;

class AudioLevel {
  private listeners = new Set<Listener>();
  private analyser: AnalyserNode | null = null;
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private raf = 0;
  private data: Uint8Array | null = null;

  private current = 0;
  private src: AudioLevelSource = 'synthetic';
  private syntheticT = 0;

  /**
   * Attach to a real stream (microphone, or TTS output via a MediaStream
   * destination). Falls back to the synthetic envelope if the browser refuses
   * — an orb that quietly keeps working beats one that stops.
   */
  attachStream(stream: MediaStream | null, source: AudioLevelSource = 'microphone'): void {
    this.detachStream();
    if (!stream || stream.getAudioTracks().length === 0) {
      this.src = 'synthetic';
      return;
    }
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) { this.src = 'synthetic'; return; }
      this.audioCtx = this.audioCtx ?? new Ctor();
      if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();

      this.stream = stream;
      this.source = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      // Small window: a long one smears transients and makes the orb lag the
      // voice, which reads as unsynchronised rather than responsive.
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.5;
      this.source.connect(this.analyser);
      this.data = new Uint8Array(this.analyser.frequencyBinCount);
      this.src = source;
      this.start();
    } catch {
      // Mic in use by another app, or no audio device — carry on synthetically.
      this.src = 'synthetic';
    }
  }

  /** Real microphone level from an existing getUserMedia stream. */
  attachMicrophone(stream: MediaStream): void {
    this.attachStream(stream, 'microphone');
  }

  detachStream(): void {
    try { this.source?.disconnect(); } catch { /* already gone */ }
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch { /* nothing to stop */ }
    this.analyser = null;
    this.source = null;
    this.stream = null;
    this.data = null;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.current = 0;
  }

  private start(): void {
    if (this.raf) return;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      const raw = this.read();
      this.current = this.current * SMOOTHING + raw * (1 - SMOOTHING);
      for (const l of [...this.listeners]) {
        try { l(this.current, this.src); } catch { /* a bad listener must not stop the loop */ }
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  private read(): number {
    if (this.analyser && this.data) {
      this.analyser.getByteTimeDomainData(this.data as Uint8Array<ArrayBuffer>);
      // RMS around the 128 midpoint — the standard cheap level estimate.
      let sum = 0;
      for (let i = 0; i < this.data.length; i++) {
        const v = (this.data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / this.data.length);
      // Perceptual curve: a linear RMS makes normal speech look tiny.
      return Math.min(1, Math.pow(rms * 3.2, 0.65));
    }

    // Synthetic envelope — two detuned sines so it never looks like a loop.
    this.syntheticT += 0.045;
    const v = (Math.sin(this.syntheticT) + Math.sin(this.syntheticT * 1.7) * 0.5) / 1.5;
    return Math.min(1, Math.max(0, (v + 1) / 2) * 0.35);
  }

  get level(): number { return this.current; }
  get sourceKind(): AudioLevelSource { return this.src; }

  /** Subscribe to the smoothed level. Returns an unsubscribe function. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    this.start();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0 && !this.analyser) {
        if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
      }
    };
  }
}

export const audioLevel = new AudioLevel();

/**
 * Map a 0–1 level onto an orb scale factor.
 *
 * Listening shrinks toward the speaker (turn ownership moves inward), speaking
 * expands with output. Opposing directions is what makes the two states
 * distinguishable without relying on hue at all.
 */
export function scaleForLevel(level: number, mode: 'listening' | 'speaking' | 'idle'): number {
  const l = Math.max(0, Math.min(1, level));
  if (mode === 'listening') return 1 - l * 0.18;
  if (mode === 'speaking') return 1 + l * 0.26;
  return 1 + l * 0.03;
}