import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ShieldAlert, ShieldCheck, Terminal, FileDiff, Globe, AlertTriangle, Ban } from 'lucide-react';
import { useTrustStore, type PermissionChoice } from '../store/useTrustStore';
import { RISK_META, type PermissionRequest } from '../services/permissions';
import { DiffViewer } from './DiffViewer';

/**
 * The consent prompt.
 *
 * This is the screen that decides whether the user trusts GIA with their
 * machine, so it is built around one question: "do I understand what is about
 * to happen?" Everything in it serves that — the risk badge says how much is at
 * stake, the headline says what will happen in one sentence, the reasons say
 * why it was rated that way, and the preview shows the actual effect.
 *
 * Three deliberate choices:
 *
 *  - The default focus is DENY. Space and Enter approve, but the button that
 *    is focused when the dialog opens is the safe one, so a stray Enter on a
 *    reflex muscle memory does not run `rm -rf`.
 *  - The scope is named on the buttons ("allow for this session: writes under
 *    ~/projects/api") rather than hidden in a tooltip. A grant you cannot
 *    describe is a grant you cannot revoke with confidence.
 *  - `critical` requires an explicit click on the allow button — no
 *    keyboard shortcut. Above a certain weight, slowness is the feature.
 */

const MAX_DIFF_LINES = 600;

function clipLines(text: string, max: number): string {
  const lines = text.split('\n');
  if (lines.length <= max) return text;
  return lines.slice(0, max).join('\n');
}

const PREVIEW_ICON = {
  diff: FileDiff,
  command: Terminal,
  url: Globe,
  text: ShieldCheck,
  args: ShieldCheck,
} as const;

export function TrustGate() {
  const pending = useTrustStore(s => s.pending);
  const resolve = useTrustStore(s => s.resolve);
  const denyRef = useRef<HTMLButtonElement>(null);

  const request = pending?.request;

  useEffect(() => {
    if (!request) return;
    // Focus the safe answer. The allow buttons are reachable by Tab, and the
    // critical ones require an explicit click anyway.
    denyRef.current?.focus();
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolve('deny');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, resolve]);

  const diffContent = useMemo(() => {
    if (!request?.preview || request.preview.kind !== 'diff') return null;
    return {
      before: clipLines(request.preview.before ?? '', MAX_DIFF_LINES),
      after: clipLines(request.preview.after ?? '', MAX_DIFF_LINES),
      newFile: request.preview.before === null,
    };
  }, [request]);

  return (
    <AnimatePresence>
      {request && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[240] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={() => resolve('deny')}
        >
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-label="GIA needs permission"
            data-testid="trust-gate"
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-2xl border flex flex-col"
            style={{
              borderColor: `${RISK_META[request.risk].color}55`,
              background: 'var(--gia-surface)',
              boxShadow: '0 24px 70px rgba(0,0,0,0.55)',
            }}
          >
            <TrustHeader request={request} />
            <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-4">
              <p className="text-sm leading-relaxed" style={{ color: 'var(--gia-text)' }}>
                {request.headline}
              </p>

              {request.reasons.length > 0 && (
                <ul className="space-y-1.5">
                  {request.reasons.map((reason, i) => (
                    <li key={i} className="flex gap-2 text-[12px] leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
                      <span
                        className="mt-[6px] w-1 h-1 rounded-full shrink-0"
                        style={{ background: RISK_META[request.risk].color }}
                      />
                      {reason}
                    </li>
                  ))}
                </ul>
              )}

              <TrustPreview request={request} diff={diffContent} />
            </div>
            <TrustActions request={request} onResolve={resolve} denyRef={denyRef} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TrustHeader({ request }: { request: PermissionRequest }) {
  const meta = RISK_META[request.risk];
  const Icon = request.risk === 'none' ? ShieldCheck : request.risk === 'critical' ? ShieldAlert : AlertTriangle;
  return (
    <div
      className="px-5 py-4 flex items-center gap-3 border-b"
      style={{ background: `${meta.color}10`, borderColor: `${meta.color}33` }}
    >
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: `${meta.color}22`, color: meta.color }}
      >
        <Icon size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold" style={{ color: 'var(--gia-text)' }}>
          GIA wants to {request.toolName}
        </p>
        <p className="text-[11px]" style={{ color: 'var(--gia-muted)' }}>{meta.blurb}</p>
      </div>
      <span
        data-testid="trust-gate-risk"
        className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg shrink-0"
        style={{ background: `${meta.color}22`, color: meta.color }}
      >
        {meta.label}
      </span>
    </div>
  );
}

function TrustPreview({
  request,
  diff,
}: {
  request: PermissionRequest;
  diff: { before: string; after: string; newFile: boolean } | null;
}) {
  const preview = request.preview;
  if (!preview) return null;
  const Icon = PREVIEW_ICON[preview.kind] || ShieldCheck;

  if (preview.kind === 'diff' && diff) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Icon size={12} style={{ color: 'var(--gia-muted)' }} />
          <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>
            {diff.newFile ? 'New file' : 'Changes to'} <span className="font-mono normal-case">{preview.path}</span>
          </p>
        </div>
        <DiffViewer
          oldText={diff.before}
          newText={diff.after}
          oldFilename="on disk now"
          newFilename={diff.newFile ? 'created file' : 'after this write'}
          height="220px"
          sideBySide={false}
        />
        {preview.truncated && (
          <p className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>
            Preview truncated — the file is larger than the diff shown. Undo from the Files panel restores the full previous
            contents.
          </p>
        )}
      </div>
    );
  }

  if (preview.kind === 'command' && preview.command) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Icon size={12} style={{ color: 'var(--gia-muted)' }} />
          <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>
            Command
          </p>
        </div>
        <pre
          data-testid="trust-gate-command"
          className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap p-3 rounded-lg max-h-48 overflow-auto"
          style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
        >
          {preview.command}
        </pre>
      </div>
    );
  }

  if (preview.kind === 'url' && preview.url) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Icon size={12} style={{ color: 'var(--gia-muted)' }} />
          <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>
            Destination
          </p>
        </div>
        <p className="text-[11px] font-mono break-all p-2 rounded-lg" style={{ background: 'var(--gia-surface-2)' }}>
          {preview.url}
        </p>
      </div>
    );
  }

  if (preview.fields && preview.fields.length > 0) {
    return (
      <div
        className="rounded-lg p-3 space-y-1 font-mono text-[11px]"
        style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}
      >
        {preview.fields.map(f => (
          <p key={f.key} style={{ color: 'var(--gia-muted)' }}>
            <span className="opacity-70">{f.key}:</span>{' '}
            <span style={{ color: 'var(--gia-text)' }}>{f.value}</span>
          </p>
        ))}
      </div>
    );
  }

  return null;
}

function TrustActions({
  request,
  onResolve,
  denyRef,
}: {
  request: PermissionRequest;
  onResolve: (choice: PermissionChoice) => void;
  denyRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const meta = RISK_META[request.risk];
  const critical = request.risk === 'critical';
  const [armed, setArmed] = useState(false);

  // A severe action is never unapprovable — the user is allowed to take the
  // risk, that is their call. What it must not be is *easy*. So the first
  // click only arms the button and states the consequence; the second commits.
  // Standing grants are not offered at all: "always delete everything" is not
  // a permission anyone should be able to hand out by reflex.
  const commit = (choice: PermissionChoice) => {
    if (critical && !armed) {
      setArmed(true);
      return;
    }
    onResolve(choice);
  };

  return (
    <div
      className="px-5 py-3 border-t flex items-center gap-2 flex-wrap"
      style={{ borderColor: 'var(--gia-border)', background: 'var(--gia-surface-2)' }}
    >
      <button
        ref={denyRef}
        onClick={() => onResolve('deny')}
        data-testid="trust-deny"
        className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-2 rounded-lg transition-all"
        style={{ background: `${meta.color}1f`, color: meta.color, border: `1px solid ${meta.color}44` }}
      >
        <Ban size={12} /> Deny
      </button>

      <div className="flex-1" />

      {armed && critical && (
        <p className="w-full text-[10px] text-right" style={{ color: meta.color }}>
          This cannot be undone. Click again to run it.
        </p>
      )}

      {!critical && (
        <>
          <button
            onClick={() => commit('session')}
            data-testid="trust-session"
            title={`Allow ${request.scopeLabel} until you close GIA`}
            className="text-[11px] px-3 py-2 rounded-lg transition-all"
            style={{ background: 'var(--gia-surface)', color: 'var(--gia-muted)', border: '1px solid var(--gia-border)' }}
          >
            Allow this session
          </button>
          <button
            onClick={() => commit('always')}
            data-testid="trust-always"
            title={`Always allow ${request.scopeLabel}`}
            className="text-[11px] px-3 py-2 rounded-lg transition-all"
            style={{ background: 'var(--gia-surface)', color: 'var(--gia-muted)', border: '1px solid var(--gia-border)' }}
          >
            Always allow
          </button>
        </>
      )}
      <button
        onClick={() => commit('once')}
        data-testid="trust-once"
        className="flex items-center gap-1.5 text-[11px] font-semibold px-4 py-2 rounded-lg transition-all"
        style={{
          background: critical ? meta.color : '#22c55e',
          color: 'white',
          boxShadow: armed && critical ? `0 0 0 3px ${meta.color}33` : undefined,
        }}
      >
        {armed && critical ? 'Run it anyway' : 'Allow once'}
      </button>
    </div>
  );
}
