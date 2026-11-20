import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { hasReducedMotionListener, prefersReducedMotion } from 'motion-dom';
import BotAvatar, { botAvatarParams } from '../BotAvatar';

/**
 * BotAvatar tests.
 *
 * The design brief pins four properties that must hold forever:
 *   1. DETERMINISM — same agentId → identical params, byte-identical SVG.
 *      The pin below is the contract: if the derivation changes (hash,
 *      masks, palette indexing), this test breaks on purpose.
 *   2. ONE COMPONENT, THREE SIZES — 16/64/128 render the same geometry;
 *      the SVG's inner markup must be byte-identical across sizes because
 *      everything is drawn in one viewBox.
 *   3. STATUS ON THE BOT — the chest core carries queued/running/failed
 *      without any surrounding ring.
 *   4. REDUCED MOTION — prefers-reduced-motion switches ALL idle motion
 *      off, as does animate={false}.
 */

// ── 1. Determinism ─────────────────────────────────────────────────────────

describe('botAvatarParams — determinism', () => {
  it('pins the exact params for a known agentId', () => {
    // 'bot-atlas-lane-1' hashes to 3179839867 under FNV-1a; every field
    // below is derived from that seed by the documented masks. Changing any
    // derivation step invalidates this pin — that is the point.
    expect(botAvatarParams('bot-atlas-lane-1')).toEqual({
      hash: 3179839867,
      silhouette: 1,
      eyes: 3,
      mouth: 2,
      antenna: 0,
      vents: true,
      primary: '#8b5cf6',
      accent: '#ec4899',
      floatDelay: 0.98,
      breatheDuration: 2.8,
      blinkDelay: 0,
    });
  });

  it('returns identical params on repeated calls (no hidden randomness)', () => {
    const a = botAvatarParams('lane-042');
    const b = botAvatarParams('lane-042');
    expect(a).toEqual(b);
  });

  it('gives different agentIds different identities', () => {
    const ids = ['lane-01', 'lane-02', 'lane-03', 'lane-04', 'lane-05', 'lane-06'];
    const hashes = new Set(ids.map(id => botAvatarParams(id).hash));
    expect(hashes.size).toBe(ids.length);
  });
});

describe('botAvatarParams — role bias', () => {
  it('researcher bots wear the visor + scanline regardless of id', () => {
    for (const id of ['a', 'b', 'c', 'swarm-lane-9']) {
      const p = botAvatarParams(id, 'Researcher');
      expect(p.silhouette).toBe(2); // visor-bar helmet
      expect(p.eyes).toBe(3); // scanline
    }
  });

  it('builder bots look constructed (hexcore, tri-dot)', () => {
    for (const id of ['x', 'y', 'z']) {
      const p = botAvatarParams(id, 'Technologist');
      expect(p.silhouette).toBe(1);
      expect(p.eyes).toBe(2);
    }
  });

  it('skeptic bots get the stern visor slit', () => {
    const p = botAvatarParams('onyx-1', 'Skeptic');
    expect(p.silhouette).toBe(2);
    expect(p.eyes).toBe(0);
  });

  it('unknown roles fall back to the hash identity', () => {
    const withRole = botAvatarParams('lane-01', 'Night Shift Supervisor');
    const withoutRole = botAvatarParams('lane-01');
    expect(withRole.silhouette).toBe(withoutRole.silhouette);
    expect(withRole.eyes).toBe(withoutRole.eyes);
  });
});

// ── 2. One component, three sizes ──────────────────────────────────────────

describe('BotAvatar — sizes', () => {
  it.each([16, 64, 128])('renders a %ipx square SVG with full geometry', (size) => {
    const { container } = render(<BotAvatar agentId="bot-atlas-lane-1" size={size} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('width')).toBe(String(size));
    expect(svg!.getAttribute('height')).toBe(String(size));
    // Every layer survives 16px because the geometry lives in the viewBox.
    // Body gradient, rim gradient, silhouette, eyes and the chest core:
    expect(svg!.querySelector('radialGradient')).not.toBeNull();
    expect(svg!.querySelector('linearGradient')).not.toBeNull();
    expect(svg!.querySelector('[data-core-status]')).not.toBeNull();
    expect(svg!.innerHTML.length).toBeGreaterThan(200);
    cleanup();
  });

  it('renders byte-identical inner SVG at every size (same viewBox geometry)', () => {
    const collect = (size: number) => {
      const { container, unmount } = render(<BotAvatar agentId="bot-atlas-lane-1" size={size} />);
      const html = container.querySelector('svg')!.innerHTML;
      unmount();
      return html;
    };
    const small = collect(16);
    expect(collect(64)).toBe(small);
    expect(collect(128)).toBe(small);
  });

  it('renders byte-identical SVG for the same agentId across two instances', () => {
    const first = render(<BotAvatar agentId="swarm-lane-7" size={40} />);
    const second = render(<BotAvatar agentId="swarm-lane-7" size={40} />);
    expect(first.container.querySelector('svg')!.outerHTML)
      .toBe(second.container.querySelector('svg')!.outerHTML);
  });
});

// ── 3. Status on the bot ───────────────────────────────────────────────────

describe('BotAvatar — chest-core status', () => {
  it('marks the core group with the status', () => {
    for (const status of ['idle', 'queued', 'running', 'done', 'failed', 'cancelled'] as const) {
      const { container, unmount } = render(<BotAvatar agentId="s" status={status} />);
      expect(container.querySelector(`[data-core-status="${status}"]`)).not.toBeNull();
      expect(container.querySelector('[data-bot-status]')!.getAttribute('data-bot-status')).toBe(status);
      unmount();
    }
  });

  it('failed lanes show the red ✕ core', () => {
    const { container } = render(<BotAvatar agentId="s" status="failed" />);
    const core = container.querySelector('[data-core-status="failed"]')!;
    // A red cross drawn on the chest, independent of any surrounding ring.
    expect(core.querySelector('path')).not.toBeNull();
    expect(core.innerHTML).toContain('#f87171');
  });

  it('running lanes pulse when motion is allowed, and stay calm when not', () => {
    const live = render(<BotAvatar agentId="s" status="running" animate />);
    expect(live.container.querySelector('[data-core-pulse="dot"]')).not.toBeNull();
    expect(live.container.querySelector('[data-core-pulse="halo"]')).not.toBeNull();
    cleanup();

    const still = render(<BotAvatar agentId="s" status="running" animate={false} />);
    expect(still.container.querySelector('[data-core-pulse]')).toBeNull();
    expect(still.container.querySelector('[data-core-status="running"] circle')).not.toBeNull();
    cleanup();
  });

  it('queued lanes render a static core (no pulse elements)', () => {
    const { container } = render(<BotAvatar agentId="s" status="queued" />);
    expect(container.querySelector('[data-core-pulse]')).toBeNull();
    expect(container.querySelector('[data-core-status="queued"] circle')).not.toBeNull();
  });
});

// ── 4. Reduced motion ──────────────────────────────────────────────────────

describe('BotAvatar — reduced motion', () => {
  const realMatchMedia = window.matchMedia;

  const stubMatchMedia = (reduce: boolean) => {
    window.matchMedia = ((query: string) => ({
      // motion-dom queries "(prefers-reduced-motion)" — WITHOUT ": reduce" —
      // and caches the result it reads (initPrefersReducedMotion). Matching
      // the family prefix is what the real query needs; matching only the
      // ": reduce" spelling reported false and the hook saw no preference
      // even with the stub armed.
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  };

  const resetMotionDomCache = () => {
    // motion-dom reads window.matchMedia ONCE (initPrefersReducedMotion) and
    // caches it at module level, guarded by hasReducedMotionListener. That
    // state cannot be re-imported fresh: vitest's vi.resetModules() never
    // re-evaluates externalized node_modules deps, so motion-dom stays one
    // shared instance for the whole file — and earlier tests in this file
    // have already run the init against the real happy-dom matchMedia.
    // Nulling both refs makes the next useReducedMotion() re-init against
    // the current stub — exactly what a fresh browser page load does.
    prefersReducedMotion.current = null;
    hasReducedMotionListener.current = false;
  };

  beforeEach(() => {
    stubMatchMedia(true);
    resetMotionDomCache();
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    resetMotionDomCache();
  });

  it('prefers-reduced-motion disables ALL idle motion, even with animate=true', () => {
    stubMatchMedia(true);
    const { container } = render(<BotAvatar agentId="s" animate />);
    expect(container.querySelector('[data-bot-motion="off"]')).not.toBeNull();
    expect(container.querySelector('[data-bot-motion="float"]')).toBeNull();
    expect(container.querySelector('[data-antenna-blink]')).toBeNull();
  });

  it('motion stays on when the media query reports no preference', () => {
    stubMatchMedia(false);
    const { container } = render(<BotAvatar agentId="s" animate />);
    expect(container.querySelector('[data-bot-motion="float"]')).not.toBeNull();
  });

  it('animate={false} is an unconditional off-switch (dense grids)', () => {
    stubMatchMedia(false);
    const { container } = render(<BotAvatar agentId="s" animate={false} />);
    expect(container.querySelector('[data-bot-motion="off"]')).not.toBeNull();
    expect(container.querySelector('[data-antenna-blink]')).toBeNull();
  });
});

// ── Accessibility ──────────────────────────────────────────────────────────

describe('BotAvatar — a11y', () => {
  it('labels itself for screen readers', () => {
    render(<BotAvatar agentId="lane-09" />);
    expect(screen.getByRole('img', { name: 'Bot lane-09' })).toBeTruthy();
  });
});
