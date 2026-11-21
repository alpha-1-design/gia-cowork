import { describe, it, expect } from 'vitest';
import { HysteresisVAD, EnergyVAD } from '../vad';

/** Frames of constant pseudo-probability via a fixed-valued probability fn. */
function makeVAD(values: number[], cfg?: { onsetThreshold?: number; offsetThreshold?: number; offsetFrames?: number }) {
  let i = 0;
  return new HysteresisVAD(() => values[i++] ?? values[values.length - 1], cfg);
}

describe('HysteresisVAD — conversation endpointing', () => {
  it('requires onsetFrames consecutive speech frames before speechStart', () => {
    const vad = makeVAD([0.7, 0.7, 0.7]);
    const f1 = vad.feed(new Float32Array(1280));
    expect(f1.speechStart).toBe(false);
    const f2 = vad.feed(new Float32Array(1280)); // 2nd frame at 0.6 default threshold
    expect(f2.speechStart).toBe(true);
    expect(f2.active).toBe(true);
  });

  it('a single loud frame does not start speech (click rejection)', () => {
    const vad = makeVAD([0.9, 0.1, 0.1, 0.1, 0.9, 0.9]);
    const d1 = vad.feed(new Float32Array(1280)); // 0.9 → onset 1/2
    expect(d1.speechStart).toBe(false);
    const d2 = vad.feed(new Float32Array(1280)); // 0.1 → counter resets
    expect(d2.speechStart).toBe(false);
    const d3 = vad.feed(new Float32Array(1280)); // 0.1
    expect(d3.speechStart).toBe(false);
    const d4 = vad.feed(new Float32Array(1280)); // 0.1
    expect(d4.speechStart).toBe(false);
    const d5 = vad.feed(new Float32Array(1280)); // 0.9 → onset 1/2 again
    expect(d5.speechStart).toBe(false);
    const d6 = vad.feed(new Float32Array(1280)); // 0.9 → onset 2/2 → START
    expect(d6.speechStart).toBe(true);
  });

  it('holds through breathy pauses (0.35–0.6 band does not count toward offset)', () => {
    const vad = makeVAD([0.7, 0.7, 0.5, 0.5, 0.5, 0.5, 0.5, 0.7]);
    vad.feed(new Float32Array(1280));
    const start = vad.feed(new Float32Array(1280));
    expect(start.speechStart).toBe(true);
    // Five breathy frames: offset counter must not advance.
    for (let i = 0; i < 5; i++) {
      const d = vad.feed(new Float32Array(1280));
      expect(d.active).toBe(true);
      expect(d.speechEnd).toBe(false);
    }
  });

  it('ends speech after offsetFrames silent frames', () => {
    const vad = makeVAD([...Array(3).fill(0.7), ...Array(6).fill(0.1)]);
    vad.feed(new Float32Array(1280));
    vad.feed(new Float32Array(1280));
    vad.feed(new Float32Array(1280)); // speech fully established
    let ended = false;
    for (let i = 0; i < 5; i++) {
      const d = vad.feed(new Float32Array(1280));
      if (d.speechEnd) ended = true;
    }
    expect(ended).toBe(true);
  });

  it('barge-in mode raises the onset threshold and frame count', () => {
    const vad = new HysteresisVAD(() => 0.65);
    vad.feed(new Float32Array(1280)); // 1/2 at 0.6 → would start
    vad.setBargeInMode(true);        // threshold now 0.7, needs 3 frames
    const d = vad.feed(new Float32Array(1280)); // 0.65 < 0.7 → no onset
    expect(d.speechStart).toBe(false);
    expect(d.active).toBe(false);
  });

  it('reset clears active speech', () => {
    const vad = makeVAD([0.9, 0.9, 0.1, 0.9, 0.9]);
    vad.feed(new Float32Array(1280)); // 1/2
    vad.feed(new Float32Array(1280)); // 2/2 → active
    vad.reset();
    const d1 = vad.feed(new Float32Array(1280)); // 0.1 after reset
    expect(d1.speechStart).toBe(false);
    const d2 = vad.feed(new Float32Array(1280)); // 0.9 → onset 1/2 again
    expect(d2.speechStart).toBe(false);
    const d3 = vad.feed(new Float32Array(1280)); // 0.9 → 2/2 → fresh START
    expect(d3.speechStart).toBe(true);
  });
});

describe('EnergyVAD — RMS fallback', () => {
  it('detects sustained loud speech and quiet recovery', () => {
    const vad = new EnergyVAD({ onsetThreshold: 0.6, offsetFrames: 5 });
    const silence = new Float32Array(1280); // floor calibrates toward 0
    for (let i = 0; i < 40; i++) vad.feed(silence);

    const loud = new Float32Array(1280).fill(0.2); // clearly above floor
    const decisions = Array.from({ length: 6 }, () => vad.feed(loud));
    expect(decisions.some((d) => d.speechStart)).toBe(true);

    const quiet = Array.from({ length: 12 }, () => vad.feed(silence));
    expect(quiet.some((d) => d.speechEnd)).toBe(true);
  });

  it('ignores isolated transients', () => {
    const vad = new EnergyVAD({ onsetThreshold: 0.6 });
    const silence = new Float32Array(1280);
    for (let i = 0; i < 40; i++) vad.feed(silence);
    const spike = new Float32Array(1280).fill(0.3);
    vad.feed(spike); // 1 frame — onset needs 2
    const d = vad.feed(silence);
    expect(d.speechStart).toBe(false);
  });
});
