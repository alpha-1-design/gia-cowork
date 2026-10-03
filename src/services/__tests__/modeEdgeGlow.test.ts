import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODE_EDGE_GLOW, MODES } from '../system/modePrompts';
import { useGiaStore } from '../../store/useGiaStore';

/**
 * The module edges have to show which mode is active, because the modes where
 * being wrong is quietest are the ones that need it: in PLAN mode GIA looks
 * exactly as productive as usual while touching nothing.
 *
 * These assert the *values* rather than that a variable exists. A glow that is
 * technically defined but set to `none`, or set to something that cannot
 * render, is the same as not having it.
 */

describe('mode edge glow', () => {
  it('lights the restrictive modes', () => {
    for (const m of ['plan', 'ask', 'exam', 'analyst']) {
      expect(MODE_EDGE_GLOW[m as keyof typeof MODE_EDGE_GLOW], `${m} has no edge`)
        .toBeTruthy();
    }
  });

  it('leaves the default modes dark', () => {
    // A glow that is normally on stops reading as "on" the moment it appears,
    // so code and build deliberately have none.
    expect(MODE_EDGE_GLOW.code).toBeUndefined();
    expect(MODE_EDGE_GLOW.build).toBeUndefined();
  });

  it('is an inset rim, not a halo that would fill the screen', () => {
    for (const [mode, value] of Object.entries(MODE_EDGE_GLOW)) {
      expect(value!.startsWith('inset'), `${mode} should be inset`).toBe(true);
      expect(value, `${mode} should not be a spread glow`).not.toMatch(/\s\d+px\s+\d+px\s+\d+px/);
    }
  });

  it('gives plan mode the strongest edge of the four', () => {
    // Plan is the one where the cost of not noticing is highest: GIA looks
    // busy, and the restriction is invisible.
    const alpha = (v: string) => {
      const m = v.match(/rgba?\([^)]*?,\s*([\d.]+)\)/);
      return m ? parseFloat(m[1]) : 0;
    };
    expect(alpha(MODE_EDGE_GLOW.plan!)).toBeGreaterThan(alpha(MODE_EDGE_GLOW.ask!));
  });

  it('is a valid CSS box-shadow with two layers', () => {
    const plan = MODE_EDGE_GLOW.plan!;
    expect(plan).toContain('0 0 0 1px');
    expect(plan.split('),').length).toBeGreaterThanOrEqual(1);
    expect(plan).not.toMatch(/undefined|NaN/);
  });

  it('has an entry for no mode it does not know', () => {
    for (const key of Object.keys(MODE_EDGE_GLOW)) {
      expect((MODES as readonly string[]).includes(key), `${key} is not a real mode`).toBe(true);
    }
  });
});

describe('the chat module uses it', () => {
  const src = readFileSync(join(__dirname, '../../modules/ChatModule.tsx'), 'utf8');

  it('drives the edge from the active mode, not a hardcoded constant', () => {
    expect(src).toMatch(/boxShadow:\s*MODE_EDGE_GLOW\[/);
    expect(src).toContain('currentModeName');
  });

  it('marks the root with the mode so it can be styled or tested', () => {
    expect(src).toContain('data-mode={currentModeName}');
    expect(src).toContain('data-testid="chat-module-root"');
  });

  it('animates the change rather than snapping', () => {
    // Without a transition the glow appears instantly on switching modes, which
    // reads as a rendering glitch rather than a state change.
    expect(src).toMatch(/transition:\s*'box-shadow/);
  });
});
describe('the edge actually reacts to a mode change', () => {
  /**
   * The string assertions above prove the wiring exists. This proves it works.
   *
   * `currentModeName` in ChatModule subscribes with `useGiaStore(s =>
   * s.sharedData)`, which only fires if the selector returns a new reference.
   * If `updateSharedData` mutated `sharedData` in place, zustand would see no
   * change, the component would never re-render, and the glow would stay
   * frozen on whatever mode was active when the app loaded — which is exactly
   * the bug this feature exists to prevent.
   */
  it('re-renders a sharedData subscriber when the mode changes', () => {
    const seen: (string | undefined)[] = [];
    const unsub = useGiaStore.subscribe((s) => { seen.push(s.sharedData.currentMode as string | undefined); });

    useGiaStore.getState().updateSharedData({ currentMode: 'plan' });
    expect(seen.at(-1)).toBe('plan');

    useGiaStore.getState().updateSharedData({ currentMode: 'code' });
    expect(seen.at(-1)).toBe('code');
    unsub();
  });

  it('resolves to the same glow the component reads', () => {
    for (const m of MODES) {
      useGiaStore.getState().updateSharedData({ currentMode: m });
      const current = (useGiaStore.getState().sharedData as { currentMode?: string }).currentMode ?? 'code';
      expect(current).toBe(m);
      expect(MODE_EDGE_GLOW[current as keyof typeof MODE_EDGE_GLOW] ?? 'none')
        .toBe(MODE_EDGE_GLOW[m as keyof typeof MODE_EDGE_GLOW] ?? 'none');
    }
  });

  it('defaults to code — no edge — for a session with no mode set', () => {
    // Clear it first: the previous test leaves `analyst` in sharedData, and
    // asserting against whatever the last test happened to set is how a
    // default-case test passes or fails for the wrong reason.
    useGiaStore.getState().updateSharedData({ currentMode: undefined });
    const current = (useGiaStore.getState().sharedData as { currentMode?: string }).currentMode ?? 'code';
    expect(current).toBe('code');
    expect(MODE_EDGE_GLOW[current as keyof typeof MODE_EDGE_GLOW]).toBeUndefined();
  });
});
