import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  thresholdForSensitivity,
  keywordsFor,
  resolveWakeWordPlan,
  modelBaseUrl,
  wakeWordUnavailableReason,
  DEFAULT_WAKE_WORD_MODEL,
  WAKE_WORD_MODELS,
} from '../openWakeWord';

describe('thresholdForSensitivity', () => {
  it('inverts: higher sensitivity means a lower acceptance threshold', () => {
    expect(thresholdForSensitivity(0.9)).toBeLessThan(thresholdForSensitivity(0.3));
  });

  it('uses the store default of 0.7 sensibly', () => {
    expect(thresholdForSensitivity(0.7)).toBe(0.3);
  });

  it('clamps out-of-range values so the model is never silent or trigger-happy', () => {
    expect(thresholdForSensitivity(99)).toBeGreaterThan(0);
    expect(thresholdForSensitivity(99)).toBeLessThanOrEqual(0.95);
    expect(thresholdForSensitivity(-5)).toBeGreaterThanOrEqual(0.05);
    expect(thresholdForSensitivity(0)).toBeLessThanOrEqual(0.95);
  });

  it('survives a corrupt persisted NaN', () => {
    expect(Number.isFinite(thresholdForSensitivity(Number.NaN))).toBe(true);
    expect(thresholdForSensitivity(Number.NaN)).toBe(0.3);
  });
});

describe('keywordsFor', () => {
  it('always returns a real modelled head', () => {
    expect(keywordsFor('hey gia')).toContain(DEFAULT_WAKE_WORD_MODEL);
    expect(keywordsFor('hey gia')).toContain(WAKE_WORD_MODELS[0]);
  });

  it('falls back rather than silently disabling an unmodelled keyword', () => {
    expect(keywordsFor('computer')).toEqual([DEFAULT_WAKE_WORD_MODEL]);
    expect(keywordsFor(undefined)).toEqual([DEFAULT_WAKE_WORD_MODEL]);
    expect(keywordsFor('   ')).toEqual([DEFAULT_WAKE_WORD_MODEL]);
  });

  it('is case and whitespace insensitive', () => {
    expect(keywordsFor('  HEY JARVIS ')).toEqual([DEFAULT_WAKE_WORD_MODEL]);
  });
});

describe('resolveWakeWordPlan', () => {
  it('returns null when disabled, so a disabled wake word cannot start', () => {
    expect(resolveWakeWordPlan({ enabled: false, sensitivity: 0.7 })).toBeNull();
  });

  it('carries sensitivity through to the threshold', () => {
    const plan = resolveWakeWordPlan({ enabled: true, sensitivity: 0.8 });
    expect(plan).not.toBeNull();
    expect(plan!.detectionThreshold).toBe(thresholdForSensitivity(0.8));
  });

  it('retriggers faster while keepListening is on', () => {
    const normal = resolveWakeWordPlan({ enabled: true, sensitivity: 0.7, keepListening: false });
    const continuous = resolveWakeWordPlan({ enabled: true, sensitivity: 0.7, keepListening: true });
    expect(continuous!.cooldownMs).toBeLessThan(normal!.cooldownMs);
  });
});

describe('modelBaseUrl', () => {
  it('resolves against the chunk location so subpath and custom-scheme hosting works', () => {
    expect(modelBaseUrl('https://owner.github.io/gia-cowork/assets/index-abc.js')).toBe(
      'https://owner.github.io/gia-cowork/openwakeword/models',
    );
  });

  it('works at a domain root', () => {
    expect(modelBaseUrl('https://gia-cowork.vercel.app/')).toBe(
      'https://gia-cowork.vercel.app/openwakeword/models',
    );
  });

  it('works from a nested route so deep links do not break asset resolution', () => {
    // baseUri stands in for import.meta.url -- the built chunk always lives in
    // /assets/, so a deep route cannot skew the result.
    expect(modelBaseUrl('https://gia-cowork.vercel.app/assets/index-abc.js')).toBe(
      'https://gia-cowork.vercel.app/openwakeword/models',
    );
  });

  it('resolves under a custom scheme for the Tauri webview', () => {
    expect(modelBaseUrl('tauri://localhost/assets/index-abc.js')).toBe(
      'tauri://localhost/openwakeword/models',
    );
  });

  it('does not leave a trailing slash', () => {
    expect(modelBaseUrl('http://localhost:1420/').endsWith('/')).toBe(false);
  });
});

describe('wakeWordUnavailableReason', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a missing microphone API instead of failing silently', () => {
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: undefined });
    expect(wakeWordUnavailableReason()).toBe('no-microphone-api');
  });

  it('reports a missing AudioWorklet', () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => {} } });
    vi.stubGlobal('AudioWorkletNode', undefined);
    expect(wakeWordUnavailableReason()).toBe('no-audioworklet');
  });

  it('returns null when the environment can actually run the engine', () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => {} } });
    vi.stubGlobal('AudioWorkletNode', class {});
    expect(wakeWordUnavailableReason()).toBeNull();
  });
});