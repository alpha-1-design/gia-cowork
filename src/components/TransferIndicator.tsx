import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Download, CheckCircle2, XCircle, X, Loader2 } from 'lucide-react';
import { useTransferStore, type TransferTask } from '../services/TransferProgress';

/**
 * Global transfer indicator.
 *
 * Renders every registered transfer, so a multi-gigabyte model download or a
 * sandbox environment install shows real progress instead of appearing
 * frozen. Finished tasks linger briefly so the outcome is visible.
 */
const TransferIndicator: React.FC = () => {
  const tasks = useTransferStore(s => s.tasks);
  const clear = useTransferStore(s => s.clear);
  const [, forceTick] = useState(0);

  // Re-render so lingering tasks actually disappear after their window.
  useEffect(() => {
    const iv = setInterval(() => forceTick(n => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const now = Date.now();
  const visible = tasks.filter(t => t.status === 'active' || (t.finishedAt !== undefined && now - t.finishedAt < 2500));

  if (visible.length === 0) return null;

  return (
    <div data-presenter-hide="" className="fixed bottom-4 right-4 z-[170] flex flex-col gap-2 w-72 pointer-events-none">
      <AnimatePresence initial={false}>
        {visible.map(task => (
          <TaskRow key={task.id} task={task} onDismiss={() => clear(task.id)} />
        ))}
      </AnimatePresence>
    </div>
  );
};

const TaskRow: React.FC<{ task: TransferTask; onDismiss: () => void }> = ({ task, onDismiss }) => {
  const done = task.status === 'done';
  const failed = task.status === 'error';
  const color = failed ? '#f87171' : done ? '#34d399' : '#a855f7';
  const pct = task.progress !== null ? Math.round(task.progress * 100) : null;

  return (
    <motion.div
      initial={{ opacity: 0, x: 24, scale: 0.97 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.97 }}
      transition={{ duration: 0.18 }}
      className="pointer-events-auto rounded-xl px-3 py-2.5 shadow-lg"
      style={{
        background: 'var(--gia-surface)',
        border: `1px solid ${color}33`,
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
      }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        {done ? <CheckCircle2 size={13} style={{ color }} />
          : failed ? <XCircle size={13} style={{ color }} />
          : task.status === 'active' && pct === null ? <Loader2 size={13} className="animate-spin" style={{ color }} />
          : <Download size={13} style={{ color }} />}
        <span className="text-[11px] font-medium truncate flex-1" style={{ color: 'var(--gia-text)' }}>
          {task.label}
        </span>
        {task.status === 'active' && pct !== null && (
          <span className="text-[10px] font-mono tabular-nums" style={{ color }}>{pct}%</span>
        )}
        {!task.status || task.status !== 'active' ? (
          <button onClick={onDismiss} className="p-0.5 rounded" style={{ color: 'var(--gia-muted-2)' }} aria-label="Dismiss">
            <X size={11} />
          </button>
        ) : null}
      </div>

      {task.status === 'active' && (
        <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)' }}>
          <div
            className="h-full rounded-full transition-all duration-200"
            style={{
              width: pct !== null ? `${Math.max(2, pct)}%` : '35%',
              background: `linear-gradient(90deg, ${color}, ${color}99)`,
              animation: pct === null ? 'gia-indeterminate 1.2s ease-in-out infinite' : undefined,
            }}
          />
        </div>
      )}

      {task.detail && task.status === 'active' && (
        <p className="text-[9px] mt-1" style={{ color: 'var(--gia-muted-2)' }}>{task.detail}</p>
      )}
      {failed && task.error && (
        <p className="text-[9px] mt-1" style={{ color }}>{task.error}</p>
      )}
      {done && (
        <p className="text-[9px] mt-1" style={{ color: '#34d399' }}>Done</p>
      )}
    </motion.div>
  );
};

export default TransferIndicator;