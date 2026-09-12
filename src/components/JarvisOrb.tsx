import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useJarvisStore, type JarvisState } from '../store/useJarvisStore';
import { jarvisOrbService } from '../services/JarvisOrbService';
import { featureFlags } from '../services/GIACoreServices';

/**
 * JarvisOrb — the floating "GIA's eyes" orb (desktop counterpart of the
 * Android Screen Orb). A clean, luminous energy sphere that reflects what
 * GIA is doing with the screen:
 *
 *   idle      slow breathing, quiet blue — always present when eyes are on
 *   listening green pulse — she's hearing you
 *   seeing    fast flicker, glides to the center of the screen to look
 *   thinking  violet, spinning ring — distilling what she saw
 *   acting    pink, rapid flicker + orbit — GIA is executing on the desktop
 *   speaking  amber pulse — TTS playback
 *
 * Presence rules (from the Jarvis research — the orb is a cue, not a pet):
 *   - It stays exactly where you park it. It never drifts on its own.
 *   - The ONLY time it moves is when GIA actively engages with the screen
 *     (seeing / thinking / acting): it glides once to the center to "look",
 *     then glides back to your spot when she's done.
 *   - If her eyes are turned off and she's silent, it disappears entirely —
 *     it only appears when it's actually needed (eyes on, or GIA mid-task).
 *
 * Drag to park it. Hover shows the latest observation. Click toggles eyes.
 */

const STATE_COLOR: Record<JarvisState, { core: string; glow: string; label: string }> = {
  off:       { core: 'rgba(148,163,184,0.45)', glow: 'rgba(148,163,184,0.15)',  label: 'Jarvis eyes off' },
  idle:      { core: '#3b82f6',                glow: 'rgba(59,130,246,0.40)',   label: 'Jarvis — watching the desktop' },
  listening: { core: '#34d399',                glow: 'rgba(52,211,153,0.55)',    label: 'Jarvis — listening to you' },
  seeing:    { core: '#22d3ee',                glow: 'rgba(34,211,238,0.60)',    label: 'Jarvis — looking at the screen' },
  thinking:  { core: '#a78bfa',                glow: 'rgba(167,139,250,0.55)',   label: 'Jarvis — making sense of what she sees' },
  acting:    { core: '#ec4899',                glow: 'rgba(236,72,153,0.60)',    label: 'Jarvis — GIA is acting on the desktop' },
  speaking:  { core: '#fbbf24',                glow: 'rgba(251,191,36,0.50)',    label: 'Jarvis — speaking' },
};

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
  const engaged = state !== 'off' && state !== 'idle';

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

  const ringSpin =
    state === 'acting' ? 'jarvis-orb-spin 1.5s linear infinite'
    : state === 'thinking' ? 'jarvis-orb-spin 2.2s linear infinite'
    : state === 'seeing' ? 'jarvis-orb-spin 1.1s linear infinite'
    : undefined;

  const coreAnim =
    state === 'listening' ? 'jarvis-orb-pulse 0.9s ease-in-out infinite'
    : state === 'speaking' ? 'jarvis-orb-pulse 1.25s ease-in-out infinite'
    : state === 'seeing' ? 'jarvis-orb-flicker 0.7s ease-in-out infinite'
    : state === 'thinking' ? 'jarvis-orb-breathe 1.5s ease-in-out infinite'
    : state === 'acting' ? 'jarvis-orb-flicker 0.42s ease-in-out infinite'
    : enabled ? 'jarvis-orb-breathe 3.4s ease-in-out infinite'
    : engaged ? 'jarvis-orb-breathe 2.2s ease-in-out infinite'
    : undefined;

  const vars = { '--jarvis-core': meta.core, '--jarvis-glow': meta.glow } as React.CSSProperties;

  if (hidden) return null;

  return (
    <div
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
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onMouseEnter={() => setShowTip(true)}
      onMouseLeave={() => setShowTip(false)}
      title=""
    >
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
        @keyframes jarvis-orb-spin { to { transform: rotate(360deg); } }
        @keyframes jarvis-orb-breathe {
          0%, 100% { filter: brightness(0.85); }
          50% { filter: brightness(1.25); }
        }
        @keyframes jarvis-orb-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.16); }
        }
        @keyframes jarvis-orb-flicker {
          0%, 100% { filter: brightness(0.7); }
          50% { filter: brightness(1.55); }
        }
      `}</style>

      <div className="jarvis-aura" style={{ '--jarvis-glow': meta.glow } as React.CSSProperties} />

      <div className="jarvis-ring" style={{ ...vars, animation: ringSpin }}>
        <span
          className="absolute -top-[4px] left-1/2 -translate-x-1/2 h-2 w-2 rounded-full"
          style={{ background: meta.core, boxShadow: `0 0 10px ${meta.glow}` }}
        />
      </div>

      <div
        className="jarvis-core"
        style={{ ...vars, animation: coreAnim, opacity: paused ? 0.5 : 1 }}
      />

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