import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Globe } from 'lucide-react';
import { useGiaStore } from '../store/useGiaStore';
import { useProtocolStore } from '../store/useProtocolStore';
import { useSyncExternalStore } from 'react';
import { browserSession } from '../services/browser/BrowserSession';
import { TOOL_LABELS } from '../utils/toolLabels';

/**
 * "What is she doing right now?"
 *
 * Every competing desktop agent converged on the same instinct: the UI should
 * assume many things in flight and the human is in the orchestrator seat. But
 * watching that means watching *trajectories*, not just finished answers — and
 * GIA's activity was scattered across a reasoning chain, a protocol console, a
 * work log and a Jarvis panel. All of those are archives. None of them answer
 * the only question that matters while you wait.
 *
 * So this is deliberately small and deliberately singular. One line: what is
 * happening, for how long, and how do I stop it. It does not summarise, does
 * not decorate, and disappears the instant nothing is running — because a
 * permanent status bar is a permanent thing to look past.
 */

export function AgentActivityStrip() {
  const currentTool = useGiaStore(s => s.currentTool);
  const executing = useProtocolStore(s =>
    s.protocols.filter(p => p.state === 'executing').map(p => p.type + p.id).join(','),
  );

  const tabCount = useSyncExternalStore(
    browserSession.subscribe,
    browserSession.listSnapshot,
    browserSession.listSnapshot,
  ).length;

  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);

  const busy = Boolean(currentTool) || Boolean(executing);

  // Elapsed time only ticks while something is actually running. A timer that
  // runs forever in the background is a timer that costs battery forever.
  useEffect(() => {
    if (busy) {
      startedAt.current = Date.now();
      setElapsed(0);
      const t = setInterval(() => {
        if (startedAt.current) setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
      }, 1000);
      return () => clearInterval(t);
    }
    startedAt.current = null;
    setElapsed(0);
    return undefined;
  }, [busy]);

  if (!busy) return null;

  const toolLabel = currentTool ? (TOOL_LABELS[currentTool] ?? currentTool) : 'Working';
  const steps = executing ? executing.split(',').length : 0;

  return (
    <div
      data-testid="agent-activity-strip"
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px]"
      style={{
        background: 'var(--gia-surface-2)',
        border: '1px solid var(--gia-border)',
        color: 'var(--gia-muted)',
      }}
    >
      <Loader2 size={11} className="animate-spin shrink-0" style={{ color: '#a855f7' }} />
      <span className="font-medium shrink-0" style={{ color: 'var(--gia-text)' }}>{toolLabel}</span>

      {steps > 0 && (
        <span className="px-1.5 py-0.5 rounded text-[9px] shrink-0"
          style={{ background: 'rgba(168,85,247,0.12)', color: '#a855f7' }}>
          {steps} step{steps === 1 ? '' : 's'}
        </span>
      )}

      {tabCount > 0 && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] shrink-0"
          style={{ background: 'rgba(20,184,166,0.12)', color: '#14b8a6' }}
          title={`${tabCount} page${tabCount === 1 ? '' : 's'} open in the browser panel`}
        >
          <Globe size={9} />
          {tabCount}
        </span>
      )}

      <span className="font-mono text-[10px] shrink-0" data-testid="agent-activity-elapsed">
        {formatElapsed(elapsed)}
      </span>

      <div className="flex-1" />
      <span className="text-[9px] opacity-60 shrink-0 hidden sm:inline">
        Esc to stop
      </span>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export default AgentActivityStrip;