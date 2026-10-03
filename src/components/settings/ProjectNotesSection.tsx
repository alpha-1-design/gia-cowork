import React, { useEffect, useState } from 'react';
import { BookOpen, Trash2, X, Lightbulb, GitCommitHorizontal, Network, Ruler, PauseCircle } from 'lucide-react';
import { useProjectMemoryStore, type ProjectMemoryKind, type ProjectMemoryEntry } from '../../services/ProjectMemory';
import { useProjectContextStore } from '../../store/useProjectContextStore';
import { useGiaStore } from '../../store/useGiaStore';

/**
 * Project notes — what GIA has written down about this project.
 *
 * She records these herself while working, and they are injected into her
 * system prompt on later turns. This is the human-readable side of that: you
 * can read what she learned, and delete anything that turned out to be wrong.
 *
 * Deletion matters more than it looks. A stale note is recalled as fact, so
 * the ability to remove one is what makes it safe to write them at all.
 */

const KIND_META: Record<ProjectMemoryKind, { label: string; icon: React.ReactNode; color: string }> = {
  gotcha: { label: 'Gotcha', icon: <Lightbulb size={12} />, color: '#fbbf24' },
  decision: { label: 'Decision', icon: <GitCommitHorizontal size={12} />, color: '#a855f7' },
  architecture: { label: 'Architecture', icon: <Network size={12} />, color: '#38bdf8' },
  convention: { label: 'Convention', icon: <Ruler size={12} />, color: '#34d399' },
  todo: { label: 'Parked', icon: <PauseCircle size={12} />, color: '#94a3b8' },
};

const ORDER: ProjectMemoryKind[] = ['gotcha', 'decision', 'architecture', 'convention', 'todo'];

function relative(ts: number): string {
  const d = Date.now() - ts;
  const days = Math.floor(d / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export const ProjectNotesSection: React.FC = () => {
  const entries = useProjectMemoryStore((s) => s.entries);
  const remove = useProjectMemoryStore((s) => s.remove);
  const clearProject = useProjectMemoryStore((s) => s.clearProject);
  const project = useProjectContextStore((s) => s.entry?.projectName) || 'current';
  const initialised = !!useProjectContextStore((s) => s.entry);
  const [filter, setFilter] = useState<ProjectMemoryKind | 'all'>('all');
  const [confirmClear, setConfirmClear] = useState(false);// Switching projects must not leave a "delete all?" prompt armed for the
// project you just left.
useEffect(() => { setConfirmClear(false); }, [project]);

  const list = entries
    .filter(e => e.project === project)
    .filter(e => filter === 'all' || e.kind === filter)
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.updatedAt - a.updatedAt);

  const counts = entries.filter(e => e.project === project).reduce<Record<string, number>>((acc, e) => {
    acc[e.kind] = (acc[e.kind] || 0) + 1;
    return acc;
  }, {});

  const del = (e: ProjectMemoryEntry) => {
    remove(e.id);
    useGiaStore.getState().addNotification(`Removed note: ${e.title}`);
  };

  return (
    <div className="gia-card p-4">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.25)' }}>
          <BookOpen size={18} style={{ color: '#a855f7' }} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: 'var(--gia-text)' }}>
            Project notes
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--gia-muted)' }}>
            What GIA has written down about <span style={{ color: '#a855f7' }}>{project}</span> while working.
            She reads these at the start of every session.
          </p>
        </div>
        {list.length > 0 && (
          confirmClear ? (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => { clearProject(project); setConfirmClear(false); }}
                className="text-[10px] font-semibold px-2.5 py-1.5 rounded-lg"
                style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171' }}
              >
                Delete all {list.length}?
              </button>
              <button onClick={() => setConfirmClear(false)} className="p-1.5 rounded-lg hover:bg-white/5"
                style={{ color: 'var(--gia-muted)' }}>
                <X size={13} />
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmClear(true)} title="Delete every note for this project"
              className="shrink-0 p-2 rounded-lg hover:bg-white/5" style={{ color: 'var(--gia-muted)' }}>
              <Trash2 size={14} />
            </button>
          )
        )}
      </div>

      {!initialised && (
        <p className="text-[11px] rounded-lg p-2.5 mb-3" style={{ background: 'rgba(251,191,36,0.08)', color: '#fbbf24' }}>
          Run <code>/init</code> in this project so notes are filed under the right codebase and GIA reads the project context.
        </p>
      )}

      {entries.filter(e => e.project === project).length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {(['all', ...ORDER] as const).map(k => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className="text-[10px] px-2 py-1 rounded-lg transition-colors"
              style={{
                background: filter === k ? 'rgba(168,85,247,0.16)' : 'var(--gia-overlay)',
                color: filter === k ? '#a855f7' : 'var(--gia-muted)',
              }}
            >
              {k === 'all' ? `All ${Object.values(counts).reduce((a, b) => a + b, 0)}` : `${KIND_META[k].label} ${counts[k] || 0}`}
            </button>
          ))}
        </div>
      )}

      {list.length === 0 ? (
        <p className="text-xs py-3" style={{ color: 'var(--gia-muted)' }}>
          {filter === 'all'
            ? 'Nothing recorded yet. GIA writes these herself as she works — a decision and its reason, a trap she hit, how a subsystem fits together.'
            : `No ${KIND_META[filter as ProjectMemoryKind].label.toLowerCase()} notes.`}
        </p>
      ) : (
        <div className="space-y-2">
          {list.map(e => {
            const meta = KIND_META[e.kind];
            return (
              <div key={e.id} className="group rounded-xl p-3" style={{ background: 'var(--gia-overlay)' }}>
                <div className="flex items-start gap-2">
                  <span className="shrink-0 mt-0.5 flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded"
                    style={{ background: `${meta.color}1f`, color: meta.color }}>
                    {meta.icon}{meta.label}
                  </span>
                  <p className="text-[12px] font-medium flex-1" style={{ color: 'var(--gia-text)' }}>{e.title}</p>
                  <button onClick={() => del(e)} title="Delete this note"
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-white/5"
                    style={{ color: 'var(--gia-muted)' }}>
                    <Trash2 size={12} />
                  </button>
                </div>
                <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: 'var(--gia-muted)' }}>{e.body}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  {e.paths.map(p => (
                    <code key={p} className="text-[9px] px-1 py-0.5 rounded" style={{ background: 'var(--gia-overlay-2)' }}>{p}</code>
                  ))}
                  <span className="text-[9px] ml-auto" style={{ color: 'var(--gia-muted)' }}>{relative(e.updatedAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};