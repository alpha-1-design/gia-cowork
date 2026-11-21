import { type ClassValue, clsx } from "clsx";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ComponentProps,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { twMerge } from "tailwind-merge";
import { type OrbState, ThinkingOrb } from "thinking-orbs";

// Upstream: https://github.com/shadcn-ui/ui registry "ai-orb". Local changes:
// - no "use client" directive (Vite, not Next.js);
// - ThinkingOrb's theme pins to `dark` when the app's data-theme is
//   `obsidian-aurora` (the library's auto-detect only knows dark|light).
// Everything else is kept verbatim so future upstream updates diff cleanly.

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------- states

/** What the agent is doing. Screens speak in these; only the table below knows the animations. */
export const AI_ORB_STATES = [
  "idle",
  "listening",
  "thinking",
  "reasoning",
  "tool-call",
  "tool-result",
  "streaming",
  "waiting-approval",
  "error",
  "done",
] as const;

export type AiOrbState = (typeof AI_ORB_STATES)[number];

/** Tint of the orb, always a theme token. */
export type AiOrbTone = "muted" | "primary" | "attention" | "critical";

type OrbVisual = {
  orb: OrbState;
  tone: AiOrbTone;
  /** Multiplier on the library's tuned speed. */
  speed: number;
  /** A frozen frame instead of an animation. */
  paused: boolean;
  /** A resting state: it moves for `settleMs` after it starts, then holds still. */
  settles: boolean;
};

const CALM = 0.6;

const VISUALS: Record<AiOrbState, OrbVisual> = {
  done: {
    orb: "breathing",
    paused: false,
    settles: true,
    speed: CALM,
    tone: "primary",
  },
  error: {
    orb: "breathing",
    paused: true,
    settles: false,
    speed: 1,
    tone: "critical",
  },
  idle: {
    orb: "breathing",
    paused: false,
    settles: true,
    speed: CALM,
    tone: "muted",
  },
  listening: {
    orb: "listening",
    paused: false,
    settles: true,
    speed: 1,
    tone: "primary",
  },
  reasoning: {
    orb: "solving",
    paused: false,
    settles: false,
    speed: 1,
    tone: "primary",
  },
  streaming: {
    orb: "composing",
    paused: false,
    settles: false,
    speed: 1,
    tone: "primary",
  },
  thinking: {
    orb: "working",
    paused: false,
    settles: false,
    speed: 1,
    tone: "primary",
  },
  "tool-call": {
    orb: "searching",
    paused: false,
    settles: false,
    speed: 1,
    tone: "primary",
  },
  "tool-result": {
    orb: "connecting",
    paused: false,
    settles: false,
    speed: 1,
    tone: "primary",
  },
  "waiting-approval": {
    orb: "shaping",
    paused: false,
    settles: true,
    speed: 0.8,
    tone: "attention",
  },
};

/** Theme variables per tone, first one defined wins. Raw hexes are allowed
 *  as final fallbacks for apps whose semantic tokens are hard-coded (this
 *  repo's TrustGate palette). */
const TONE_TOKENS: Record<AiOrbTone, readonly string[]> = {
  attention: ["--color-warning", "--color-chart-5", "--chart-5", "--gia-accent"],
  critical: ["--color-destructive", "--destructive", "#ef4444"],
  muted: ["--color-muted-foreground", "--muted-foreground", "--gia-muted-2"],
  primary: ["--color-primary", "--primary", "--gia-text"],
};

export const AI_ORB_LABELS: Record<AiOrbState, string> = {
  done: "Assistant has finished",
  error: "Assistant ran into an error",
  idle: "Assistant is ready",
  listening: "Assistant is listening",
  reasoning: "Assistant is reasoning",
  streaming: "Assistant is writing the answer",
  thinking: "Assistant is thinking",
  "tool-call": "Assistant is using a tool",
  "tool-result": "Assistant is reading tool results",
  "waiting-approval": "Assistant is waiting for your answer",
};

/** What the last part of the assistant's message is. */
export type AgentActivity =
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "text"
  | "question";

/** The orb while the answer streams, by the agent's latest activity. */
const LIVE_STATE: Record<AgentActivity, AiOrbState> = {
  question: "waiting-approval",
  reasoning: "reasoning",
  text: "streaming",
  "tool-call": "tool-call",
  "tool-result": "tool-result",
};

/**
 * Orb state from a chat status (`useChat` in the AI SDK uses the same four values) and what the
 * agent did last. `hasDraft` makes an idle orb listen while the person types.
 */
export function orbStateFor({
  status,
  activity,
  hasDraft = false,
  hasAnswered = false,
}: {
  status: "ready" | "submitted" | "streaming" | "error";
  activity?: AgentActivity;
  hasDraft?: boolean;
  hasAnswered?: boolean;
}): AiOrbState {
  if (status === "error") {
    return "error";
  }
  if (status === "submitted") {
    return "thinking";
  }
  if (status === "streaming") {
    return activity ? LIVE_STATE[activity] : "thinking";
  }
  if (activity === "question") {
    return "waiting-approval";
  }
  if (hasDraft) {
    return "listening";
  }
  return hasAnswered ? "done" : "idle";
}

// ---------------------------------------------------------------- theme colour

/**
 * The orb paints on a canvas and takes its tint as a hex string, while a theme defines its tokens
 * in any CSS colour syntax. The browser resolves the token on a hidden probe and a 1×1 canvas
 * converts it to sRGB hex. Re-read when `<html>` changes class, style or `data-theme`.
 */
function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributeFilter: ["class", "style", "data-theme"],
    attributes: true,
  });
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    scheme.removeEventListener("change", onChange);
  };
}

let painter: CanvasRenderingContext2D | null | undefined;

function resolveTokens(
  tokens: readonly string[],
  host: HTMLElement
): string | undefined {
  const probe = document.createElement("span");
  probe.style.display = "none";
  // Nested fallbacks; an undefined chain ends in transparent, which reads as "not resolved".
  // A leading `#` is a literal colour, not a variable name.
  probe.style.color = tokens.reduceRight(
    (fallback, token) => (token.startsWith("#") ? token : `var(${token}, ${fallback})`),
    "transparent"
  );
  // Inside the orb, so a theme scoped to a container (`.dark` on a wrapper) applies too.
  host.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  if (painter === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    painter = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!(painter && computed)) {
    return;
  }
  painter.clearRect(0, 0, 1, 1);
  painter.fillStyle = "transparent";
  painter.fillStyle = computed;
  painter.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = painter.getImageData(0, 0, 1, 1).data;
  if (!a) {
    return;
  }
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Live hex value of the tone's token, read where the orb sits; `undefined` until mounted. */
function useOrbColor(
  host: RefObject<HTMLElement | null>,
  tone: AiOrbTone,
  override?: string
): string | undefined {
  const [color, setColor] = useState<string | undefined>(undefined);
  const read = useCallback(() => {
    if (host.current) {
      setColor(
        resolveTokens(override ? [override] : TONE_TOKENS[tone], host.current)
      );
    }
  }, [host, override, tone]);
  useEffect(() => {
    read();
    return subscribeTheme(read);
  }, [read]);
  return color;
}

const noop = () => () => undefined;

// ---------------------------------------------------------------- component

const SIZE = {
  lg: { box: "size-16", dot: 1, px: 64 as const },
  md: { box: "size-8", dot: 1.15, px: 32 as const },
  sm: { box: "size-5", dot: 1.3, px: 20 as const },
} as const;

export type AiOrbProps = Omit<
  ComponentProps<"span">,
  "aria-hidden" | "aria-label" | "children" | "role"
> & {
  state: AiOrbState;
  /** `sm` sits inline with text (20 px), `md` is a compact avatar (32 px), `lg` an avatar (64 px). */
  size?: keyof typeof SIZE;
  /** Accessible name; defaults to a sentence describing the state. */
  label?: string;
  /** Hide from assistive technology when nearby text already says the same. */
  decorative?: boolean;
  /** A theme variable that replaces the state's tint, e.g. `--color-chart-2`. */
  colorToken?: string;
  /** How long a resting state keeps moving before it holds still, ms. Default 5000. */
  settleMs?: number;
};

/** `true` once a resting state has lasted `settleMs`; any state change starts over. */
function useSettled(state: AiOrbState, settles: boolean, settleMs: number) {
  const [settledState, setSettledState] = useState<AiOrbState | null>(null);
  useEffect(() => {
    setSettledState(null);
    if (!settles) {
      return;
    }
    const timer = setTimeout(() => setSettledState(state), settleMs);
    return () => clearTimeout(timer);
  }, [settleMs, settles, state]);
  return settles && settledState === state;
}

/**
 * Animated agent-state indicator over `thinking-orbs`. Pass what the agent is doing; the orb
 * picks the animation, its pace and a theme tint, and crossfades between animations. Resting
 * states stop moving after a few seconds (WCAG 2.2.2), and `prefers-reduced-motion` gets a
 * still frame.
 */
export function AiOrb({
  state,
  size = "lg",
  label,
  decorative = false,
  colorToken,
  settleMs = 5000,
  className,
  ...rest
}: AiOrbProps) {
  const visual = VISUALS[state];
  const reduced = useReducedMotion() ?? false;
  const settled = useSettled(state, visual.settles, settleMs);
  const host = useRef<HTMLSpanElement>(null);
  const color = useOrbColor(host, visual.tone, colorToken);
  const [themeMode, setThemeMode] = useState<"dark" | "light">("dark");
  // Client-only canvas: render the box on the server, the orb after hydration.
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false
  );
  const preset = SIZE[size];
  const a11y = decorative
    ? { "aria-hidden": true }
    : { "aria-label": label ?? AI_ORB_LABELS[state], role: "img" };

  // This app's themes are dark | light | system | obsidian-aurora on
  // <html data-theme>. The library's auto-detect only understands
  // dark|light, so resolve the effective mode here once per theme change.
  useEffect(() => {
    const read = () => {
      const t = document.documentElement.getAttribute("data-theme");
      if (t === "light") setThemeMode("light");
      else if (t === "dark" || t === "obsidian-aurora") setThemeMode("dark");
      else setThemeMode(window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    };
    read();
    return subscribeTheme(read);
  }, []);

  return (
    <span
      {...rest}
      {...a11y}
      className={cn("relative inline-block shrink-0", preset.box, className)}
      data-orb={visual.orb}
      data-slot="ai-orb"
      data-state={state}
      ref={host}
    >
      {mounted ? (
        <AnimatePresence initial={false}>
          <motion.span
            animate={{ opacity: 1 }}
            className="absolute inset-0"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            key={`${visual.orb}-${visual.tone}`}
            transition={reduced ? { duration: 0 } : { duration: 0.2 }}
          >
            <ThinkingOrb
              aria-hidden
              color={color}
              dotSize={preset.dot}
              paused={visual.paused || reduced || settled}
              size={preset.px}
              speed={visual.speed}
              state={visual.orb}
              theme={themeMode}
            />
          </motion.span>
        </AnimatePresence>
      ) : null}
    </span>
  );
}

export default AiOrb;
