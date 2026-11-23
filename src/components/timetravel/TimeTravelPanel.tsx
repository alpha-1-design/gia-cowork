import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, FileText, History, Minus, Plus, Rewind, X } from 'lucide-react';
import { fileSnapshots, type FileSnapshot } from '../../services/FileSnapshots';
import { buildTimeline, stateAt, diffCounts, alignToMessages, revertToStep, type AlignableMessage } from '../../services/timetravel';
import { useGiaStore } from '../../store/useGiaStore';
import { isTauri } from '../../platform';

/**
 * TimeTravelPanel — the scrubber over everything GIA wrote.
 *
 * A slider across her writes, oldest to newest. At every position it shows
 * the workspace state as of that step: which files existed, what was in
 * them, what changed at that step, and (aligned by timestamp) what she was
 * being asked while she did it. The action is honest: "back to here" reverts
 * every pending write AFTER the chosen step through the normal
 * FileSnapshots rail — nothing is invented, nothing bypasses the undo ring.
 *
 * Derived state only: the timeline is rebuilt from FileSnapshots and the
 * active session's messages on each open; there is no second source of truth.
 */

const TimeTravelPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const activeSessionId = useGiaStore(s => s.activeSessionId);
  const sessions = useGiaStore(s => s.sessions);
  const [snapshots, setSnapshots] = useState<FileSnapshot[]>([]);
  const [position, setPosition] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);

  const refresh = useCallback(() => setSnapshots(fileSnapshots.list()), []);
  useEffect(() => { refresh(); }, [refresh]);

  const timeline = useMemo(() => buildTimeline(snapshots), [snapshots]);
  const step = timeline[Math.min(position, Math.max(timeline.length - 1, 0))];
  const state = useMemo(() => stateAt(timeline, position), [timeline, position]);

  const messages: AlignableMessage[] = useMemo(() => {
    const session = sessions.find(s => s.id === activeSessionId);
    if (!session) return [];
    return (session.messages as unknown as AlignableMessage[]) ?? [];
  }, [sessions, activeSessionId]);

  const alignment = useMemo(
    () => alignToMessages(timeline, messages),
    [timeline, messages],
  );
  const currentAlignment = alignment[position] ?? null;

  const changes = step ? diffCounts(step.snapshot.previousContent, step.snapshot.newContent) : { additions: 0, deletions: 0 };
  const stepFileName = step ? (step.snapshot.path.split('/').pop() || step.snapshot.path) : '';
  const laterPending = timeline.filter(s => s.index > position && !s.snapshot.reverted).length;

  const handleBack = async () => {
    if (!step) return;
    setBusy(true);
    setMessage('');
    const res = await revertToStep(timeline, position);
    setBusy(false);
    setMessage(
      res.failed === 0
        ? `Restored ${res.reverted} file${res.reverted === 1 ? '' : 's'} to this moment.`
        : `Restored ${res.reverted}, failed ${res.failed}.`,
    );
    refresh();
  };

  const handleRevertOne = async () => {
    if (!step) return;
    setBusy(true);
    setMessage('');
    const res = await fileSnapshots.revert(step.snapshot.id);
    setBusy(false);
    setMessage(res.success ? `Undid the write to ${stepFileName}.` : `Could not revert: ${res.error}`);
    refresh();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }} data-testid="time-travel-panel">
      <div className="w-full max-w-lg rounded-xl flex flex-col overflow-hidden" style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border-2)', maxHeight: '82vh' }}>
        {/* Header */}
        <div className="flex items-center gap-2 px-4 h-12 shrink-0" style={{ borderBottom: '1px solid var(--gia-border)' }}>
          <History size={14} style={{ color: '#f59e0b' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--gia-text)' }}>Time travel</span>
          <span className="text-[10px]" style={{ color: 'var(--gia-muted-2)' }}>{timeline.length} write{timeline.length === 1 ? '' : 's'}</span>
          <button onClick={onClose} aria-label="Close time travel" className="ml-auto p-1 rounded" style={{ color: 'var(--gia-muted)' }}>
            <X size={14} />
          </button>
        </div>

        {!isTauri() ? (
          <div className="px-4 py-6 text-xs" style={{ color: 'var(--gia-muted)' }}>
            Time travel works in the GIA desktop app, where file writes are snapshotted against the real filesystem.
          </div>
        ) : timeline.length === 0 ? (
          <div className="px-4 py-6 text-xs" style={{ color: 'var(--gia-muted)' }}>
            No writes yet in this workspace. When GIA writes files, every version lands here.
          </div>
        ) : (
          <>
            {/* Scrubber */}
            <div className="px-4 pt-3 pb-2 shrink-0">
              <input
                type="range"
                min={0}
                max={timeline.length - 1}
                value={Math.min(position, timeline.length - 1)}
                onChange={(e) => { setPosition(Number(e.target.value)); setMessage(''); }}
                aria-label="Scrub through GIA's file writes"
                data-testid="tt-slider"
                className="w-full"
                style={{ accentColor: '#f59e0b' }}
              />
              <div className="flex justify-between text-[10px] mt-1" style={{ color: 'var(--gia-muted-2)' }}>
                <span>first write</span>
                <span>{position + 1} / {timeline.length}</span>
                <span>now</span>
              </div>
            </div>

            {/* Step detail */}
            <div className="px-4 pb-2 flex-1 overflow-y-auto min-h-0">
              {step && (
                <>
                  <div className="flex items-center gap-2 mb-1">
                    <FileText size={12} style={{ color: 'var(--gia-muted)' }} />
                    <span className="text-xs font-mono truncate" style={{ color: 'var(--gia-text)' }}>{step.snapshot.path}</span>
                    {step.snapshot.reverted && (
                      <span className="text-[10px] px-1.5 rounded-full" style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-muted-2)' }}>already reverted</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] mb-2" style={{ color: 'var(--gia-muted)' }}>
                    <span className="inline-flex items-center gap-0.5" style={{ color: '#14b8a6' }}><Plus size={9} />{changes.additions}</span>
                    <span className="inline-flex items-center gap-0.5" style={{ color: '#ef4444' }}><Minus size={9} />{changes.deletions}</span>
                    <span>·</span>
                    <span>{new Date(step.snapshot.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    <span>·</span>
                    <span>{state.filter(p => p.exists).length} file{state.filter(p => p.exists).length === 1 ? '' : 's'} existed at this point</span>
                  </div>

                  {currentAlignment?.prompt && (
                    <div className="px-2.5 py-2 rounded-lg mb-2" style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}>
                      <p className="text-[10px] mb-0.5" style={{ color: 'var(--gia-muted-2)' }}>She was working on:</p>
                      <p className="text-[11px] line-clamp-2" style={{ color: 'var(--gia-text)' }}>{currentAlignment.prompt}</p>
                    </div>
                  )}

                  {/* Workspace state at this step */}
                  <div className="rounded-lg overflow-hidden mb-2" style={{ border: '1px solid var(--gia-border)' }}>
                    <p className="text-[10px] px-2.5 py-1.5" style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-muted)' }}>Workspace at this step</p>
                    <div className="max-h-28 overflow-y-auto">
                      {state.map(p => (
                        <div key={p.path} className="flex items-center gap-2 px-2.5 py-1 text-[11px]" style={{ borderTop: '1px solid var(--gia-border)' }}>
                          {p.exists
                            ? <FileText size={9} style={{ color: 'var(--gia-muted-2)' }} />
                            : <span className="w-[9px] text-center" style={{ color: 'var(--gia-muted-2)' }}>·</span>}
                          <span className="flex-1 truncate font-mono" style={{ color: p.exists ? 'var(--gia-text)' : 'var(--gia-muted-2)' }}>{p.path}</span>
                          {!p.exists && <span className="text-[9px]" style={{ color: 'var(--gia-muted-2)' }}>written later</span>}
                        </div>
                      ))}
                    </div>
                  </div>

                  {previewOpen && step && (
                    <pre className="px-2.5 py-2 rounded-lg text-[10px] overflow-auto max-h-40 font-mono" style={{ background: 'var(--gia-bg)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}>
                      {step.snapshot.newContent.slice(0, 4000)}
                    </pre>
                  )}
                  <button onClick={() => setPreviewOpen(o => !o)} className="text-[10px] mt-1" style={{ color: 'var(--gia-accent)' }}>
                    {previewOpen ? 'Hide content' : 'Show content at this step'}
                  </button>
                </>
              )}
              {message && <p className="text-[11px] mt-2" data-testid="tt-message" style={{ color: '#14b8a6' }}>{message}</p>}
            </div>

            {/* Actions */}
            <div className="px-4 py-3 flex items-center gap-2 shrink-0" style={{ borderTop: '1px solid var(--gia-border)' }}>
              <button
                onClick={handleBack}
                disabled={busy || laterPending === 0}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-50"
                style={{ background: 'var(--gia-accent)', color: 'var(--gia-accent-contrast)' }}
                data-testid="tt-back-here"
              >
                <Rewind size={12} />
                {busy ? 'Restoring…' : `Back to here${laterPending > 0 ? ` (${laterPending} write${laterPending === 1 ? '' : 's'})` : ''}`}
              </button>
              <button
                onClick={handleRevertOne}
                disabled={busy || !!step?.snapshot.reverted}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs disabled:opacity-50"
                style={{ border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
              >
                <UndoWrite /> Undo this write
              </button>
              <button onClick={onClose} className="ml-auto text-xs" style={{ color: 'var(--gia-muted)' }}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const UndoWrite: React.FC = () => (
  <span style={{ display: 'inline-flex' }}><ChevronLeft size={12} style={{ transform: 'rotate(180deg) translateY(3px)' }} /></span>
);

export default TimeTravelPanel;
