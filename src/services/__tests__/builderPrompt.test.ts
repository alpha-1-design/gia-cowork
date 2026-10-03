import { describe, it, expect } from 'vitest';
import { buildBuilderPrompt, buildBlockedReason } from '../build/builderPrompt';
import { getDesktopTheme, DEFAULT_THEME } from '../../config/themes';
import { getBuildStyle } from '../build/giaThemes';
import type { Skill } from '../../store/useGiaStore';

/**
 * The rule being enforced: a build does not start without a skill loaded.
 *
 * `buildBlockedReason` is the single gate, so it is tested directly rather than
 * inferred from whether a button happens to be disabled in some screen — a UI
 * check would pass even if the prompt itself stopped insisting on it, which is
 * the part that actually reaches the model.
 */

const skill = (over: Partial<Skill> = {}): Skill => ({
  id: 'core-developer',
  name: 'Developer Mode',
  description: 'Expert software engineering.',
  systemPrompt: 'You are GIA in Developer Mode.',
  tools: [],
  category: 'dev',
  ...over,
});

describe('buildBlockedReason', () => {
  it('blocks when no skill is loaded', () => {
    expect(buildBlockedReason(null)).toBeTruthy();
    expect(buildBlockedReason(undefined)).toBeTruthy();
  });

  it('blocks on the catch-all default, which carries no specialism', () => {
    expect(buildBlockedReason(skill({ id: 'core-general', name: 'General Assistant' }))).toBeTruthy();
    expect(buildBlockedReason(skill({ id: 'x', name: 'General' }))).toBeTruthy();
  });

  it('allows a real specialised skill', () => {
    expect(buildBlockedReason(skill())).toBeNull();
  });
});

describe('buildBuilderPrompt', () => {
  it('tells the model to load a skill when none is active', () => {
    const p = buildBuilderPrompt({ skill: null });
    expect(p).toMatch(/skill_list/);
    expect(p).toMatch(/No specialised skill is loaded/);
  });

  it('defers to the loaded skill instead of telling it to look for one', () => {
    const p = buildBuilderPrompt({ skill: skill() });
    expect(p).toContain('Developer Mode');
    expect(p).not.toMatch(/No specialised skill is loaded/);
  });

  it('is identical in structure regardless of model — no model is named', () => {
    // The whole point: the brief is a process, so a small local model gets the
    // same floor as a frontier one.
    const p = buildBuilderPrompt({ skill: skill() });
    expect(p).not.toMatch(/claude|openai|gpt-4|gemini|llama|mistral/i);
  });

  it('defines done concretely instead of asking for quality', () => {
    const p = buildBuilderPrompt({ skill: skill() });
    expect(p).toMatch(/placeholder/);
    expect(p).toMatch(/loading, empty, and error|loading/);
    expect(p).toMatch(/responsive/i);
    expect(p).toMatch(/accessib/i);
    expect(p).toMatch(/looks designed|not generated/i);
  });

  it('carries the chosen BUILD STYLE palette into the prompt', () => {
    // The palette the generated app uses comes from the style, not from the
    // desktop theme. Mixing those two was the original ambiguity: choosing
    // Obsidian Aurora for GIA's own appearance must not dictate what the app
    // she builds looks like.
    const style = getBuildStyle('nordic');
    const p = buildBuilderPrompt({ skill: skill(), styleId: 'nordic' });
    expect(p).toContain(style.tokens.bg);
    expect(p).toContain(style.tokens.accent);
    expect(p).toContain('Nordic');
  });

  it('names the desktop theme but does not leak its palette into the build', () => {
    const theme = getDesktopTheme('light');
    const p = buildBuilderPrompt({ skill: skill(), themeId: 'light', styleId: 'obsidian' });
    // It acknowledges the desktop theme and explicitly separates the two.
    expect(p).toContain('Light');
    expect(p).toMatch(/separate|does not constrain/i);
    // The desktop palette must NOT appear — obsidian is the build style here.
    expect(p).not.toContain(theme.palette.bg);
  });

  it('defaults to the default theme when none is given', () => {
    const p = buildBuilderPrompt({ skill: skill() });
    expect(p).toContain(getDesktopTheme(DEFAULT_THEME).label);
  });

  it('keeps the background-server instruction that makes previews work', () => {
    const p = buildBuilderPrompt({ skill: skill() });
    expect(p).toMatch(/BACKGROUND/);
    expect(p).toMatch(/LISTENING/);
  });
});