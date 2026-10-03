import React, { useState, useEffect } from 'react';
import { Moon, Play, Settings2, Sparkles, AlertTriangle, Clock, Loader2 } from 'lucide-react';
import selfImprovement, { type ImprovementRun } from '../../services/SelfImprovement';

/**
 * Self-improvement ("night shift") controls.
 *
 * Off by default and explicit about what it costs, because this feature
 * spends the user's money and writes artefacts while they sleep. Everything
 * it produces is reviewable and reversible here.
 */
export const SelfImprovementSection: React.FC = () => {
  const [config, setConfig] = useState(() => selfImprovement.getConfig());
  const [history, setHistory] = useState<ImprovementRun[]>(() => selfImprovement.getHistory());
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const iv = setInterval(() => setHistory(selfImprovement.getHistory()), 4000);
    return () => clearInterval(iv);
  }, []);

  const update = (patch: Partial<typeof config>) => {
    selfImprovement.updateConfig(patch);
    setConfig(selfImprovement.getConfig());
  };

  const runNow = async () => {
    setRunning(true);
    try {
      await selfImprovement.run('manual');
      setHistory(selfImprovement.getHistory());
    } finally {
      setRunning(false);
    }
  };

  const gate = selfImprovement.canRun('manual');

  return (
    <div className="gia-card p-4" style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderColor: 'rgba(99,102,241,0.25)' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Moon size={14} style={{ color: '#818cf8' }} />
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>
            Self-Improvement
          </span>
        </div>
        <button
          onClick={() => update({ enabled: !config.enabled })}
          className="relative w-9 h-5 rounded-full transition-colors"
          style={{ background: config.enabled ? '#818cf8' : 'var(--gia-overlay-3)' }}
          aria-label="Toggle self-improvement"
        >
          <span
            className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
            style={{ left: config.enabled ? '18px' : '2px' }}
          />
        </button>
      </div>

      <p className="text-[10px] leading-relaxed" style={{ color: 'var(--gia-muted-2)' }}>
        While you're idle, GIA researches what she's bad at — local models especially — writes skills to
        cover the gaps, and leaves notes about what she learned. Nothing is installed or changed on your
        machine; everything she produces is listed here for you to review.
      </p>

      {config.enabled && (
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-[10px]" style={{ color: '#818cf8' }}>
          <Settings2 size={11} />{open ? 'Hide schedule' : 'Schedule'}
        </button>
      )}

      {open && (
        <div className="space-y-3 pt-1">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>
              Runs between
              <div className="flex items-center gap-1 mt-1">
                <input
                  type="number" min={0} max={23} value={config.startHour}
                  onChange={e => update({ startHour: Number(e.target.value) })}
                  className="gia-input text-[11px]" style={{ padding: '4px 6px' }}
                />
                <span className="text-[10px]">and</span>
                <input
                  type="number" min={0} max={23} value={config.endHour}
                  onChange={e => update({ endHour: Number(e.target.value) })}
                  className="gia-input text-[11px]" style={{ padding: '4px 6px' }}
                />
              </div>
            </label>
            <label className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>
              Idle for (minutes)
              <input
                type="number" min={5} max={720} value={config.idleThresholdMinutes}
                onChange={e => update({ idleThresholdMinutes: Number(e.target.value) })}
                className="gia-input text-[11px] mt-1" style={{ padding: '4px 6px' }}
              />
            </label>
            <label className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>
              Max minutes per run
              <input
                type="number" min={1} max={120} value={config.maxMinutesPerRun}
                onChange={e => update({ maxMinutesPerRun: Number(e.target.value) })}
                className="gia-input text-[11px] mt-1" style={{ padding: '4px 6px' }}
              />
            </label>
            <label className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>
              Runs per day
              <input
                type="number" min={1} max={10} value={config.maxRunsPerDay}
                onChange={e => update({ maxRunsPerDay: Number(e.target.value) })}
                className="gia-input text-[11px] mt-1" style={{ padding: '4px 6px' }}
              />
            </label>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={runNow}
          disabled={running || !gate.ok}
          className="gia-btn flex items-center gap-1.5 text-[10px]"
          style={{
            background: 'rgba(129,140,248,0.12)', color: '#818cf8', border: '1px solid rgba(129,140,248,0.25)',
            opacity: running || !gate.ok ? 0.5 : 1,
          }}
          title={gate.ok ? 'Run one improvement pass now' : gate.reason}
        >
          {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
          Run now
        </button>
        {!gate.ok && <span className="text-[9px]" style={{ color: 'var(--gia-muted-2)' }}>{gate.reason}</span>}
      </div>

      {history.length > 0 && (
        <div className="space-y-1.5 pt-1">
          {history.slice(0, 5).map(run => (
            <div key={run.id} className="p-2 rounded-lg" style={{ background: 'var(--gia-overlay)' }}>
              <div className="flex items-center gap-1.5">
                {run.status === 'error'
                  ? <AlertTriangle size={10} style={{ color: '#f87171' }} />
                  : <Sparkles size={10} style={{ color: '#818cf8' }} />}
                <span className="text-[10px]" style={{ color: 'var(--gia-text)' }}>
                  {new Date(run.startedAt).toLocaleString()}
                </span>
                <span className="text-[9px] px-1.5 py-0.5 rounded" style={{
                  background: run.status === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(129,140,248,0.1)',
                  color: run.status === 'error' ? '#f87171' : '#818cf8',
                }}>
                  {run.trigger}
                </span>
                {run.costUsd > 0 && (
                  <span className="text-[9px] ml-auto font-mono" style={{ color: '#34d399' }}>
                    ${run.costUsd.toFixed(4)}
                  </span>
                )}
              </div>
              {run.activities.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {run.activities.map((a, i) => (
                    <li key={i} className="text-[9px] flex items-center gap-1" style={{ color: 'var(--gia-muted-2)' }}>
                      <Clock size={8} />{a.title}{a.artifactId ? ` → ${a.artifactId}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {run.gaps.length > 0 && (
                <p className="text-[9px] mt-1" style={{ color: '#f59e0b' }}>
                  {run.gaps.length} capability gap{run.gaps.length === 1 ? '' : 's'} found — needs your input
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SelfImprovementSection;