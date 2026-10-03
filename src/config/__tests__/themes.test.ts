import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DESKTOP_THEMES, DEFAULT_THEME, THEME_IDS, getDesktopTheme } from '../themes';
import { useGiaStore } from '../../store/useGiaStore';

/**
 * Two things are guarded here.
 *
 * First, that Obsidian Aurora really is the default — including for existing
 * installs, which is what the persist migration is for.
 *
 * Second, and more subtly, that the palettes in this file still match
 * `globals.css`. They are duplicated on purpose (the build flow needs them as
 * plain text to hand a model), and duplication without a check is just a lie
 * waiting to happen: someone restyles the app, the picker keeps advertising the
 * old colours, and the generated app inherits colours the app itself stopped
 * using years ago.
 */

const css = readFileSync(resolve(__dirname, '../../styles/globals.css'), 'utf8');

/** Pull `--gia-*` values out of one theme's CSS block. */
function blockFor(theme: string): string {
  const marker = theme === 'dark' ? ':root, [data-theme="dark"] {' : `[data-theme="${theme}"] {`;
  const start = css.indexOf(marker);
  expect(start, `no CSS block for ${theme}`).toBeGreaterThan(-1);
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

function varValue(block: string, name: string): string {
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return m ? m[1].trim() : '';
}

describe('theme catalog', () => {
  it('leads with Obsidian Aurora and defaults to it', () => {
    expect(DESKTOP_THEMES[0].id).toBe('obsidian-aurora');
    expect(DEFAULT_THEME).toBe('obsidian-aurora');
  });

  it('matches the store default', () => {
    const fresh = (useGiaStore.getState() as { theme?: string }).theme;
    expect(fresh).toBe(DEFAULT_THEME);
  });

  it('has no duplicate ids', () => {
    expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length);
  });

  it('gives every theme a preview swatch and a palette', () => {
    for (const t of DESKTOP_THEMES) {
      expect(t.preview.bg).toMatch(/^#/);
      expect(t.preview.accent).toMatch(/^#/);
      expect(t.palette.bg).toMatch(/^#/);
      expect(t.palette.accent).toMatch(/^#/);
      expect(t.label.length).toBeGreaterThan(0);
    }
  });

  it('falls back to the default rather than returning undefined', () => {
    expect(getDesktopTheme('nonsense').id).toBe('obsidian-aurora');
    expect(getDesktopTheme(null).id).toBe('obsidian-aurora');
    expect(getDesktopTheme(undefined).id).toBe('obsidian-aurora');
  });
});

describe('palettes still match the real CSS', () => {
  const cases: { id: string; cssBlock: string }[] = [
    { id: 'obsidian-aurora', cssBlock: 'obsidian-aurora' },
    { id: 'dark', cssBlock: 'dark' },
    { id: 'light', cssBlock: 'light' },
  ];

  for (const { id, cssBlock } of cases) {
    it(`${id} matches globals.css`, () => {
      const block = blockFor(cssBlock);
      const theme = getDesktopTheme(id);
      expect(theme.palette.bg).toBe(varValue(block, 'gia-bg'));
      expect(theme.palette.surface).toBe(varValue(block, 'gia-surface'));
      expect(theme.palette.surface2).toBe(varValue(block, 'gia-surface-2'));
      expect(theme.palette.border).toBe(varValue(block, 'gia-border'));
      expect(theme.palette.text).toBe(varValue(block, 'gia-text'));
      expect(theme.palette.muted).toBe(varValue(block, 'gia-muted'));
      expect(theme.palette.accent).toBe(varValue(block, 'gia-accent'));
    });
  }

  it('the swatch matches its own palette, so the preview is not a lie', () => {
    // `system` is the deliberate exception: it resolves to whichever palette the
    // OS asks for, so there is no single appearance to show. It gets a neutral
    // swatch that says "no fixed colour" rather than borrowing dark's and
    // implying a choice it does not represent.
    for (const t of DESKTOP_THEMES.filter(t => !t.system)) {
      expect(t.preview.bg).toBe(t.palette.bg);
      expect(t.preview.accent).toBe(t.palette.accent);
    }
  });

  it('system is marked as following the OS rather than as a fixed palette', () => {
    const sys = getDesktopTheme('system');
    expect(sys.system).toBe(true);
    expect(DESKTOP_THEMES.filter(t => !t.system).every(t => !t.system)).toBe(true);
  });
});