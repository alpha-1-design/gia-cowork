import React from 'react';
import { ListOrdered, CornerDownLeft, X } from 'lucide-react';
import { useGiaStore } from '../store/useGiaStore';

/**
 * Queued messages — visible, steerable, cancellable.
 *
 * The queue itself is the easy half. The half that actually matters is this:
 * a message the user typed and sent must not disappear into a buffer they
 * cannot see. If you cannot tell whether your follow-up is still coming, you
 * send it again, and then it runs twice.
 *
 * So each item shows its text, says how many are waiting, and can be removed.
 *
 * "Steer now" is the second half. Queueing alone means every correction waits
 * for the turn to end — which is exactly when a correction is worthless,
 * because the action you wanted to prevent has already happened. Steering
 * promotes a queued item into the running turn instead: it lands before the
 * next tool call, while there is still something to change course about.
 */
export function QueuedMessages() {
  const queued = useGiaStore(s => s.queuedMessages);
  const activeSessionId = useGiaStore(s => s.activeSessionId);
  const dequeueMessage = useGiaStore(s => s.dequeueMessage);
  const addSteering = useGiaStore(s => s.addSteering);

  const mine = queued.filter(m => !activeSessionId || !m.sessionId || m.sessionId === activeSessionId);
  if (mine.length === 0) return null;

  /** Promote a queued message into the turn currently running. */
  const steer = (id: string, text: string) => {
    if (!activeSessionId) return;
    addSteering(activeSessionId, text);
    dequeueMessage(id);
  };

  return (
    <div
      data-testid="queued-messages"
      className="flex flex-col gap-1 px-2 py-1.5 rounded-lg"
      style={{
        background: 'var(--gia-surface-2)',
        border: '1px solid var(--gia-border)',
      }}
    >
      <div className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--gia-muted)' }}>
        <ListOrdered size={10} />
        {mine.length} message{mine.length === 1 ? '' : 's'} queued — sent after this turn
      </div>
      {mine.map(m => (
        <div key={m.id} className="flex items-start gap-2 group">
          <span className="text-[11px] flex-1 truncate" style={{ color: 'var(--gia-text)' }}>
            {m.text}
          </span>
          <button
            onClick={() => steer(m.id, m.text)}
            aria-label={`Steer the running turn now: ${m.text.slice(0, 40)}`}
            title="Apply to the turn that is running now, instead of waiting"
            data-testid={`queued-steer-${m.id}`}
            className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: '#14b8a6' }}
          >
            <CornerDownLeft size={10} />
          </button>
          <button
            onClick={() => dequeueMessage(m.id)}
            aria-label={`Cancel queued message: ${m.text.slice(0, 40)}`}
            data-testid={`queued-cancel-${m.id}`}
            className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: 'var(--gia-muted-2)' }}
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}

export default QueuedMessages;