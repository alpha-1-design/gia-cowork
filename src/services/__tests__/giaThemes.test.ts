import { describe, it, expect } from 'vitest';
import {
  BUILD_STYLES, getBuildStyle, styleToCss, styleBrief,
  DEFAULT_BUILD_STYLE_ID, type BuildStyle,
} from '../build/giaThemes';

/**
 * The styles have to be genuinely different, not seven names for the same dark
 * grey. If two styles are near-identical the picker is a lie — the user picks
 * "Carbon" expecting a different result and gets Obsidian with a different
 * heading — so distinctness is asserted rather than assumed.
 */

describe('build styles', () => {
  it('offers exactly seven', () => {
    expect(BUILD_STYLES).toHaveLength(7);
  });

  it('defaults to Obsidian, the GIA signature', () => {
    expect(DEFAULT_BUILD_STYLE_ID).toBe('obsidian');
    expect(BUILD_STYLES[0].id).toBe('obsidian');
  });

  it('has unique ids and names', () => {
    expect(new Set(BUILD_STYLES.map(s => s.id)).size).toBe(7);
    expect(new Set(BUILD_STYLES.map(s => s.name)).size).toBe(7);
  });

  it('gives every style a complete token set', () => {
    for (const s of BUILD_STYLES) {
      const t = s.tokens;
      expect(t.bg).toMatch(/^#/);
      expect(t.surface).toMatch(/^#/);
      expect(t.surface2).toMatch(/^#/);
      expect(t.text).toMatch(/^#/);
      expect(t.muted).toMatch(/^#/);
      expect(t.accent).toMatch(/^#/);
      expect(t.accent2).toMatch(/^#/);
      expect(typeof t.border).toBe('string');
    }
  });

  it('varies the palette between styles rather than renaming one look', () => {
    const bgs = new Set(BUILD_STYLES.map(s => s.tokens.bg));
    // Seven styles cannot all share a background; at least four differ.
    expect(bgs.size).toBeGreaterThanOrEqual(4);
    const accents = new Set(BUILD_STYLES.map(s => s.tokens.accent));
    expect(accents.size).toBeGreaterThanOrEqual(5);
  });

  it('varies radius so the styles read differently even in greyscale', () => {
    const radii = new Set(BUILD_STYLES.map(s => s.radius));
    expect(radii.size).toBeGreaterThanOrEqual(3);
    expect(BUILD_STYLES.some(s => s.radius === 0)).toBe(true); // Mono, deliberately square
  });

  it('includes light and dark backgrounds', () => {
    const isLight = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return (r * 299 + g * 587 + b * 114) / 1000 > 128;
    };
    expect(BUILD_STYLES.some(s => isLight(s.tokens.bg))).toBe(true);
    expect(BUILD_STYLES.some(s => !isLight(s.tokens.bg))).toBe(true);
  });

  it('carries design intent, not just hex values', () => {
    for (const s of BUILD_STYLES) {
      expect(s.direction.length).toBeGreaterThan(60);
      expect(s.typography.length).toBeGreaterThan(20);
      expect(s.blurb.length).toBeGreaterThan(10);
    }
  });
});

describe('styleToCss', () => {
  it('emits every token as a custom property', () => {
    const css = styleToCss(BUILD_STYLES[0]);
    for (const v of ['--bg', '--surface', '--surface-2', '--border', '--text', '--muted', '--accent', '--accent-2']) {
      expect(css).toContain(`${v}:`);
    }
  });

  it('includes the radius so the generated app matches the style', () => {
    expect(styleToCss(BUILD_STYLES.find(s => s.id === 'mono')!)).toContain('--radius: 0px;');
  });

  it('emits no undefined values', () => {
    for (const s of BUILD_STYLES) {
      expect(styleToCss(s)).not.toMatch(/undefined|NaN/);
    }
  });
});

describe('styleBrief', () => {
  it('names the style and carries its palette', () => {
    const s = getBuildStyle('nordic');
    const brief = styleBrief(s);
    expect(brief).toContain('Nordic');
    expect(brief).toContain(s.tokens.bg);
    expect(brief).toContain(s.tokens.accent);
  });

  it('tells the model not to substitute framework defaults', () => {
    expect(styleBrief(BUILD_STYLES[0])).toMatch(/do not substitute/i);
  });

  it('falls back to the default for an unknown id', () => {
    expect(getBuildStyle('nope').id).toBe('obsidian');
    expect(getBuildStyle(null).id).toBe('obsidian');
    expect(getBuildStyle(undefined).id).toBe('obsidian');
  });
});

describe('studio integration surface', () => {
  it('every style carries a swatch usable for the picker', () => {
    for (const s of BUILD_STYLES) {
      expect(s.swatch.bg).toMatch(/^#/);
      expect(s.swatch.accent).toMatch(/^#/);
      // The swatch must agree with the palette or the preview misleads.
      expect(s.swatch.bg).toBe(s.tokens.bg);
      expect(s.swatch.accent).toBe(s.tokens.accent);
    }
  });

  it('type-checks every entry as a BuildStyle', () => {
    const all: BuildStyle[] = BUILD_STYLES;
    expect(all.length).toBe(7);
  });
});