import { useGiaStore } from '../store/useGiaStore';
import { TOOL_LABELS } from '../utils/toolLabels';

export type ThinkingPhase =
  | 'gathering'
  | 'analyzing'
  | 'coding'
  | 'writing'
  | 'searching'
  | 'planning'
  | 'reasoning'
  | 'processing'
  | 'idle';

const PHASE_MAP: Record<ThinkingPhase, string> = {
  gathering: 'Reading context',
  analyzing: 'Checking the facts',
  coding: 'Writing the change',
  writing: 'Drafting the answer',
  searching: 'Searching',
  planning: 'Planning the move',
  reasoning: 'Thinking it through',
  processing: 'Running a tool',
  idle: 'Ready',
};

const BUILD_PHASE_MAP: Partial<Record<ThinkingPhase, string>> = {
  planning: 'Deciding the shape',
  gathering: 'Reading the project',
  coding: 'Writing the app',
  processing: 'Checking it runs',
  reasoning: 'Fixing what failed',
};



/** Shared with the streaming cursor. Not a component. */
export function statusLabel(phase?: ThinkingPhase, toolName?: string | null): string {
  if (toolName && TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  if (toolName) return toolName.replace(/_/g, ' ');
  if (phase && PHASE_MAP[phase]) return PHASE_MAP[phase];
  return 'Thinking';
}

/**
 * One stable line.
 *
 * The label does not rotate, fade per letter, or change colour mid-thought.
 * That was the phone app's final thinking state, and it is deliberately the
 * same here: one dot, one label, no personality performance while the user is
 * waiting for work to finish. The phase vocabulary is shared with the tool
 * labels so the line says what is actually happening, not a mood.
 */
export function ThinkingStatus({ phase, toolName, onTap }: { phase?: ThinkingPhase; toolName?: string | null; onTap?: () => void }) {
  const buildMode = useGiaStore(s => s.buildMode);
  const activePhase: ThinkingPhase = phase && phase !== 'idle' ? phase : (buildMode ? 'coding' : 'processing');
  const label = toolName
    ? (TOOL_LABELS[toolName] ?? toolName.replace(/_/g, ' '))
    : (buildMode ? (BUILD_PHASE_MAP[activePhase] ?? PHASE_MAP[activePhase]) : PHASE_MAP[activePhase]);

  return (
    <div
      onClick={onTap}
      role={onTap ? 'button' : undefined}
      className="inline-flex items-center gap-2 py-1"
      style={{ cursor: onTap ? 'pointer' : 'default' }}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0 animate-pulse" style={{ background: 'var(--gia-text)' }} />
      <span
        className="text-[13px] font-medium"
        style={{
          backgroundImage: 'linear-gradient(90deg, var(--gia-muted) 0%, var(--gia-text) 45%, var(--gia-muted) 90%)',
          backgroundSize: '200% 100%',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
          animation: 'shimmer 2.8s linear infinite',
        }}
      >
        {label}
      </span>
    </div>
  );
}
