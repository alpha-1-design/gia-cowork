/**
 * The desktop themes, in one place.
 *
 * This list existed three times over — inline in the settings picker, inline in
 * the `/theme` slash command, and implicitly as the store default. Three copies
 * of a list that decides how the entire app looks is how you end up shipping a
 * fourth theme that appears in the picker but has no CSS behind it.
 *
 * `preview` is here so a theme can be shown rather than named. Picking a theme
 * you cannot see is a guess, and the whole point of a preview gallery is that
 * the choice is made by looking.
 */

export type ThemeId = 'dark' | 'light' | 'system' | 'obsidian-aurora';

/**
 * The palette behind a theme.
 *
 * These are the real values from `src/styles/globals.css`, copied rather than
 * referenced because the build flow needs them as plain data — it hands them to
 * a model as text, in a system prompt, where a CSS import would mean nothing.
 * They are duplicated deliberately, and kept honest by the test that compares
 * them against globals.css.
 */
export interface ThemePalette {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
}

export interface DesktopTheme {
  id: ThemeId;
  label: string;
  description: string;
  /** Representative colors for the picker swatch — bg, surface, accent. */
  preview: { bg: string; surface: string; accent: string };
  /** The full palette, used when handing the theme to a build. */
  palette: ThemePalette;
  /** True when the choice follows the OS and cannot be previewed directly. */
  system: boolean;
}

export const DESKTOP_THEMES: DesktopTheme[] = [
  {
    id: 'obsidian-aurora',
    label: 'Obsidian Aurora',
    description: 'True OLED black with an aurora gradient. The default.',
    preview: { bg: '#000000', surface: '#08080c', accent: '#06b6d4' },
    palette: {
      bg: '#000000',
      surface: '#08080c',
      surface2: '#0e0e14',
      border: 'rgba(255,255,255,0.06)',
      text: '#f0f0f5',
      muted: '#7a7a95',
      accent: '#06b6d4',
    },
    system: false,
  },
  {
    id: 'dark',
    label: 'Dark',
    description: 'Deep charcoal with a violet accent. Genuinely dark, not grey.',
    preview: { bg: '#08080c', surface: '#0e0e14', accent: '#a855f7' },
    palette: {
      bg: '#08080c',
      surface: '#0e0e14',
      surface2: '#14141c',
      border: 'rgba(255,255,255,0.07)',
      text: '#f0f0f5',
      muted: '#8888a0',
      accent: '#a855f7',
    },
    system: false,
  },
  {
    id: 'light',
    label: 'Light',
    description: 'Clean and bright, for daylight and documents.',
    preview: { bg: '#e8e8ef', surface: '#f5f5f9', accent: '#a855f7' },
    palette: {
      bg: '#e8e8ef',
      surface: '#f5f5f9',
      surface2: '#e0e0e8',
      border: 'rgba(0,0,0,0.10)',
      text: '#1b1b2a',
      muted: '#5a5a70',
      accent: '#a855f7',
    },
    system: false,
  },
  {
    id: 'system',
    label: 'System',
    description: 'Follow whatever the operating system is set to.',
    // Follows the OS, so there is no single palette. `dark` is the honest
    // stand-in because that is what it resolves to unless the OS says light.
    preview: { bg: '#5b5b66', surface: '#7a7a86', accent: '#c4c4cc' },
    palette: {
      bg: '#08080c',
      surface: '#0e0e14',
      surface2: '#14141c',
      border: 'rgba(255,255,255,0.07)',
      text: '#f0f0f5',
      muted: '#8888a0',
      accent: '#a855f7',
    },
    system: true,
  },
];

/**
 * The default.
 *
 * Obsidian Aurora, because it is the only one designed against the two targets
 * that actually matter here: a native desktop window on OLED, and a screen
 * that is going to be screenshotted or presented. Its black is true black, so
 * it does not glow against a dark bezel, and its accents stay legible when the
 * brightness is turned down.
 */
export const DEFAULT_THEME: ThemeId = 'obsidian-aurora';

export const THEME_IDS: ThemeId[] = DESKTOP_THEMES.map(t => t.id);

export function getDesktopTheme(id: string | null | undefined): DesktopTheme {
  return DESKTOP_THEMES.find(t => t.id === id) ?? DESKTOP_THEMES[0];
}