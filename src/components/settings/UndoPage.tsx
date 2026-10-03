import React, { useState, useEffect } from 'react';
import { ChevronRight, Undo2, FileText, RotateCcw, Trash2, ShieldCheck, Plus } from 'lucide-react';
import { fileSnapshots, type FileSnapshot } from '../../services/FileSnapshots';
import { isTauri } from '../../platform';

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const UndoPage: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [snapshots, setSnapshots] = useState<FileSnapshot[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const refresh = () => setSnapshots(fileSnapshots.list());

  useEffect(() => {
    refresh();
  }, []);

  const handleRevert = async (id: string) => {
    setBusyId(id);
    setMessage('');
    const res = await fileSnapshots.revert(id);
    setMessage(res.success ? 'File restored to its previous version.' : `Could not revert: ${res.error}`);
    setBusyId(null);
    refresh();
  };

  const handleRevertAll = async () => {
    setBusyId('all');
    setMessage('');
    const { reverted, failed } = await fileSnapshots.revertAll();
    setMessage(
      failed > 0
        ? `Restored ${reverted} file${reverted === 1 ? '' : 's'}; ${failed} could not be restored.`
        : `Restored ${reverted} file${reverted === 1 ? '' : 's'}.`,
    );
    setBusyId(null);
    refresh();
  };

  const pending = snapshots.filter(s => !s.reverted);
  const desktop = isTauri();

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: 'var(--gia-bg)', padding: '20px 16px', gap: '16px' }}>
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="p-1 rounded-lg hover:bg-white/5 transition-colors" style={{ color: 'var(--gia-muted)' }}>
          <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <Undo2 size={16} style={{ color: '#f59e0b' }} />
        <div>
          <span className="text-sm font-semibold" style={{ color: 'var(--gia-text)' }}>Undo File Changes</span>
          <p className="text-[10px]" style={{ color: 'var(--gia-muted-2)' }}>
            {pending.length > 0 ? `${pending.length} change${pending.length === 1 ? '' : 's'} you can restore` : 'Every file GIA overwrites is snapshotted first'}
          </p>
        </div>
      </div>

      {!desktop && (
        <div className="gia-card p-3" style={{ borderColor: 'rgba(59,130,246,0.25)' }}>
          <div className="flex items-start gap-2">
            <ShieldCheck size={14} style={{ color: '#3b82f6', flexShrink: 0, marginTop: 1 }} />
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
              Undo works in the GIA Cowork desktop app, where GIA writes to your real filesystem.
              In the browser preview there's no host disk to snapshot.
            </p>
          </div>
        </div>
      )}

      {message && (
        <div className="gia-card p-3" style={{ borderColor: 'rgba(52,211,153,0.3)' }}>
          <p className="text-[11px]" style={{ color: '#34d399' }}>{message}</p>
        </div>
      )}

      {pending.length > 0 && desktop && (
        <button
          onClick={handleRevertAll}
          disabled={busyId === 'all'}
          className="gia-btn w-full"
          style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.25)', opacity: busyId === 'all' ? 0.6 : 1 }}
        >
          <RotateCcw size={13} /> Restore all {pending.length} change{pending.length === 1 ? '' : 's'}
        </button>
      )}

      {snapshots.length === 0 ? (
        <div className="gia-card p-8 text-center">
          <div className="w-12 h-12 rounded-2xl mx-auto mb-3 flex items-center justify-center"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
            <FileText size={20} style={{ color: '#f59e0b' }} />
          </div>
          <p className="text-sm font-semibold" style={{ color: 'var(--gia-text)' }}>No file changes yet</p>
          <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--gia-muted-2)' }}>
            When GIA writes to a file, the previous version is saved here first so you can always put it back.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {snapshots.map(s => (
            <div key={s.id} className="gia-card p-3" style={{ opacity: s.reverted ? 0.55 : 1 }}>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{
                    background: s.reverted ? 'rgba(52,211,153,0.08)' : 'rgba(245,158,11,0.1)',
                    border: `1px solid ${s.reverted ? 'rgba(52,211,153,0.2)' : 'rgba(245,158,11,0.2)'}`,
                  }}>
                  {s.reverted
                    ? <Undo2 size={13} style={{ color: '#34d399' }} />
                    : s.previousContent === null
                      ? <Plus size={13} style={{ color: '#f59e0b' }} />
                      : <FileText size={13} style={{ color: '#f59e0b' }} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-medium truncate" style={{ color: 'var(--gia-text)' }} title={s.path}>
                    {s.path.split('/').pop() || s.path}
                  </p>
                  <p className="text-[9px] truncate" style={{ color: 'var(--gia-muted-2)' }} title={s.path}>{s.path}</p>
                  <p className="text-[9px] mt-0.5" style={{ color: 'var(--gia-muted)' }}>
                    {s.reverted ? 'Restored' : s.previousContent === null ? 'New file created' : 'Overwrote existing file'} · {relativeTime(s.timestamp)}
                  </p>
                </div>
                {!s.reverted && desktop && (
                  <button
                    onClick={() => handleRevert(s.id)}
                    disabled={busyId === s.id}
                    className="px-2 py-1 rounded-lg text-[9px] font-semibold shrink-0"
                    style={{
                      background: 'rgba(52,211,153,0.12)', color: '#34d399',
                      border: '1px solid rgba(52,211,153,0.25)',
                      opacity: busyId === s.id ? 0.6 : 1,
                    }}
                  >
                    {busyId === s.id ? '...' : 'Undo'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {snapshots.length > 0 && (
        <button
          onClick={() => { fileSnapshots.clear(); refresh(); setMessage(''); }}
          className="text-[10px] text-center py-2"
          style={{ color: 'var(--gia-muted-2)' }}
        >
          Clear history
        </button>
      )}

      <p className="text-[9px] text-center pb-4 leading-relaxed" style={{ color: 'var(--gia-muted-2)' }}>
        Keeps the last 50 changes. Snapshots live only on this machine.
      </p>
    </div>
  );
};

export default UndoPage;
