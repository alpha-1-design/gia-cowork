import React, { useState, useRef, useEffect } from 'react';
import { Plus, MessagesSquare, Check, X } from 'lucide-react';
import { useGiaStore } from '../store/useGiaStore';
import { WorktreeToggle } from './WorktreeToggle';

/**
 * Session switcher — every conversation, reachable from where you work.
 *
 * Claude's April 2026 redesign made a multi-session sidebar its headline
 * change, and the instinct generalises: an orchestrator needs many threads, not
 * one. GIA already stored sessions — and rendered them ONLY in the Dashboard.
 * So a conversation you actually cared about had no switcher at all; reaching a
 * second one meant leaving the surface you were working on. The capability
 * existed in the data model and was invisible in the interface.
 *
 * What this gives, precisely: conversations are switchable without leaving the
 * chat, each keeps its own history, and the one currently generating is marked.
 *
 * What it does NOT give, stated here rather than implied: parallel generation.
 * `generationState` is a single global, so GIA runs one generation at a time
 * across all sessions. Switching is cheap and safe; running two agents at once
 * is not yet a thing this app can do, and the dot reflects the single
 * in-flight generation rather than pretending otherwise.
 */
export function SessionSwitcher() {
  const sessions = useGiaStore(s => s.sessions);
  const activeSessionId = useGiaStore(s => s.activeSessionId);
  const setActiveSession = useGiaStore(s => s.setActiveSession);
  const createSession = useGiaStore(s => s.createSession);

  // Which conversation is generating, from the store's own generation state.
//
// Deliberately NOT `protocol.messageId` — that is a MESSAGE id, not a session
// id, so matching it against session ids silently never fires and the busy dot
// is decorative. `generationState.sessionId` is the session.
const activeGeneration = useGiaStore(s => s.generationState);
const busySessionId = activeGeneration.active ? activeGeneration.sessionId : null;

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = sessions.find(s => s.id === activeSessionId);

  // Newest first: the conversation you most likely want is the one you just had.
  const ordered = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  return (
    <div className="relative" ref={ref} data-testid="session-switcher">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all"
        style={{
          background: 'var(--gia-surface-2)',
          color: 'var(--gia-muted)',
          border: '1px solid var(--gia-border)',
        }}
        title="Switch conversation"
      >
        <MessagesSquare size={12} />
        <span className="max-w-[120px] truncate">{active?.title || 'New chat'}</span>
        {sessions.length > 1 && (
          <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(148,163,184,0.15)' }}>
            {sessions.length}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-1 w-64 max-h-80 overflow-y-auto rounded-xl z-50"
          style={{
            background: 'var(--gia-surface)',
            border: '1px solid var(--gia-border)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
          }}
        >
          <div className="flex items-center justify-between px-2.5 py-1.5" style={{ borderBottom: '1px solid var(--gia-border)' }}>
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted-2)' }}>
              Conversations
            </span>
            <button
              onClick={() => { createSession(); setOpen(false); }}
              className="flex items-center gap-1 text-[10px] px-1.5 py-1 rounded-md transition-all"
              style={{ background: 'rgba(168,85,247,0.12)', color: '#a855f7' }}
            >
              <Plus size={10} /> New
            </button>
          </div>

          <div className="p-1">
            {ordered.length === 0 && (
              <p className="text-[10px] px-2 py-3 text-center" style={{ color: 'var(--gia-muted-2)' }}>
                No conversations yet.
              </p>
            )}
            {ordered.map(s => {
              const isActive = s.id === activeSessionId;
              return (
                <div key={s.id}>
                  <button
                    onClick={() => { setActiveSession(s.id); setOpen(false); }}
                    data-testid={`session-item-${s.id}`}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-all"
                    style={{
                      background: isActive ? 'rgba(168,85,247,0.12)' : 'transparent',
                      color: isActive ? '#c084fc' : 'var(--gia-muted)',
                    }}
                  >
                    <span className="flex-1 truncate text-[11px]">{s.title || 'Untitled'}</span>
                    {busySessionId === s.id && (
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: '#22c55e' }}
                        title="GIA is working in this conversation"
                        data-testid="session-busy"
                      />
                    )}
                    {isActive && <Check size={11} className="shrink-0" />}
                  </button>
                  {/* Isolation control only on the row you are actually in, so
                      the list does not turn into a wall of toggles. */}
                  {isActive && <WorktreeToggle sessionId={s.id} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default SessionSwitcher;