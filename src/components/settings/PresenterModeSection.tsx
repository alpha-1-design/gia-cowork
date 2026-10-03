import { useCallback, useEffect, useState } from 'react';
import { EyeOff, Keyboard } from 'lucide-react';
import {
  isPresenting,
  presenterSupported,
  subscribe,
  togglePresenterMode,
  type PresenterState,
} from '../../services/PresenterMode';

/**
 * Presenter Mode — GIA disappears for screen shares and calls.
 *
 * The failure this fixes: the user shares their screen on a call and GIA's
 * window is right there in the share, orb and all, so they look like they are
 * being supervised by a chatbot. Presenter mode hides the whole thing.
 *
 * The tray is the only way back once the window is hidden (there is no in-app
 * control left to click), so the copy here says so explicitly — a user who
 * cannot get out of the mode again will not use it.
 */
export function PresenterModeSection() {
  const [state, setState] = useState<PresenterState>(() => (isPresenting() ? 'active' : 'off'));
  const [busy, setBusy] = useState(false);
  const supported = presenterSupported();

  useEffect(() => subscribe(s => setState(s)), []);

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      await togglePresenterMode();
    } finally {
      setBusy(false);
    }
  }, []);

  if (!supported) {
    // Presenter mode hides an OS window. In a browser tab there is no window
    // to hide, so offering the toggle would be a button that does nothing.
    return null;
  }

  const active = state === 'active';

  return (
    <div
      className="gia-card p-4 flex items-center gap-4"
      style={{ borderColor: active ? 'rgba(168,85,247,0.4)' : undefined, transition: 'border-color 0.2s' }}
    >
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.25)' }}
      >
        <EyeOff size={18} style={{ color: '#a855f7' }} />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" style={{ color: 'var(--gia-text)' }}>
          Presenter Mode
        </p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--gia-muted)' }}>
          {active
            ? 'GIA is hidden for your screen share. Restore her from the tray icon.'
            : 'Hide GIA entirely during a screen share or call.'}
        </p>
        <p className="text-[11px] mt-1 flex items-center gap-1.5" style={{ color: 'var(--gia-muted)' }}>
          <Keyboard size={11} />
          <span>Ctrl/Cmd + Shift + P</span>
        </p>
      </div>

      <button
        onClick={toggle}
        disabled={busy}
        className="shrink-0 text-xs font-semibold px-3.5 py-2 rounded-xl transition-all disabled:opacity-50"
        style={{
          background: active ? 'rgba(239,68,68,0.15)' : 'rgba(168,85,247,0.15)',
          color: active ? '#f87171' : '#a855f7',
          border: `1px solid ${active ? 'rgba(239,68,68,0.3)' : 'rgba(168,85,247,0.3)'}`,
        }}
      >
        {active ? 'Restore' : busy ? 'Hiding…' : 'Hide GIA'}
      </button>
    </div>
  );
}
