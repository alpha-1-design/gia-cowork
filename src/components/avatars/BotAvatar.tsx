import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { VIZ_COLORS } from '../visual/palette';

/**
 * BotAvatar — the visual identity of a swarm lane.
 *
 * The user mandate is "the bots need to look so cool" — NOT flat identicons.
 * This is a 4-layer SVG bot:
 *
 *   1. SILHOUETTE — 6 head archetypes (rounded pod, hexcore, visor-bar
 *      helmet, orb-shell echoing GIA's OrbAvatar halo language, twin-tower,
 *      crest), picked deterministically from a hash of the agent id.
 *   2. FACE — eye styles (visor slit, twin dots, tri-dot, scanline) plus
 *      mouth/badge variants, drawn in a band every silhouette leaves clear.
 *   3. ACCENT — antenna shapes, side vents or wings, and the chest core dot
 *      which doubles as the live-status indicator: pulsing while the lane
 *      runs, static while queued, a red ✕ when the lane failed — so status
 *      is readable on the avatar itself, without the row's status ring.
 *   4. FINISH — radial gradient body + soft outer glow (the OrbAvatar glow
 *      pattern) + a thin 1px highlight rim, in a 2-color scheme drawn from
 *      the visual palette (primary body + complementary accent).
 *
 * ROLE-CARRIED SHAPE: when the lane has a persona/role, the silhouette/eye
 * choice is biased so the role stays recognizable across a lane of 200 —
 * builder bots look constructed (hexcore, tri-dot), analyst bots wear
 * visors with a scanline, skeptics get the stern visor slit, creatives get
 * the orb-shell. Color stays hash-driven so a lane of 200 doesn't march in
 * lockstep; shape carries the role.
 *
 * DETERMINISM: same agentId → byte-identical SVG. Everything — layer picks,
 * colors, motion timing — derives from an FNV-1a hash of the id; gradient
 * ids are hash-derived too (not React.useId, which varies per instance), so
 * two mounts of the same agent render identical markup. `botAvatarParams`
 * is exported pure for the pin test.
 *
 * LIFE: subtle idle motion via `motion` — a 2-3s breathe/float on the whole
 * bot and an occasional antenna blink. `prefers-reduced-motion` disables ALL
 * of it, and the `animate` prop turns it off entirely (dense lane grids pass
 * animate={false} to protect the frame budget). The same geometry renders
 * from 16px (activity strip) through 64px (drawer) to 128px (hero card)
 * because everything is drawn in one fixed viewBox.
 *
 * Tokens: status/muted colors come from var(--gia-*) where a theme color
 * exists; lane identity colors come from the shared visual palette.
 */

// ── Public types ───────────────────────────────────────────────────────────

export type BotStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface BotAvatarParams {
  /** FNV-1a hash of the agent id — the seed every visual choice derives from. */
  hash: number;
  /** Head archetype index 0-5 (pod, hexcore, visor-bar, orb-shell, twin-tower, crest). */
  silhouette: number;
  /** Eye style index 0-3 (visor slit, twin dots, tri-dot, scanline). */
  eyes: number;
  /** Mouth/badge variant index 0-2 (speaker bars, badge bar, none). */
  mouth: number;
  /** Antenna shape index 0-2 (ball tip, split, ring). */
  antenna: number;
  /** true = side vents, false = small fins. */
  vents: boolean;
  /** Primary body color from the shared visual palette. */
  primary: string;
  /** Complementary accent (eyes, antenna, core trim) — always ≠ primary. */
  accent: string;
  /** Idle float start offset in seconds, so 200 bots don't bob in sync. */
  floatDelay: number;
  /** Idle breathe duration in seconds (2.4–3.5). */
  breatheDuration: number;
  /** Antenna blink delay in seconds. */
  blinkDelay: number;
}

export interface BotAvatarProps {
  agentId: string;
  /** Persona/role when known — biases silhouette + eyes (see ROLE_BIAS). */
  role?: string;
  /** Lane status; drives the chest-core indicator. */
  status?: BotStatus;
  /** One component, any size: 16 (strip) → 40 (lane row) → 64 (drawer) → 128 (hero). */
  size?: number;
  /** Idle motion switch — off in dense grids (>50 visible rows). */
  animate?: boolean;
  /** Optional primary-color override (e.g. the task record's agent color). */
  color?: string;
  className?: string;
}

// ── Deterministic derivation ───────────────────────────────────────────────

/** FNV-1a 32-bit — tiny, stable across sessions, no Math.random anywhere. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Role → shape bias. Keys are matched as substrings of the lowercased role,
 * first match wins, covering the AGENT_ROLES vocabulary (Researcher,
 * Analyst, Skeptic, …) and free-text personas. Unmatched roles fall back to
 * pure hash so unknown personas still get a distinct identity.
 */
const ROLE_BIAS: { keys: string[]; silhouette?: number; eyes?: number }[] = [
  // Builder/technologist bots look CONSTRUCTED: hexcore chassis, tri-dot.
  { keys: ['technolog', 'code', 'build', 'engineer', 'implement', 'system'], silhouette: 1, eyes: 2 },
  // Analysts/researchers wear INSTRUMENTS: visor-bar helmet with a scanline.
  { keys: ['research', 'analyst', 'data', 'search', 'archiv'], silhouette: 2, eyes: 3 },
  // Skeptics/critics/validators get the stern visor SLIT.
  { keys: ['skeptic', 'critic', 'valid', 'verif', 'check', 'fact', 'ethic'], silhouette: 2, eyes: 0 },
  // Creatives get the orb-shell — the OrbAvatar halo echo, glowing ideas.
  { keys: ['creat', 'idea', 'brainstorm', 'design', 'innovat', 'optimist'], silhouette: 3, eyes: 2 },
  // Synthesizers/strategists/diplomats hold two sides: twin-tower.
  { keys: ['synthes', 'strateg', 'plan', 'diplomat', 'connect', 'integrat', 'merge'], silhouette: 4, eyes: 1 },
  // Teachers/philosophers/deep thinkers: crest, calm twin dots.
  { keys: ['teach', 'philos', 'deep', 'expla', 'intuition'], silhouette: 5, eyes: 1 },
];

/**
 * Pure, deterministic identity for one agent id. Same id → identical params,
 * regardless of environment, render count or position in the tree.
 */
export function botAvatarParams(agentId: string, role?: string): BotAvatarParams {
  const hash = fnv1a(agentId);
  let silhouette = hash % 6;
  let eyes = (hash >>> 3) % 4;
  const roleLower = (role ?? '').trim().toLowerCase();
  if (roleLower) {
    const bias = ROLE_BIAS.find(b => b.keys.some(k => roleLower.includes(k)));
    if (bias) {
      if (bias.silhouette !== undefined) silhouette = bias.silhouette;
      if (bias.eyes !== undefined) eyes = bias.eyes;
    }
  }
  const primaryIndex = (hash >>> 4) % VIZ_COLORS.length;
  return {
    hash,
    silhouette,
    eyes,
    mouth: (hash >>> 6) % 3,
    antenna: (hash >>> 9) % 3,
    vents: ((hash >>> 12) & 1) === 0,
    primary: VIZ_COLORS[primaryIndex],
    accent: VIZ_COLORS[(primaryIndex + 3) % VIZ_COLORS.length],
    floatDelay: Math.round((((hash >>> 8) % 100) / 100) * 2 * 100) / 100,
    breatheDuration: Math.round((2.4 + ((hash >>> 16) % 12) / 10) * 10) / 10,
    blinkDelay: (hash >>> 20) % 4,
  };
}

// ── Status colors (chest core + row ring share this table) ─────────────────

/** Theme-aware where tokens exist; lane colors are palette literals. */
export const BOT_STATUS_COLOR: Record<BotStatus, string> = {
  idle: 'var(--gia-muted-2)',
  queued: 'var(--gia-muted)',
  running: '#34d399',
  done: '#10b981',
  failed: '#f87171',
  cancelled: 'var(--gia-muted-2)',
};

// ── Geometry (one 48-unit viewBox scales to every size) ────────────────────

const CX = 24;
/** Face band every silhouette leaves clear, and the chest-core position. */
const EYE_Y = 23;
const CORE_X = CX;
const CORE_Y = 35.8;
const CORE_R = 2.1;

type SilhouetteNode = React.ReactElement;

/**
 * The 6 head archetypes. Each is filled with the body gradient and stroked
 * with the highlight rim by the renderer, so they stay declarative here.
 */
const SILHOUETTES: SilhouetteNode[] = [
  // 0 — rounded pod: soft capsule, the friendly default.
  <rect key="pod" x={9} y={8} width={30} height={32} rx={15} />,
  // 1 — hexcore: constructed, engineering-grade.
  <path key="hex" d="M24 6 L38 14 L38 34 L24 42 L10 34 L10 14 Z" />,
  // 2 — visor-bar helmet: broad crown, square jaw — wears instruments.
  <path key="visor" d="M8 16 Q8 8 16 8 H32 Q40 8 40 16 V33 Q40 38 35 38 H13 Q8 38 8 33 Z" />,
  // 3 — orb-shell: GIA's OrbAvatar halo language, echo arcs around a sphere.
  <g key="orb">
    <circle cx={CX} cy={23} r={15} />
    <path d="M7.5 18 A17.5 17.5 0 0 1 19 6.8" fill="none" strokeWidth={1.1} strokeLinecap="round" opacity={0.55} />
    <path d="M40.5 28 A17.5 17.5 0 0 1 29 39.2" fill="none" strokeWidth={1.1} strokeLinecap="round" opacity={0.55} />
  </g>,
  // 4 — twin-tower: two parallel lobes — holds two sides together.
  <g key="twin">
    <rect x={10} y={9} width={12} height={30} rx={6} />
    <rect x={26} y={9} width={12} height={30} rx={6} />
  </g>,
  // 5 — crest: helmet with a dorsal fin.
  <g key="crest">
    <path d="M20 11 L24 3.5 L28 11 Z" />
    <path d="M8 17 Q8 9 16 9 H32 Q40 9 40 17 V33 Q40 38 35 38 H13 Q8 38 8 33 Z" />
  </g>,
];

// ── Component ──────────────────────────────────────────────────────────────

const BotAvatar: React.FC<BotAvatarProps> = ({
  agentId,
  role,
  status = 'idle',
  size = 40,
  animate = true,
  color,
  className = '',
}) => {
  const params = React.useMemo(() => botAvatarParams(agentId, role), [agentId, role]);
  const reduceMotion = useReducedMotion();
  const live = animate && !reduceMotion;

  const primary = color ?? params.primary;
  const accent = params.accent;
  // Hash-derived gradient ids (NOT useId): two instances of the same agent
  // render byte-identical SVG. Collisions only matter for identical agents,
  // whose defs are identical anyway.
  const uid = `bot${params.hash.toString(36)}`;

  return (
    <motion.div
      className={`relative shrink-0 inline-flex ${className}`}
      style={{ width: size, height: size }}
      data-bot-status={status}
      data-bot-motion={live ? 'float' : 'off'}
      animate={live ? { y: [0, -size * 0.055, 0] } : undefined}
      transition={live ? { duration: params.breatheDuration, repeat: Infinity, ease: 'easeInOut', delay: params.floatDelay } : undefined}
    >
      {/* Outer glow — the OrbAvatar glow pattern, keyed to this bot's color */}
      <div
        className="absolute rounded-full pointer-events-none"
        style={{
          inset: -size * 0.2,
          background: `radial-gradient(circle, ${primary}40 0%, transparent 70%)`,
          filter: 'blur(5px)',
          opacity: 0.8,
        }}
      />

      <svg width={size} height={size} viewBox="0 0 48 48" className="relative" role="img" aria-label={`Bot ${agentId}`}>
        <defs>
          {/* Body — radial gradient like OrbAvatar's sphere, light from top-left */}
          <radialGradient id={`${uid}-body`} cx="38%" cy="30%" r="80%">
            <stop offset="0%" stopColor={primary} stopOpacity="0.95" />
            <stop offset="45%" stopColor={primary} stopOpacity="0.72" />
            <stop offset="100%" stopColor={primary} stopOpacity="0.3" />
          </radialGradient>
          {/* Thin 1px highlight rim: bright on top, fading to the bottom */}
          <linearGradient id={`${uid}-rim`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
            <stop offset="55%" stopColor="#ffffff" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Ground shadow grounds the float */}
        <ellipse cx={CX} cy={43.5} rx={11} ry={2} fill="var(--gia-overlay-3)" />

        {/* ── Layer 1: silhouette ── */}
        <g fill={`url(#${uid}-body)`} stroke={`url(#${uid}-rim)`} strokeWidth={1}>
          {SILHOUETTES[params.silhouette]}
        </g>

        {/* ── Layer 3a: antenna (drawn before the face so tips never cover eyes) ── */}
        <g stroke={accent} strokeWidth={1.2} strokeLinecap="round">
          {params.antenna === 0 && (
            <g>
              <line x1={CX} y1={8} x2={CX} y2={4.5} />
              {live ? (
                <motion.circle
                  cx={CX} cy={3.4} r={2} fill={accent} stroke="none"
                  data-antenna-blink="true"
                  animate={{ opacity: [0.35, 1, 0.35] }}
                  transition={{ duration: 1.4, repeat: Infinity, repeatDelay: 3.6, delay: params.blinkDelay }}
                />
              ) : (
                <circle cx={CX} cy={3.4} r={2} fill={accent} stroke="none" opacity={0.9} />
              )}
            </g>
          )}
          {params.antenna === 1 && (
            <g fill={accent}>
              <line x1={19} y1={9.5} x2={16.5} y2={5} fill="none" />
              <line x1={29} y1={9.5} x2={31.5} y2={5} fill="none" />
              {live ? (
                <motion.g
                  data-antenna-blink="true"
                  animate={{ opacity: [0.35, 1, 0.35] }}
                  transition={{ duration: 1.4, repeat: Infinity, repeatDelay: 3.6, delay: params.blinkDelay }}
                >
                  <circle cx={16.5} cy={4} r={1.6} stroke="none" />
                  <circle cx={31.5} cy={4} r={1.6} stroke="none" />
                </motion.g>
              ) : (
                <g opacity={0.9}>
                  <circle cx={16.5} cy={4} r={1.6} stroke="none" />
                  <circle cx={31.5} cy={4} r={1.6} stroke="none" />
                </g>
              )}
            </g>
          )}
          {params.antenna === 2 && (
            <g>
              <line x1={CX} y1={8} x2={CX} y2={5} />
              <circle cx={CX} cy={3.6} r={2.1} fill="none" />
            </g>
          )}
        </g>

        {/* ── Layer 3b: side vents or fins ── */}
        {params.vents ? (
          <g stroke={accent} strokeWidth={1.2} strokeLinecap="round" opacity={0.5}>
            <line x1={5.5} y1={26} x2={9.5} y2={26} />
            <line x1={5.5} y1={29} x2={9.5} y2={29} />
            <line x1={5.5} y1={32} x2={9.5} y2={32} />
            <line x1={38.5} y1={26} x2={42.5} y2={26} />
            <line x1={38.5} y1={29} x2={42.5} y2={29} />
            <line x1={38.5} y1={32} x2={42.5} y2={32} />
          </g>
        ) : (
          <g fill={accent} opacity={0.4}>
            <path d="M10 26 L4.5 31 L10 33 Z" />
            <path d="M38 26 L43.5 31 L38 33 Z" />
          </g>
        )}

        {/* ── Layer 2: face ── */}
        <g>
          {params.eyes === 0 && (
            // Visor slit — the stern one-piece visor.
            <rect x={13} y={EYE_Y - 2.2} width={22} height={4.4} rx={2.2} fill={accent} />
          )}
          {params.eyes === 1 && (
            // Twin dots.
            <g fill={accent}>
              <circle cx={17} cy={EYE_Y} r={2.4} />
              <circle cx={31} cy={EYE_Y} r={2.4} />
            </g>
          )}
          {params.eyes === 2 && (
            // Tri-dot.
            <g fill={accent}>
              <circle cx={16} cy={EYE_Y} r={2} />
              <circle cx={CX} cy={EYE_Y} r={2.6} />
              <circle cx={32} cy={EYE_Y} r={2} />
            </g>
          )}
          {params.eyes === 3 && (
            // Scanline — full trace plus a brighter sweep segment whose
            // position is hash-picked, so each bot scans at its own offset.
            <g>
              <line x1={12} y1={EYE_Y} x2={36} y2={EYE_Y} stroke={accent} strokeWidth={1.2} strokeLinecap="round" opacity={0.4} />
              <line
                x1={13 + (params.hash >>> 24) % 15} y1={EYE_Y}
                x2={19 + (params.hash >>> 24) % 15} y2={EYE_Y}
                stroke={accent} strokeWidth={1.6} strokeLinecap="round"
              />
            </g>
          )}

          {/* Mouth / badge variants */}
          {params.mouth === 0 && (
            // Speaker bars.
            <g fill={accent} opacity={0.7}>
              <rect x={19} y={28.5} width={2} height={4} rx={1} />
              <rect x={23} y={28.5} width={2} height={4} rx={1} />
              <rect x={27} y={28.5} width={2} height={4} rx={1} />
            </g>
          )}
          {params.mouth === 1 && (
            // Badge bar.
            <rect x={17} y={29.5} width={14} height={3} rx={1.5} fill={accent} opacity={0.55} />
          )}
          {/* mouth 2: none — some bots just don't talk */}
        </g>

        {/* ── Layer 3c: chest core — the live status indicator ── */}
        <g data-core-status={status}>
          {status === 'failed' ? (
            // Red ✕ — failure readable on the bot itself, no ring needed.
            <g>
              <circle cx={CORE_X} cy={CORE_Y} r={CORE_R + 0.9} fill="rgba(239,68,68,0.18)" />
              <path
                d={`M${CORE_X - 1.3} ${CORE_Y - 1.3} L${CORE_X + 1.3} ${CORE_Y + 1.3} M${CORE_X + 1.3} ${CORE_Y - 1.3} L${CORE_X - 1.3} ${CORE_Y + 1.3}`}
                stroke={BOT_STATUS_COLOR.failed} strokeWidth={1.5} strokeLinecap="round" fill="none"
              />
            </g>
          ) : status === 'cancelled' ? (
            <circle cx={CORE_X} cy={CORE_Y} r={CORE_R} fill="none" stroke={BOT_STATUS_COLOR.cancelled} strokeWidth={1.2} />
          ) : status === 'running' ? (
            live ? (
              // Pulsing while the lane runs — opacity pulse + a soft halo ring.
              <g>
                <motion.circle
                  cx={CORE_X} cy={CORE_Y} r={CORE_R + 2.4} fill="none" stroke={BOT_STATUS_COLOR.running}
                  strokeWidth={1} data-core-pulse="halo"
                  animate={{ opacity: [0.55, 0, 0.55] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                />
                <motion.circle
                  cx={CORE_X} cy={CORE_Y} r={CORE_R} fill={BOT_STATUS_COLOR.running} data-core-pulse="dot"
                  animate={{ opacity: [1, 0.45, 1] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                />
              </g>
            ) : (
              // Reduced motion / dense grid: same status, calm rendering.
              <circle cx={CORE_X} cy={CORE_Y} r={CORE_R} fill={BOT_STATUS_COLOR.running} />
            )
          ) : status === 'queued' ? (
            // Static while queued — waiting, not dead.
            <circle cx={CORE_X} cy={CORE_Y} r={CORE_R} fill={BOT_STATUS_COLOR.queued} />
          ) : status === 'done' ? (
            <circle cx={CORE_X} cy={CORE_Y} r={CORE_R} fill={BOT_STATUS_COLOR.done} />
          ) : (
            // idle: the bot's own accent, dim.
            <circle cx={CORE_X} cy={CORE_Y} r={CORE_R} fill={accent} opacity={0.75} />
          )}
        </g>
      </svg>
    </motion.div>
  );
};

export default BotAvatar;
