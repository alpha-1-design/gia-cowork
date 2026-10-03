import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useJarvisStore, type JarvisState } from '../store/useJarvisStore';
import { jarvisOrbService } from '../services/JarvisOrbService';
import { featureFlags } from '../services/GIACoreServices';
import { audioLevel, scaleForLevel } from '../utils/audioLevel';

/**
 * JarvisOrb — the floating "GIA's eyes" orb (desktop counterpart of the
 * Android Screen Orb).
 *
 * Redesigned against published guidance on ambient assistant presence. The
 * old version gave every state its own colour and its own animation, which
 * failed on three counts:
 *
 *   1. Colour alone cannot separate "hearing you" from "talking". Both were
 *      a pulse — one green, one amber. Now they move in OPPOSING directions:
 *      listening contracts toward the speaker, speaking expands with output.
 *   2. Idle breathed, which read as "recording". For an orb whose whole job
 *      is telling you when your screen is being captured, idle must be quiet
 *      enough that it cannot be mistaken for a capture indicator.
 *   3. Seven animations competed for attention. Fewer, more purposeful ones
 *      communicate faster.
 *
 * The hard rule now: **capturing looks like nothing else.** `seeing` gets a
 * sweeping arc and a bright core — if you glance at the orb mid-capture, one
 * glance tells you she is looking.
 *
 * Presence rules (unchanged — the orb is a cue, not a pet):
 *   - It stays exactly where you park it. It never drifts on its own.
 *   - The ONLY time it moves is when GIA actively engages with the screen
 *     (seeing / thinking / acting): it glides once to the center to "look",
 *     then glides back to your spot when she's done.
 *   - If her eyes are off and she is silent, it disappears entirely.
 *
 * Drag to park. Hover for the latest observation. Click toggles eyes.
 * Right-click opens the transparency panel. Ctrl/⌘+Shift+J is the kill switch.
 */

/**
 * One palette. Accents are reserved for capture and error — the only two
 * states where a change of hue carries meaning. Everything else is the same
 * violet at a different intensity, so the eye learns "bright violet = she is
 * doing something" rather than decoding seven colours.
 */
const STATE_COLOR: Record<JarvisState, { core: string; glow: string; label: string }> = {
  off:       { core: 'rgba(148,163,184,0.45)', glow: 'rgba(148,163,184,0.15)',  label: 'Jarvis eyes off' },
  idle:      { core: '#a78bfa',                glow: 'rgba(167,139,250,0.28)',   label: 'Jarvis — eyes on, waiting' },
  listening: { core: '#a78bfa',                glow: 'rgba(167,139,250,0.42)',   label: 'Jarvis — listening to you' },
  seeing:    { core: '#22d3ee',                glow: 'rgba(34,211,238,0.65)',    label: 'Jarvis — CAPTURING your screen' },
  thinking:  { core: '#a78bfa',                glow: 'rgba(167,139,250,0.45)',   label: 'Jarvis — making sense of what she sees' },
  acting:    { core: '#a78bfa',                glow: 'rgba(167,139,250,0.60)',   label: 'Jarvis — acting on the desktop' },
  speaking:  { core: '#a78bfa',                glow: 'rgba(167,139,250,0.42)',   label: 'Jarvis — speaking' },
  /**
   * Paused is its own state rather than a dimmed `idle`. "Paused" and
   * "watching" looked identical before, which meant the one moment the user
   * most wants certainty — is she looking right now? — was exactly the moment
   * the orb told them nothing. Paused reads as cold and inert.
   */
  paused:    { core: 'rgba(100,116,139,0.55)', glow: 'rgba(100,116,139,0.08)',  label: 'Jarvis — paused, NOT watching' },
};

/** The two states where hue is allowed to carry meaning. */
const ACCENT_STATES = new Set<JarvisState>(['seeing']);
const ERROR_COLOR = { core: '#f87171', glow: 'rgba(248,113,113,0.5)' };

/** Does this state mean "your screen is being captured right now"? */
export function isCapturing(s: JarvisState): boolean {
  return s === 'seeing';
}

const POS_KEY = 'gia-jarvis-pos';
const SIZE = 56;

function loadPos(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { x: number; y: number };
      if (typeof p.x === 'number' && typeof p.y === 'number') return p;
    }
  } catch { /* default below */ }
  if (typeof window === 'undefined') return { x: 0, y: 0 };
  return { x: Math.max(8, window.innerWidth - 72), y: Math.max(8, window.innerHeight - 110) };
}

function clampPos(x: number, y: number) {
  return {
    x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - SIZE - 8)),
    y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - SIZE - 8)),
  };
}

function attentionPoint() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // A natural "looking" spot: center of the viewport, slightly above the middle
  // (where GIA's terminal / browser action usually happens).
  return clampPos(Math.round(w / 2 - SIZE / 2), Math.round(h * 0.42));
}

const LOOK_STATES = new Set<JarvisState>(['seeing', 'thinking', 'acting']);

/**
 * Motion per state. Deliberately few animations: each one has to be worth a
 * user's attention, and "thinking" reuses the calm baseline rather than
 * inventing a third spinner.
 */
const MOTION: Record<JarvisState, { ring?: string; core?: string; arc?: string }> = {
  off: {},
  // Idle barely moves. If watching looked like recording, users would learn to
  // ignore it — and then it would not be warning them of anything.
  idle: { core: 'jarvis-orb-drift 7s ease-in-out infinite' },
  paused: {},
  listening: { core: 'jarvis-orb-contract 1.6s ease-in-out infinite' },
  speaking: { core: 'jarvis-orb-expand 1.6s ease-in-out infinite' },
  seeing: { ring: 'jarvis-orb-sweep 1.1s linear infinite', core: 'jarvis-orb-capture 1.1s ease-in-out infinite' },
  thinking: { ring: 'jarvis-orb-sweep 2.6s linear infinite' },
  acting: { ring: 'jarvis-orb-sweep 0.85s linear infinite', core: 'jarvis-orb-capture 0.85s ease-in-out infinite' },
};

export const JarvisOrb: React.FC = () => {
  const enabled = useJarvisStore((s) => s.enabled);
  const paused = useJarvisStore((s) => s.paused);
  const state = useJarvisStore((s) => s.state);
  const observation = useJarvisStore((s) => s.observation);
  const visionReady = useJarvisStore((s) => s.visionReady);
  const visionMode = useJarvisStore((s) => s.visionMode);
  const visionSource = useJarvisStore((s) => s.visionSource);
  const lastSeenAt = useJarvisStore((s) => s.lastSeenAt);
  const error = useJarvisStore((s) => s.error);

  // `park` is where the user parked it (persisted); `pos` is where it currently
  // renders — it only diverges while GIA is deliberately "looking" elsewhere.
  const [park, setPark] = useState(loadPos);
  const [pos, setPos] = useState(loadPos);
  const [showTip, setShowTip] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; parkX: number; parkY: number; moved: boolean } | null>(null);

  const isLooking = enabled && LOOK_STATES.has(state);

  // Live amplitude so the orb breathes with the room instead of cycling a
  // canned animation. Listening and speaking pull in opposite directions.
  const [level, setLevel] = useState(0);
  useEffect(() => {
    const active = state === 'listening' || state === 'speaking';
    if (!active) { setLevel(0); return; }
    return audioLevel.subscribe(v => setLevel(v));
  }, [state]);

  // Respect reduced-motion: hold a static, still-legible representation rather
  // than animating anyway. State stays readable via colour, the sweep arc, and
  // the text label.
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const on = () => setReducedMotion(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  // 'paused' is deliberately excluded from "engaged": a paused orb looks
  // inert, and treating it as engaged made it glow while provably not watching.
  const engaged = state !== 'off' && state !== 'idle' && state !== 'paused';

  // Persist the parked spot only — never the transient "looking" position.
  useEffect(() => {
    try { localStorage.setItem(POS_KEY, JSON.stringify(park)); } catch { /* best-effort */ }
  }, [park]);

  // Movement happens ONLY when GIA wants to look: glide to the center while
  // she's seeing / thinking / acting, glide back when she's done. Otherwise
  // the orb stays perfectly still where it was parked.
  useEffect(() => {
    if (dragRef.current || paused) return;
    setPos(isLooking ? attentionPoint() : park);
  }, [isLooking, park, paused]);

  const meta = STATE_COLOR[state] ?? STATE_COLOR.idle;

  const toggle = useCallback(() => {
    if (enabled) {
      featureFlags.setEnabled('jarvisEyes', false);
      jarvisOrbService.stop();
    } else {
      featureFlags.setEnabled('jarvisEyes', true);
      jarvisOrbService.start();
    }
  }, [enabled]);

  // Be there WHEN NECESSARY: fully hidden when the eyes are off and GIA is
  // silent; appears the moment she engages; otherwise a quiet presence.
  const hidden = !enabled && state === 'off';

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, parkX: park.x, parkY: park.y, moved: false };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [park]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (!d.moved) return;
    const next = clampPos(d.parkX + dx, d.parkY + dy);
    setPark(next);
    setPos(next);
  }, []);

  const onPointerUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved) toggle();
  }, [toggle]);

  const seenText =
    observation ||
    (enabled
      ? (visionReady.caption || visionReady.ocr || visionReady.detection
          ? 'Waiting for the screen…'
          : 'No local vision models loaded — download them in Voice & Models, or your vision-capable chat provider will analyze the screen instead.')
      : 'Eyes are off — GIA is still listening. Enable them in Settings → Developer → Jarvis Eyes.');

  const seenAt = lastSeenAt ? ` · ${new Date(lastSeenAt).toLocaleTimeString()}` : '';
  const readyCount = [visionReady.caption, visionReady.ocr, visionReady.detection, visionReady.classification].filter(Boolean).length;

  // Named orbMotion, not `motion` — a local of that name would shadow the
// imported motion/react component used by every <motion.div> below.
const orbMotion = reducedMotion ? {} : (MOTION[state] ?? {});
  const capturing = isCapturing(state);
  const accent = error ? ERROR_COLOR : (ACCENT_STATES.has(state) ? meta : null);

  // Amplitude drives scale; the keyframes add the direction so listening and
  // speaking stay distinguishable without relying on hue.
  const ampScale = scaleForLevel(level, state === 'listening' ? 'listening' : state === 'speaking' ? 'speaking' : 'idle');

  const vars = {
    '--jarvis-core': accent?.core ?? meta.core,
    '--jarvis-glow': accent?.glow ?? meta.glow,
  } as React.CSSProperties;

  if (hidden) return null;

  return (
    <div
      // Hidden in presenter mode — an orb drifting over a shared screen is
      // exactly the thing presenter mode exists to prevent.
      data-presenter-hide=""
      className="jarvis-orb-wrap fixed z-[190] select-none"
      style={{
        left: pos.x,
        top: pos.y,
        width: SIZE,
        height: SIZE,
        touchAction: 'none',
        transition: dragRef.current ? undefined : 'left 1.1s cubic-bezier(0.33, 1, 0.68, 1), top 1.1s cubic-bezier(0.33, 1, 0.68, 1)',
        cursor: 'grab',
      }}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        // Right-click opens the transparency panel rather than the browser menu.
        // A single click toggles the eyes, so the panel needed a second gesture
        // that could not collide with it.
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('gia:jarvis-panel'));
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onMouseEnter={() => setShowTip(true)}
      onMouseLeave={() => setShowTip(false)}
      title=""
    >
      {/* Screen-reader text: the orb is the app's capture indicator, so its
          state has to be legible to assistive tech, not just visual. */}
      <span className="sr-only" role="status" aria-live="polite">
        {STATE_COLOR[state].label}. Click to turn Jarvis eyes on or off, or press Ctrl+Shift+J.
      </span>
      <style>{`
        .jarvis-aura {
          position: absolute; inset: -16px; border-radius: 50%;
          background: radial-gradient(closest-side, var(--jarvis-glow), transparent 72%);
          filter: blur(5px); pointer-events: none;
          transition: background .3s ease;
        }
        .jarvis-ring {
          position: absolute; inset: -7px; border-radius: 50%;
          border: 1px solid color-mix(in srgb, var(--jarvis-core) 28%, transparent);
          border-top-color: var(--jarvis-core);
          box-shadow: 0 0 10px color-mix(in srgb, var(--jarvis-glow) 60%, transparent);
          pointer-events: none;
          transition: opacity .3s ease;
        }
        /* A 120-degree arc sweeping round the orb. Reads as an active gauge
           rather than a decorative ring. */
        .jarvis-arc {
          position: absolute; inset: -7px; border-radius: 50%;
          border: 1.5px solid transparent;
          border-top-color: var(--jarvis-core);
          border-right-color: color-mix(in srgb, var(--jarvis-core) 40%, transparent);
          clip-path: polygon(50% 50%, 0% 0%, 100% 0%, 100% 100%, 0% 100%);
          -webkit-mask-image: conic-gradient(from 0deg, transparent 0deg, #000 60deg, #000 200deg, transparent 260deg);
          mask-image: conic-gradient(from 0deg, transparent 0deg, #000 60deg, #000 200deg, transparent 260deg);
          pointer-events: none;
        }
        .jarvis-core {
          position: absolute; inset: 0; border-radius: 50%;
          background: radial-gradient(circle at 32% 28%,
            rgba(255,255,255,0.98) 0%,
            rgba(255,255,255,0.35) 12%,
            var(--jarvis-core) 42%,
            color-mix(in srgb, var(--jarvis-core) 20%, transparent) 66%,
            transparent 76%);
          box-shadow:
            0 0 22px 5px var(--jarvis-glow),
            0 0 56px 16px color-mix(in srgb, var(--jarvis-glow) 55%, transparent),
            inset 0 0 16px 2px rgba(255,255,255,0.22);
          transition: box-shadow .3s ease, background .3s ease, opacity .3s ease;
          pointer-events: none;
        }
        .jarvis-core::before {
          content: ''; position: absolute; top: 9%; left: 18%; width: 38%; height: 24%;
          border-radius: 50%;
          background: radial-gradient(closest-side, rgba(255,255,255,0.9), rgba(255,255,255,0));
          filter: blur(0.5px); pointer-events: none;
        }
      `}</style>
      <style>{`
        /* One gentle drift for idle. Deliberately slow and low-contrast so a
           watching orb can never be mistaken for a recording indicator. */
        @keyframes jarvis-orb-drift {
          0%, 100% { transform: scale(1); filter: brightness(0.92); }
          50% { transform: scale(1.03); filter: brightness(1.06); }
        }
        /* Listening pulls INWARD — turn ownership moves toward the speaker. */
        @keyframes jarvis-orb-contract {
          0%, 100% { transform: scale(0.97); }
          50% { transform: scale(0.90); }
        }
        /* Speaking pushes OUTWARD. Opposite direction to listening is what
           separates the two without relying on colour. */
        @keyframes jarvis-orb-expand {
          0%, 100% { transform: scale(1.03); }
          50% { transform: scale(1.13); }
        }
        /* Capture: a bright, unmistakable core. This is the one state where
           the user needs certainty, so it gets the strongest signal. */
        @keyframes jarvis-orb-capture {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(1.45); }
        }
        @keyframes jarvis-orb-sweep { to { transform: rotate(360deg); } }
      `}</style>

      <div className="jarvis-aura" style={{ '--jarvis-glow': accent?.glow ?? meta.glow } as React.CSSProperties} />

      {/* The sweep ring is the capture indicator. It only spins when she is
          actually looking or acting, so its motion IS the signal. */}
      <div
        className="jarvis-ring"
        style={{
          ...vars,
          animation: orbMotion.ring,
          opacity: capturing || state === 'acting' ? 1 : 0.45,
        }}
      />

      {/* A partial arc, rather than a full ring: reads as a gauge sweeping
          through a cycle rather than decoration. */}
      {(capturing || state === 'acting' || state === 'thinking') && (
        <div className="jarvis-arc" style={{ ...vars, animation: orbMotion.ring }} />
      )}

      <div
        className="jarvis-core"
        style={{
          ...vars,
          animation: orbMotion.core,
          transform: `scale(${ampScale})`,
          opacity: paused ? 0.45 : 1,
        }}
      />

      {/* Visible while capturing — the orb's own restatement of the fact, so
          the state survives a glance or a screenshot. */}
      {capturing && (
        <span
          className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full"
          style={{ background: '#22d3ee', boxShadow: '0 0 10px #22d3ee' }}
          aria-hidden
        />
      )}

      <AnimatePresence>
        {showTip && (
          <motion.div
            key="jarvis-tip"
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
            className="absolute -bottom-14 right-0 min-w-[220px] max-w-[300px] rounded-xl px-3 py-2 backdrop-blur-md"
            style={{
              background: 'rgba(2,8,23,0.92)',
              border: '1px solid color-mix(in srgb, var(--gia-muted) 35%, transparent)',
              color: 'var(--gia-text, #e2e8f0)',
            }}
          >
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: meta.core }}>
              {meta.label}
            </div>
            <div className="text-[11px] leading-snug" style={{ color: 'var(--gia-text)' }}>
              {seenText}
              {seenAt}
            </div>
            {enabled && (
              <div className="mt-1 text-[9px]" style={{ color: 'var(--gia-muted)' }}>
                vision models loaded: {readyCount}/4
              </div>
            )}
            {visionMode === 'cloud' && (
              <div className="mt-1 text-[9px]" style={{ color: '#22d3ee' }}>
                analyzing via {visionSource ?? 'your vision model'} (cloud)
              </div>
            )}
            {error ? (
              <div className="mt-1 text-[9px]" style={{ color: '#f87171' }}>{error}</div>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default JarvisOrb;