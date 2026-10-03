/**
 * Seven visual styles GIA can build in.
 *
 * These are NOT the desktop themes. The desktop themes decide what GIA looks
 * like while she works; these decide what the thing she *builds* looks like
 * when the user asks for an app or a site. Both matter, they are different
 * decisions, and conflating them is why "pick a theme" was ambiguous.
 *
 * They load immediately — no install, no fetch, no skill activation — because
 * "build me a landing page" should not be blocked on a download. Every entry
 * carries a complete token set, so whichever is chosen can be written straight
 * into the generated project as CSS custom properties.
 *
 * Each style also carries `direction`: the design intent written in words, not
 * just hex values. A model given "charcoal and orange" produces something
 * generic; a model given a layout principle and a mood produces something that
 * looks designed. The numbers say what colour, the direction says what for.
 */

export interface StyleTokens {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accent2: string;
}

export interface BuildStyle {
  id: string;
  name: string;
  /** One line for the picker. */
  blurb: string;
  /** The design intent handed to the model alongside the tokens. */
  direction: string;
  /** Type pairing, so the style survives past the colour. */
  typography: string;
  /** Corner radius in px. */
  radius: number;
  tokens: StyleTokens;
  /** Preview gradient. */
  gradient: string;
  /** Shown on the swatch so the mini-preview is not empty. */
  swatch: { bg: string; surface: string; accent: string };
}

export const BUILD_STYLES: BuildStyle[] = [
  {
    id: 'obsidian',
    name: 'Obsidian',
    blurb: 'True black, aurora accents. GIA’s signature.',
    direction:
      'Near-black canvas with luminous accents used sparingly. Generous negative space, one focal element per screen, hairline borders instead of boxes. The accent is a light source, not a fill.',
    typography: 'Inter or DM Sans for UI, JetBrains Mono for data. Tight tracking on headings.',
    radius: 12,
    tokens: {
      bg: '#000000', surface: '#08080c', surface2: '#0e0e14',
      border: 'rgba(255,255,255,0.08)', text: '#f0f0f5', muted: '#7a7a95',
      accent: '#06b6d4', accent2: '#8b5cf6',
    },
    gradient: 'linear-gradient(135deg, #06b6d4, #8b5cf6)',
    swatch: { bg: '#000000', surface: '#08080c', accent: '#06b6d4' },
  },
  {
    id: 'carbon',
    name: 'Carbon',
    blurb: 'Graphite and ember. Serious, high-contrast, dense.',
    direction:
      'Neutral graphite greys doing all the structural work, with a single warm ember accent reserved for the primary action. Information-dense layouts, visible structure, no decoration that does not carry meaning.',
    typography: 'IBM Plex Sans with IBM Plex Mono for figures. Slightly tighter line-height.',
    radius: 6,
    tokens: {
      bg: '#0d0d0e', surface: '#16181a', surface2: '#1e2124',
      border: 'rgba(255,255,255,0.09)', text: '#f2f3f5', muted: '#8b9199',
      accent: '#f97316', accent2: '#fbbf24',
    },
    gradient: 'linear-gradient(135deg, #f97316, #fbbf24)',
    swatch: { bg: '#0d0d0e', surface: '#16181a', accent: '#f97316' },
  },
  {
    id: 'nordic',
    name: 'Nordic',
    blurb: 'Pale, cool, unhurried. Editorial calm.',
    direction:
      'Off-white and cool grey with restrained slate blue. Wide margins, large type, very little chrome. Reads like a well-set magazine rather than a dashboard.',
    typography: 'A serif for headings against a neutral sans for body. Generous size contrast.',
    radius: 4,
    tokens: {
      bg: '#f7f8f9', surface: '#ffffff', surface2: '#eef1f4',
      border: 'rgba(15,23,42,0.10)', text: '#1a222c', muted: '#63707e',
      accent: '#3f6c9e', accent2: '#7aa2c4',
    },
    gradient: 'linear-gradient(135deg, #3f6c9e, #7aa2c4)',
    swatch: { bg: '#f7f8f9', surface: '#ffffff', accent: '#3f6c9e' },
  },
  {
    id: 'ember',
    name: 'Ember',
    blurb: 'Dark ground, molten light. Bold and kinetic.',
    direction:
      'Deep charcoal ground with hot amber-to-magenta light. Strong diagonal energy, oversized type, heavy use of the gradient as a shape rather than a background.',
    typography: 'Heavy geometric sans for display, neutral sans for body.',
    radius: 16,
    tokens: {
      bg: '#0b0710', surface: '#160d1e', surface2: '#1f1330',
      border: 'rgba(255,150,80,0.14)', text: '#fdf6f0', muted: '#a08fa8',
      accent: '#f97316', accent2: '#ec4899',
    },
    gradient: 'linear-gradient(135deg, #f97316, #ec4899)',
    swatch: { bg: '#0b0710', surface: '#160d1e', accent: '#f97316' },
  },
  {
    id: 'verdant',
    name: 'Verdant',
    blurb: 'Deep botanical. Calm, alive, organic.',
    direction:
      'Forest greens on a near-black base, warm off-white text. Soft, rounded, low-contrast borders. Should feel grown rather than engineered.',
    typography: 'Humanist sans throughout, comfortable reading sizes.',
    radius: 14,
    tokens: {
      bg: '#060f0a', surface: '#0c1a12', surface2: '#12261a',
      border: 'rgba(134,239,172,0.12)', text: '#eefaf1', muted: '#7ea68b',
      accent: '#34d399', accent2: '#a3e635',
    },
    gradient: 'linear-gradient(135deg, #34d399, #a3e635)',
    swatch: { bg: '#060f0a', surface: '#0c1a12', accent: '#34d399' },
  },
  {
    id: 'mono',
    name: 'Mono',
    blurb: 'One colour, brutal clarity. Nothing decorative.',
    direction:
      'Pure black and white with a single hairline grid. No shadows, no gradients, no radius. Everything is alignment, weight and space. Refuses to be pretty in favour of being readable.',
    typography: 'One monospace family at three sizes. Uppercase micro-labels.',
    radius: 0,
    tokens: {
      bg: '#000000', surface: '#000000', surface2: '#0a0a0a',
      border: '#ffffff', text: '#ffffff', muted: '#8a8a8a',
      accent: '#ffffff', accent2: '#ffffff',
    },
    gradient: 'linear-gradient(90deg, #ffffff, #ffffff)',
    swatch: { bg: '#000000', surface: '#0a0a0a', accent: '#ffffff' },
  },
  {
    id: 'prism',
    name: 'Prism',
    blurb: 'Vivid, playful, confident. Built to be looked at.',
    direction:
      'Deep violet ground with saturated cyan, lime and coral. Confident colour blocking, overlapping shapes, motion and depth. Bold rather than tasteful — this one is meant to be memorable.',
    typography: 'Expressive display face paired with a neutral body sans.',
    radius: 20,
    tokens: {
      bg: '#0d0620', surface: '#170b33', surface2: '#22114a',
      border: 'rgba(167,139,250,0.20)', text: '#f8f5ff', muted: '#a99cc9',
      accent: '#22d3ee', accent2: '#a3e635',
    },
    gradient: 'linear-gradient(135deg, #22d3ee, #a3e635, #f472b6)',
    swatch: { bg: '#0d0620', surface: '#170b33', accent: '#22d3ee' },
  },
];

export const DEFAULT_BUILD_STYLE_ID = 'obsidian';

export function getBuildStyle(id: string | null | undefined): BuildStyle {
  return BUILD_STYLES.find(s => s.id === id) ?? BUILD_STYLES[0];
}

/** The `:root` block written into the generated project. */
export function styleToCss(style: BuildStyle): string {
  const t = style.tokens;
  return `:root {
  --bg: ${t.bg};
  --surface: ${t.surface};
  --surface-2: ${t.surface2};
  --border: ${t.border};
  --text: ${t.text};
  --muted: ${t.muted};
  --accent: ${t.accent};
  --accent-2: ${t.accent2};
  --accent-gradient: ${style.gradient};
  --radius: ${style.radius}px;
}`;
}

/**
 * The brief handed to the model for a chosen style.
 *
 * Carries intent, not just values — the palette tells it what colour, the
 * direction tells it what for, and typography stops it defaulting to whatever
 * the framework ships with.
 */
export function styleBrief(style: BuildStyle): string {
  return `**Visual style: ${style.name}** — ${style.blurb}

Design direction: ${style.direction}

Typography: ${style.typography}
Corner radius: ${style.radius}px.

Palette — define these as CSS custom properties in a \`:root\` block and use them everywhere:
- background \`${style.tokens.bg}\`
- surface \`${style.tokens.surface}\`, raised surface \`${style.tokens.surface2}\`
- border \`${style.tokens.border}\`
- text \`${style.tokens.text}\`, muted text \`${style.tokens.muted}\`
- accent \`${style.tokens.accent}\`, secondary accent \`${style.tokens.accent2}\`

These values are the style. Do not substitute the framework's defaults, and do not add colours that are not here.`;
}