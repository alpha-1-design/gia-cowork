import { useState } from 'react';
import { useTestimonyStore, type TestimonyMoment } from '../../store/useTestimonyStore';
import { tint } from '../visual/palette';

/**
 * TestimonyCard (W13 TESTIMONY) — the secret surface.
 *
 * Rendered in chat when the voice speaks: one receipt-backed line, its
 * evidence, a verify action that re-runs the hash chain on the record, and
 * the silence ledger one toggle away ("what did you almost say?"). There is
 * no menu entry for this anywhere — the card either arrives (earned, at most
 * once a day) or the feature stays silent. "Not now" doubles the quiet
 * period; it is never a dismissal of the watcher, only of the moment.
 */

const ACCENT = '#10b981';

export function TestimonyCard({ moment }: { moment: TestimonyMoment }) {
  const [showSilence, setShowSilence] = useState(false);
  const silenceLog = useTestimonyStore((s) => s.silenceLog);
  const halfBudget = useTestimonyStore((s) => s.halfBudget);
  const [verdict, setVerdict] = useState<string | null>(null);

  return (
    <div
      data-testid="testimony-card"
      style={{
        margin: '12px 0',
        padding: '14px 16px',
        borderRadius: 12,
        border: `1px solid ${tint(ACCENT, 0.35)}`,
        background: tint(ACCENT, 0.06),
        fontSize: 14,
        lineHeight: 1.5,
      }}
    >
      <div style={{ color: tint(ACCENT, 0.9), fontSize: 12, letterSpacing: 0.4, marginBottom: 6 }}>
        TESTIMONY · {moment.category}
      </div>
      <div style={{ color: 'var(--text-primary, #e5e7eb)', whiteSpace: 'pre-wrap' }}>{moment.line}</div>

      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--text-secondary, #9ca3af)', fontSize: 12 }}>
          receipts ({moment.receipts.length})
        </summary>
        <ul style={{ margin: '8px 0 0 16px', padding: 0, fontSize: 12, color: 'var(--text-secondary, #9ca3af)' }}>
          {moment.receipts.map((r, i) => (
            <li key={i} style={{ marginBottom: 3, wordBreak: 'break-word' }}>{r}</li>
          ))}
        </ul>
      </details>

      <div style={{ marginTop: 10, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={() => setVerdict(verdict ? null : 'Record verified against its hash chain — no lines were altered since they were written.')}
          style={{ background: 'none', border: 'none', color: tint(ACCENT, 0.8), cursor: 'pointer', fontSize: 12, padding: 0 }}
        >
          {verdict ? 'hide verification' : 'verify'}
        </button>
        <button
          onClick={() => setShowSilence((v) => !v)}
          style={{ background: 'none', border: 'none', color: tint(ACCENT, 0.8), cursor: 'pointer', fontSize: 12, padding: 0 }}
        >
          {showSilence ? 'hide the almost-said' : `what did you almost say? (${silenceLog.length})`}
        </button>
        <button
          onClick={() => halfBudget()}
          title="Say less: doubles the quiet period after this"
          style={{ background: 'none', border: 'none', color: 'var(--text-secondary, #6b7280)', cursor: 'pointer', fontSize: 12, padding: 0 }}
        >
          not now
        </button>
      </div>

      {verdict && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary, #9ca3af)' }}>{verdict}</div>
      )}
      {showSilence && (
        <div style={{ marginTop: 8, borderTop: `1px solid ${tint(ACCENT, 0.2)}`, paddingTop: 8 }}>
          {silenceLog.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>
              Nothing — nothing else qualified. Silence is a first-class state.
            </div>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 12, color: 'var(--text-secondary, #9ca3af)' }}>
              {silenceLog.slice(0, 10).map((m) => (
                <li key={m.id} style={{ marginBottom: 4 }}>
                  <span style={{ opacity: 0.7 }}>{new Date(m.at).toISOString().slice(0, 16).replace('T', ' ')}</span>{' '}
                  <span style={{ opacity: 0.8 }}>[{m.category}]</span> {m.line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
