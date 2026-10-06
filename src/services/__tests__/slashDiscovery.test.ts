import { describe, it, expect } from 'vitest';
import {
  getCommandSuggestions,
  getCommands,
  getCommandByName,
  type CommandCategory,
} from '../SlashCommands';
import { builtinSkillHighlights } from '../SkillsMarketplace';

/**
 * A regression guard for the discovery bug: `/init`, `/mcp`, `/model` and
 * `/provider` all existed in the registry, but a bare `/` showed the first
 * eight entries in registry order — all of them Chat & Sessions — so 47 of 55
 * commands were unreachable unless you already knew their names.
 */
describe('slash command discovery', () => {
  it('shows every category on a bare slash', () => {
    const bare = getCommandSuggestions('/');
    const cats = new Set(bare.map(c => c.category));
    const all = new Set(getCommands().map(c => c.category));

    expect(cats.size).toBe(all.size);
    for (const cat of all) expect(cats.has(cat)).toBe(true);
  });

  it('does not dump one category first', () => {
    const bare = getCommandSuggestions('/');
    const cats = bare.map(c => c.category);
    const unique = new Set(cats);
    // Round-robin means no repeats until every bucket has contributed.
    expect(unique.size).toBe(cats.length);
  });

  it('surfaces the commands users actually reported as missing', () => {
    // Typed, not just bare — these must be findable by prefix too.
    expect(getCommandSuggestions('/init').map(c => c.name)).toContain('init');
    expect(getCommandSuggestions('/mcp').map(c => c.name)).toContain('mcp');
    expect(getCommandSuggestions('/model').map(c => c.name)).toContain('model');
    expect(getCommandSuggestions('/prov').map(c => c.name)).toContain('provider');
  });

  it('accepts /providers as an alias for /provider', () => {
    expect(getCommandByName('providers')?.name).toBe('provider');
  });

  it('respects the limit', () => {
    expect(getCommandSuggestions('/', 4).length).toBe(4);
  });

  it('still filters out unavailable commands', () => {
    const available = new Set(getCommands().map(c => c.name));
    for (const c of getCommandSuggestions('/', 8)) expect(available.has(c.name)).toBe(true);
  });
});

/**
 * The system prompt used to hand-copy the first 8 builtin skills while the
 * registry held 43, so the prompt and the marketplace could silently disagree.
 */
describe('skill highlight block', () => {
  const highlights = builtinSkillHighlights();

  it('derives from the registry rather than a fixed 8', () => {
    // The registry holds 42 builtin skills; the old hand-copied block had 8.
    // (43 before the duplicate `Security Auditor` entry was merged away.)
    expect(highlights.length).toBeGreaterThan(8);
    expect(highlights.length).toBe(42);
  });

  it('includes skills that the old hardcoded list omitted', () => {
    const oldEight = [
      'Developer', 'Research Analyst', 'Security Auditor', 'DevOps Engineer',
      'Technical Writer', 'Data Analyst', 'Mobile Developer', 'ML Engineer',
    ];
    const names = highlights.map(h => h.name);
    const beyond = names.filter(n => !oldEight.includes(n));

    expect(beyond.length).toBeGreaterThan(0);
    expect(names).toContain('Code Reviewer');
  });

  it('keeps every original personality available', () => {
    const names = highlights.map(h => h.name);
    for (const n of ['Developer', 'Research Analyst', 'ML Engineer']) {
      expect(names).toContain(n);
    }
  });

  it('emits a prompt line per skill with both fields populated', () => {
    for (const h of highlights) {
      expect(h.name.trim().length).toBeGreaterThan(0);
      expect(h.description.trim().length).toBeGreaterThan(0);
      expect(`- **${h.name}** → ${h.description}`).toContain(h.name);
    }
  });

  it('has no duplicate personalities', () => {
    const names = highlights.map(h => h.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

/** Guard the category union the menu icon map has to cover. */
describe('command categories', () => {
  it('every command uses a known category', () => {
    const known: CommandCategory[] = [
      'Chat & Sessions', 'Models & Providers', 'Capabilities', 'Skills & Agents',
      'MCP & Plugins', 'Notes, Memory & Tasks', 'System', 'Help',
    ];
    for (const c of getCommands()) expect(known).toContain(c.category);
  });
});