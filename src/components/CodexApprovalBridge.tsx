import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Ban, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  classifyToolRequest,
  RISK_META,
  type PermissionRequest,
} from '../services/permissions';
import { DiffViewer } from './DiffViewer';

/**
 * The Codex side of the consent prompt.
 *
 * The codex app-server (`src-tauri/src/codex_client.rs`) surfaces its
 * server->client approval requests as `codex://approval-request` Tauri events
 * and waits for `codex_approval_respond` to answer them. This component is the
 * bridge between that event pair and the approval card GIA already trained its
 * users to read: same risk badge, same one-sentence headline, same reasons
 * list, same scope naming on the buttons.
 *
 * It deliberately does NOT import the trust store. Codex approvals have their
 * own lifecycle (a JSON-RPC request id that must be echoed back exactly once),
 * and mixing them into the store's grant model would let a store-side kill
 * switch answer a pending JSON-RPC frame the bridge never saw. The Rust gate
 * is the enforcement half; this card is only the review surface.
 *
 * Two deliberate bridge-layer simplifications, both documented until the Rust
 * `GateState` grows session grants:
 *
 *  - "Allow session" is honored in component state (a Set of scope strings,
 *    keyed by the same scope `classifyToolRequest` derives from the request
 *    params). It dies when this component unmounts — narrower than the
 *    trust store's session grants, never wider.
 *  - A second approval arriving while one is open denies the older one,
 *    mirroring `useTrustStore.request`'s documented resolution. Codex sends
 *    approvals one at a time in practice; a queue would hide that one is
 *    waiting behind another.
 */

/** Same budget as the trust store's prompt (useTrustStore.PERMISSION_TIMEOUT_MS).
 * A local copy, because importing it would pull the whole store in. */
const PERMISSION_TIMEOUT_MS = 120_000;

/** Server -> client approval methods the Rust pump forwards (codex_client.rs). */
const METHOD_COMMAND = 'item/commandExecution/requestApproval';
const METHOD_FILE_CHANGE = 'item/fileChange/requestApproval';
const METHOD_USER_INPUT = 'item/tool/requestUserInput';

interface CodexApprovalPayload {
  /** Full JSON-RPC frame from codex_client.rs; `id` is the request id. */
  id?: unknown;
  /** Tolerated in case the payload is ever flattened upstream. */
  requestId?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

interface PendingApproval {
  requestId: string;
  method: string;
  request: PermissionRequest;
}

export function CodexApprovalBridge() {
  const [pending, setPending] = useState<PendingApproval | null>(null);
  /** Render state mirrors this ref so the event handlers stay stable. */
  const pendingRef = useRef<PendingApproval | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bridge-layer session grants: scope -> auto-allow while mounted. */
  const sessionScopesRef = useRef<Set<string>>(new Set());

  const showPending = useCallback((next: PendingApproval | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const respond = useCallback(async (decision: boolean) => {
    const current = pendingRef.current;
    if (!current) return;
    clearTimer();
    // Clear the card before the invoke: codex_client.rs emits
    // `codex://approval-resolved` as soon as the decision lands, and the
    // resolved-listener must not treat our own answer as an external one.
    showPending(null);
    try {
      await invoke('codex_approval_respond', { requestId: current.requestId, decision });
    } catch (err) {
      // Rust fails closed on unknown ids, so this is a race (engine stopped,
      // duplicate answer) rather than a lost decision — log, don't retry.
      console.error('[codex-bridge] codex_approval_respond failed:', err);
    }
  }, [clearTimer, showPending]);

  const choose = useCallback((choice: 'once' | 'session' | 'deny') => {
    const current = pendingRef.current;
    if (!current) return;
    if (choice === 'session') {
      sessionScopesRef.current.add(current.request.scope);
    }
    void respond(choice !== 'deny');
  }, [respond]);

  const handleApproval = useCallback((payload: CodexApprovalPayload) => {
    const requestId = normalizeRequestId(payload);
    if (!requestId) {
      console.warn('[codex-bridge] approval event without a request id, declining:', payload);
      return;
    }
    const request = classifyApproval(payload.method, payload.params ?? {});
    if (!request) return;

    // A scope granted this session answers itself — the whole point of the
    // button. No card, no timer, just the yes the user already gave.
    if (sessionScopesRef.current.has(request.scope)) {
      void invoke('codex_approval_respond', { requestId, decision: true })
        .catch(err => console.error('[codex-bridge] auto-allow failed:', err));
      return;
    }

    // One open card at a time. The older request is denied rather than queued
    // for the same reason the trust store does it: an approval answered
    // minutes after it was asked for is an answer to a different question.
    const previous = pendingRef.current;
    if (previous && previous.requestId !== requestId) {
      void invoke('codex_approval_respond', { requestId: previous.requestId, decision: false })
        .catch(err => console.error('[codex-bridge] denying displaced approval failed:', err));
    }

    clearTimer();
    showPending({ requestId, method: payload.method ?? 'unknown', request });
    // The safe answer on a timeout: deny, same as the trust store's prompt.
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void respond(false);
    }, PERMISSION_TIMEOUT_MS);
  }, [clearTimer, respond, showPending]);

  const handleResolved = useCallback((payload: { requestId?: unknown }) => {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
    if (!requestId || pendingRef.current?.requestId !== requestId) return;
    // Rust answered this one without the card (codex_stop dropped the pending
    // oneshot, or the engine died and it declined for us). Drop the card —
    // sending a decision for a request that is no longer pending is an error.
    clearTimer();
    showPending(null);
  }, [clearTimer, showPending]);

  // Keep the latest handlers in refs so the subscriptions below never need
  // to resubscribe when a callback identity changes.
  const approvalRef = useRef(handleApproval);
  const resolvedRef = useRef(handleResolved);
  useEffect(() => {
    approvalRef.current = handleApproval;
    resolvedRef.current = handleResolved;
  });

  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    void (async () => {
      const offRequest = await listen<CodexApprovalPayload>(
        'codex://approval-request',
        event => approvalRef.current(event.payload),
      );
      const offResolved = await listen<{ requestId?: unknown }>(
        'codex://approval-resolved',
        event => resolvedRef.current(event.payload),
      );
      if (disposed) {
        offRequest();
        offResolved();
        return;
      }
      unlistens.push(offRequest, offResolved);
    })();
    return () => {
      disposed = true;
      unlistens.forEach(off => off());
    };
  }, []);

  // Escape answers deny, matching the trust gate's keyboard story.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        choose('deny');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, choose]);

  // A pending timer must not fire after unmount and answer a dead request.
  useEffect(() => () => clearTimer(), [clearTimer]);

  if (!pending) return null;

  const meta = RISK_META[pending.request.risk];
  const critical = pending.request.risk === 'critical';
  const preview = pending.request.preview;
  // Patch text reads better than a fabricated all-added-lines diff, so the
  // classifier swaps it in for the diff preview when there is no known
  // "before" content; the label follows the method that produced it.
  const previewLabel = pending.method === METHOD_FILE_CHANGE
    ? 'Patch'
    : pending.method === METHOD_USER_INPUT
      ? 'Question'
      : 'Command';

  return (
    <div className="fixed inset-0 z-[241] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Codex needs permission"
        data-testid="codex-approval-card"
        className="w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-2xl border flex flex-col"
        style={{
          borderColor: `${meta.color}55`,
          background: 'var(--gia-surface)',
          boxShadow: '0 24px 70px rgba(0,0,0,0.55)',
        }}
      >
        <div
          className="px-5 py-4 flex items-center gap-3 border-b"
          style={{ background: `${meta.color}10`, borderColor: `${meta.color}33` }}
        >
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: `${meta.color}22`, color: meta.color }}
          >
            {pending.request.risk === 'none'
              ? <ShieldCheck size={17} />
              : pending.request.risk === 'critical'
                ? <ShieldAlert size={17} />
                : <AlertTriangle size={17} />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold" style={{ color: 'var(--gia-text)' }}>
              Codex wants to {pending.request.toolName}
            </p>
            <p className="text-[11px]" style={{ color: 'var(--gia-muted)' }}>{meta.blurb}</p>
          </div>
          <span
            data-testid="codex-approval-risk"
            className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg shrink-0"
            style={{ background: `${meta.color}22`, color: meta.color }}
          >
            {meta.label}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-4 pt-4 space-y-4">
          <p className="text-sm leading-relaxed" style={{ color: 'var(--gia-text)' }}>
            {pending.request.headline}
          </p>

          {pending.request.reasons.length > 0 && (
            <ul className="space-y-1.5">
              {pending.request.reasons.map((reason, i) => (
                <li key={i} className="flex gap-2 text-[12px] leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
                  <span
                    className="mt-[6px] w-1 h-1 rounded-full shrink-0"
                    style={{ background: meta.color }}
                  />
                  {reason}
                </li>
              ))}
            </ul>
          )}

          {preview?.command && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>
                {previewLabel}
              </p>
              <pre
                data-testid="codex-approval-preview"
                className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap p-3 rounded-lg max-h-48 overflow-auto"
                style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
              >
                {preview.command}
              </pre>
            </div>
          )}

          {/* A write with no known "before" is shown as incoming content, not
              as a diff — pretending the whole file is an added line would
              invent a bigger change than the one being approved. */}
          {preview?.kind === 'diff' && preview.before == null && preview.after != null && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>
                New content
              </p>
              <pre
                data-testid="codex-approval-preview"
                className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap p-3 rounded-lg max-h-48 overflow-auto"
                style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
              >
                {preview.after}
              </pre>
            </div>
          )}

          {preview?.kind === 'diff' && preview.before != null && (
            <DiffViewer
              oldText={preview.before}
              newText={preview.after ?? ''}
              oldFilename="on disk now"
              newFilename="after this write"
              height="220px"
              sideBySide={false}
            />
          )}
        </div>

        <CardActions
          key={pending.requestId}
          request={pending.request}
          onChoose={choose}
        />
      </div>
    </div>
  );
}

function CardActions({
  request,
  onChoose,
}: {
  request: PermissionRequest;
  onChoose: (choice: 'once' | 'session' | 'deny') => void;
}) {
  const meta = RISK_META[request.risk];
  const critical = request.risk === 'critical';
  const denyRef = useRef<HTMLButtonElement>(null);
  const [armed, setArmed] = useState(false);

  // The safe answer starts focused, exactly like the trust gate: a reflexive
  // Enter on a dialog about to run a command must not be able to approve it.
  useEffect(() => {
    denyRef.current?.focus();
  }, []);

  // Same two-step commit as the trust gate for severe actions, and the same
  // refusal to offer a standing grant: "always delete everything" is not a
  // permission anyone should hand out by reflex, at either layer.
  const commit = (choice: 'once' | 'session' | 'deny') => {
    if (critical && choice === 'once' && !armed) {
      setArmed(true);
      return;
    }
    onChoose(choice);
  };

  return (
    <div
      className="px-5 py-3 border-t flex items-center gap-2 flex-wrap"
      style={{ borderColor: 'var(--gia-border)', background: 'var(--gia-surface-2)' }}
    >
      <button
        ref={denyRef}
        onClick={() => commit('deny')}
        data-testid="codex-approval-deny"
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
        <button
          onClick={() => commit('session')}
          data-testid="codex-approval-session"
          title={`Allow ${request.scopeLabel} until you close GIA`}
          className="text-[11px] px-3 py-2 rounded-lg transition-all"
          style={{ background: 'var(--gia-surface)', color: 'var(--gia-muted)', border: '1px solid var(--gia-border)' }}
        >
          Allow this session
        </button>
      )}

      <button
        onClick={() => commit('once')}
        data-testid="codex-approval-once"
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

// ── payload → request classification ─────────────────────────────────────

/**
 * Echo back the id codex_client.rs keyed the pending approval with: string
 * ids verbatim, anything else through the same stringification the Rust
 * `request_id_key` uses, so both sides agree on the key.
 */
function normalizeRequestId(payload: CodexApprovalPayload): string | null {
  if (typeof payload.requestId === 'string' && payload.requestId) return payload.requestId;
  if (typeof payload.requestId === 'number') return String(payload.requestId);
  if (typeof payload.id === 'string' && payload.id) return payload.id;
  if (typeof payload.id === 'number') return String(payload.id);
  return null;
}

/**
 * Classify a codex approval with GIA's own argument-level rules.
 *
 * The command text and file path go through `classifyToolRequest`, so the
 * risk rating, reasons, scope key and preview come from exactly the logic
 * the trust gate's card is built on — a codex `rm -rf ~` rates Severe for
 * the same reason a GIA one does.
 */
function classifyApproval(
  method: string | undefined,
  params: Record<string, unknown>,
): PermissionRequest | null {
  if (method === METHOD_COMMAND) {
    const command = commandFromParams(params);
    if (command !== null) {
      return classifyToolRequest('terminal_run', 'run a command', { command });
    }
  }

  if (method === METHOD_FILE_CHANGE) {
    const path = firstString(params, ['path', 'filePath', 'file']);
    if (path) {
      const before = firstString(params, ['before', 'original', 'oldContent', 'oldText']);
      const after = firstString(params, ['content', 'newContent', 'after', 'newText']);
      const patch = firstString(params, ['patch', 'diff']);
      // Classify the write itself for risk + scope; the "before" content,
      // when the server sent it, enables a real two-sided diff preview.
      const request = classifyToolRequest(
        'filesystem_write',
        'write a file',
        { path, content: after ?? patch },
        before !== undefined ? { beforeContent: before } : {},
      );
      // A verbatim patch beats a diff fabricated against an unknown "before"
      // (which would show the whole file as added lines). Only used when the
      // server did not also send the original contents.
      if (patch !== undefined && before === undefined) {
        request.preview = { kind: 'command', command: patch };
      }
      return request;
    }
  }

  if (method === METHOD_USER_INPUT) {
    const request = classifyToolRequest(method, 'ask you something', params);
    const question = firstQuestionText(params);
    if (question !== undefined) {
      request.preview = { kind: 'command', command: question };
    }
    return request;
  }

  // Unknown shape: still classify, so an unrecognized approval gets a risk
  // rating and a scope key instead of a raw JSON dump on a card.
  if (!method) return null;
  return classifyToolRequest(method, 'use a tool', params);
}

/** The command text from params, accepting both a string and a codex argv. */
function commandFromParams(params: Record<string, unknown>): string | null {
  const raw = params.command ?? params.cmd ?? params.commandText ?? params.commandLine;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.every(part => typeof part === 'string')) {
    // codex sends argv (["bash", "-lc", "ls"]) — join it back into the line
    // a person would read, which is what the command rules are written for.
    return (raw as string[]).join(' ');
  }
  return null;
}

function firstString(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** Best-effort readable text from a `requestUserInput` questions payload. */
function firstQuestionText(params: Record<string, unknown>): string | undefined {
  const questions = params.questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const first = questions[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const record = first as Record<string, unknown>;
  return firstString(record, ['question', 'text', 'prompt']);
}
