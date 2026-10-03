import React, { useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { EyeOff, Eye, Monitor, Cpu, Cloud, AlertCircle, X, Trash2, Loader2 } from 'lucide-react';
import { useJarvisStore, type JarvisFeedKind } from '../store/useJarvisStore';
import { featureFlags } from '../services/GIACoreServices';
import { useGiaStore } from '../store/useGiaStore';

/**
 * Jarvis Panel — what GIA actually saw.
 *
 * The orb captures the screen on a cadence and distills it into an
 * observation, then pushes it into a feed. Until now nothing rendered that
 * feed: the feature had a toggle, an orb, and no way to see the output. For an
 * agent that watches your screen, "what did it see, and where did that run"
 * is not a nicety — it is the whole trust question, so it gets a first-class
 * surface instead of a debug log nobody opens.
 *
 * The vision-mode line is the important one: local means the analysis never
 * left the machine, cloud means a fallback provider answered. Both are
 * legitimate; what is not acceptable is the user not knowing which happened.
 */

const KIND_STYLE: Record<JarvisFeedKind, { icon: React.ReactNode; color: string }> = {
  observation: { icon: <Monitor size={12} />, color: '#38bdf8' },
  acting: { icon: <Cpu size={12} />, color: '#ec4899' },
  verify: { icon: <Eye size={12} />, color: '#a78bfa' },
  info: { icon: <Eye size={12} />, color: '#94a3b8' },
  error: { icon: <AlertCircle size={12} />, color: '#f87171' },
};

function relative(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

interface JarvisPanelProps {
  open: boolean;
  onClose: () => void;
}

export const JarvisPanel: React.FC<JarvisPanelProps> = ({ open, onClose }) => {
  const { enabled, paused, state, visionReady, visionMode, visionSource, observation, lastSeenAt, feed, error } = useJarvisStore();

  const readyList = useMemo(
    () => Object.entries(visionReady).filter(([, v]) => v).map(([k]) => k),
    [visionReady],
  );

  const toggle = () => {
    const nowOn = featureFlags.toggle('jarvisEyes');
    useGiaStore.getState().addNotification(
      nowOn ? '👁️ Jarvis eyes on.' : '🛑 Jarvis eyes off — she stopped watching the screen.',
    );
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[180] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="fixed z-[181] bottom-6 right-6 w-[400px] max-w-[calc(100vw-3rem)] max-h-[70vh] flex flex-col overflow-hidden rounded-2xl backdrop-blur-2xl"
            style={{
              background: 'rgba(12,12,18,0.96)',
              border: '1px solid rgba(168,85,247,0.22)',
              boxShadow: '0 24px 70px rgba(0,0,0,0.6)',
            }}
          >
            {/* Header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--gia-overlay-2)' }}>
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: enabled ? 'rgba(168,85,247,0.18)' : 'var(--gia-overlay-2)' }}
              >
                {state === 'seeing' ? <Loader2 size={15} className="animate-spin" style={{ color: '#a855f7' }} />
                  : enabled ? <Eye size={15} style={{ color: '#a855f7' }} />
                  : <EyeOff size={15} style={{ color: '#71717a' }} />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold" style={{ color: 'var(--gia-text)' }}>What GIA is seeing</p>
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--gia-muted)' }}>
                  {!enabled ? 'Eyes off'
                    : paused ? 'Paused — screen locked'
                    : state === 'seeing' ? 'Capturing right now'
                    : `Watching on-device${lastSeenAt ? ` · last look ${relative(lastSeenAt)}` : ''}`}
                </p>
              </div>
              <button
                onClick={toggle}
                className="shrink-0 text-[10px] font-semibold px-2.5 py-1.5 rounded-lg transition-colors"
                style={{
                  background: enabled ? 'rgba(239,68,68,0.14)' : 'rgba(168,85,247,0.15)',
                  color: enabled ? '#f87171' : '#a855f7',
                }}
              >
                {enabled ? 'Turn off' : 'Turn on'}
              </button>
              <button onClick={onClose} className="shrink-0 p-1 rounded-lg hover:bg-white/5" style={{ color: 'var(--gia-muted)' }}>
                <X size={14} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {/* Where the analysis ran — the line that matters for trust. */}
              <div className="rounded-xl p-3" style={{ background: 'var(--gia-overlay)' }}>
                <p className="text-[10px] uppercase tracking-wider font-semibold mb-2" style={{ color: 'var(--gia-muted)' }}>
                  Vision
                </p>
                <div className="flex items-center gap-2 text-[11px]">
                  {visionMode === 'local' ? <Cpu size={13} style={{ color: '#34d399' }} />
                    : visionMode === 'cloud' ? <Cloud size={13} style={{ color: '#fbbf24' }} />
                    : <EyeOff size={13} style={{ color: '#71717a' }} />}
                  <span style={{ color: visionMode === 'local' ? '#34d399' : visionMode === 'cloud' ? '#fbbf24' : 'var(--gia-muted)' }}>
                    {visionMode === 'local' ? 'On-device — screenshots never left this machine'
                      : visionMode === 'cloud' ? `Sent to ${visionSource ?? 'the cloud provider'} for analysis`
                      : 'No vision models loaded'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {readyList.length === 0
                    ? <span className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>No local models loaded</span>
                    : readyList.map(k => (
                      <span key={k} className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(52,211,153,0.12)', color: '#34d399' }}>
                        {k}
                      </span>
                    ))}
                </div>
              </div>

              {/* Latest observation */}
              <div className="rounded-xl p-3" style={{ background: 'var(--gia-overlay)' }}>
                <p className="text-[10px] uppercase tracking-wider font-semibold mb-1.5" style={{ color: 'var(--gia-muted)' }}>
                  Latest observation
                </p>
                <p className="text-[12px] leading-relaxed" style={{ color: observation ? 'var(--gia-text)' : 'var(--gia-muted)' }}>
                  {observation || 'Nothing observed yet.'}
                </p>
              </div>

              {error && (
                <div className="rounded-xl p-3" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                  <p className="text-[11px]" style={{ color: '#f87171' }}>{error}</p>
                </div>
              )}

              {/* Feed */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gia-muted)' }}>
                    Activity
                  </p>
                  {feed.length > 0 && (
                    <button
                      onClick={() => useJarvisStore.getState().clearFeed()}
                      className="text-[10px] flex items-center gap-1 hover:opacity-80"
                      style={{ color: 'var(--gia-muted)' }}
                    >
                      <Trash2 size={10} /> Clear
                    </button>
                  )}
                </div>
                {feed.length === 0 ? (
                  <p className="text-[11px]" style={{ color: 'var(--gia-muted)' }}>Nothing yet.</p>
                ) : (
                  <div className="space-y-1.5">
                    {feed.map(item => {
                      const s = KIND_STYLE[item.kind];
                      return (
                        <div key={item.id} className="flex items-start gap-2 text-[11px]">
                          <span className="shrink-0 mt-0.5" style={{ color: s.color }}>{s.icon}</span>
                          <span className="flex-1 leading-snug" style={{ color: 'var(--gia-text)' }}>{item.text}</span>
                          <span className="shrink-0 text-[9px]" style={{ color: 'var(--gia-muted)' }}>{relative(item.at)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="px-4 py-2.5 border-t text-[10px] flex items-center justify-between" style={{ borderColor: 'var(--gia-overlay-2)', color: 'var(--gia-muted)' }}>
              <span>Ctrl/⌘ + Shift + J turns the eyes off</span>
              <span>Capture pauses when the screen locks</span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};