import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MODES, modePromptFor, getModePromptName } from '../system/modePrompts';
import { processSlashCommand } from '../SlashCommands';
import { useGiaStore } from '../../store/useGiaStore';

/**
 * The bug this guards is one this codebase already produced once.
 *
 * `currentMode` was only ever assigned 'build' or 'code' anywhere in the app,
 * so four mode prompts — plan, ask, exam, analyst — were written, tested, and
 * unreachable. They read as features. They are the "tool with no description"
 * mistake at the mode level: present in the data, invisible in the product.
 *
 * So the assertion is reachability, not correctness. A mode that cannot be
 * selected from both the UI and `/mode` fails here even if its prompt is
 * perfect.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('every declared mode is reachable', () => {
  it('has a non-empty prompt for each mode it declares', () => {
    for (const m of MODES) {
      if (m === 'build') continue; // delegated to buildBuilderPrompt by design
      expect(modePromptFor(m).length, `${m} has no prompt`).toBeGreaterThan(200);
    }
  });

  it('has a human name for each mode', () => {
    for (const m of MODES) {
      expect(getModePromptName(m).length).toBeGreaterThan(3);
    }
  });

  it('is settable through /mode for every mode', () => {
    for (const m of MODES) {
      processSlashCommand(`/mode ${m}`);
      const state = useGiaStore.getState();
      const mode = (state.sharedData as { currentMode?: string } | undefined)?.currentMode;
      expect(mode, `/mode ${m} did not take`).toBe(m);
      // Build mode also has to flip the build flag, or the UI disagrees with
      // the prompt and the user cannot tell which one is active.
      expect(state.buildMode, `buildMode wrong after /mode ${m}`).toBe(m === 'build');
    }
  });

  it('rejects an unknown mode instead of silently accepting it', () => {
    const before = (useGiaStore.getState().sharedData as { currentMode?: string } | undefined)?.currentMode;
    const res = processSlashCommand('/mode definitely-not-a-mode');
    expect(res.message).toMatch(/Unknown mode/);
    const after = (useGiaStore.getState().sharedData as { currentMode?: string } | undefined)?.currentMode;
    expect(after).toBe(before);
  });

  it('renders a control for every mode in the chat UI', () => {
    // Static check rather than a render: the picker lives deep in ChatModule,
    // and asserting the string exists catches a mode being added to MODES
    // without ever getting a button.
    const src = readFileSync(join(__dirname, '../../modules/ChatModule.tsx'), 'utf8');
    expect(src).toContain('data-testid="mode-picker"');
    expect(src).toContain('data-testid={`mode-${m}`}');
    // It must iterate the shared list, not a private copy that can drift.
    expect(src).toMatch(/MODES\.map/);
  });

  it('has no nested buttons inside the picker', () => {
    // A <button> inside a <button> is invalid HTML: the browser drops the inner
    // elements, so the control renders but never fires. It passed typecheck.
    const src = readFileSync(join(__dirname, '../../modules/ChatModule.tsx'), 'utf8');
    const start = src.indexOf('data-testid="mode-picker"');
    expect(start).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, start - 400), start);
    // The element carrying the testid must be a div/group, not a button.
    expect(before).toMatch(/<div[^>]*$/);
  });
});

describe('no mode is write-only', () => {
  it('finds every mode assignment across the codebase and confirms each is one of MODES', () => {
    const files = walk(join(__dirname, '../..')).filter(f => !f.includes('__tests__'));
    const assigned = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/currentMode:\s*'([a-z]+)'/g)) assigned.add(m[1]);
    }
    for (const a of assigned) {
      expect((MODES as readonly string[]).includes(a), `"${a}" is assigned somewhere but is not a declared mode`).toBe(true);
    }
  });

  it('declares plan, ask, exam and analyst — the modes that were unreachable', () => {
    for (const m of ['plan', 'ask', 'exam', 'analyst']) {
      expect((MODES as readonly string[]).includes(m)).toBe(true);
    }
  });
});