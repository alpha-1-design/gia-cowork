import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  classifyToolRequest,
  riskAtLeast,
  type PermissionRequest,
  type RiskLevel,
  type ClassifyOptions,
} from '../services/permissions';

/**
 * The trust layer — scoped consent for an agent that writes to the real disk.
 *
 * Before this, approval was a binary on a category: "allow all writes" or
 * "allow all execution", and the card in front of you showed a truncated
 * argument string. Both halves of that are wrong for a desktop agent. Coarse
 * categories are too broad to grant and too blunt to refuse, and an unreadable
 * card is not consent.
 *
 * So consent here is scoped to what was actually asked for — a directory, a
 * command prefix, a single tool — and it expires. A session grant is memory
 * only and dies with the app, because "I trusted that one command ten minutes
 * ago" should not silently mean "and the next forty".
 *
 * `armed` is the kill switch. Disarming blocks every tool call without even
 * showing a prompt, which is the only thing that matters when something is
 * running away: you need one keypress that stops the machine, not a dialog
 * with four buttons and a diff you have to read.
 */

export type PermissionChoice = 'once' | 'session' | 'always' | 'deny';

export type PermissionVerdict = 'allow' | 'ask' | 'block';

export interface Grant {
  scope: string;
  /** Human phrasing, e.g. "writes under ~/projects/api". */
  label: string;
  toolId: string;
  risk: RiskLevel;
  grantedAt: number;
  /** How many calls this grant has since allowed. */
  uses: number;
  /** true for a session grant that disappears on reload. */
  session?: boolean;
}

/** What the caller learns about a gated call. */
export interface PermissionOutcome {
  /** Did the tool get permission to run? */
  allowed: boolean;
  request: PermissionRequest;
  choice: PermissionChoice;
  /**
   * Set when the call was refused. This is the sentence handed back to the
   * model, so it must say what happened rather than just failing silently —
   * a silent refusal teaches the model nothing and invites a retry.
   */
  refusalReason?: string;
}

export interface AuditEntry {
  id: string;
  toolId: string;
  toolName: string;
  risk: RiskLevel;
  /** 'auto' means a standing grant or a below-threshold action. */
  choice: PermissionChoice | 'auto' | 'blocked';
  scope: string;
  headline: string;
  at: number;
}

interface Pending {
  request: PermissionRequest;
  resolve: (choice: PermissionChoice) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_AUDIT = 50;
/** How long the prompt waits before defaulting to the safe answer. */
export const PERMISSION_TIMEOUT_MS = 120_000;

interface TrustStore {
  /** Standing grants, persisted across restarts. */
  grants: Grant[];
  /** Grants that die with the app. Deliberately not persisted. */
  sessionGrants: Grant[];
  audit: AuditEntry[];
  /** false = kill switch engaged: every tool call is blocked. */
  armed: boolean;
  /** Ungranted calls at or above this risk always prompt. */
  askThreshold: RiskLevel;
  /**
   * Prompts waiting for the user, first-in first-out. A swarm runs several
   * lanes at once, so several cards can be owed at the same time — the older
   * one must wait its turn, not get answered for the user.
   */
  pendingQueue: Pending[];
  /** The head of the queue — the one card TrustGate renders right now. */
  pending: Pending | null;

  /** Non-blocking check. Decides whether a request needs the user at all. */
  verdict: (request: PermissionRequest) => PermissionVerdict;
  /** Block until the user answers. Resolves 'deny' on timeout. */
  request: (request: PermissionRequest) => Promise<PermissionChoice>;
  resolve: (choice: PermissionChoice) => void;
  /** Classify and gate in one call. Returns the full outcome the runner needs. */
  checkTool: (
    toolId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: ClassifyOptions,
  ) => Promise<PermissionOutcome>;

  grant: (request: PermissionRequest, choice: PermissionChoice) => void;
  revoke: (scope: string) => void;
  revokeAll: () => void;
  setArmed: (armed: boolean) => void;
  toggleArmed: () => boolean;
  setAskThreshold: (level: RiskLevel) => void;
  clearAudit: () => void;
}

function findGrant(grants: Grant[], scope: string): Grant | undefined {
  return grants.find(g => g.scope === scope);
}

export const useTrustStore = create<TrustStore>()(
  persist(
    (set, get) => ({
      grants: [],
      sessionGrants: [],
      audit: [],
      armed: true,
      // Defaults to asking about anything that changes something. Pure reads
      // rate 'none' and never prompt, so this does not mean a dialog on every
      // web search — it means a write always asks until you grant the scope.
      askThreshold: 'low',
      pendingQueue: [],
      pending: null,

      verdict: (request) => {
        const state = get();
        // The kill switch outranks everything, including a standing grant. A
        // grant given an hour ago must not survive a panic.
        if (!state.armed) return 'block';
        if (findGrant(state.sessionGrants, request.scope)) return 'allow';
        if (findGrant(state.grants, request.scope)) return 'allow';
        if (request.risk === 'none') return 'allow';
        return riskAtLeast(request.risk, state.askThreshold) ? 'ask' : 'allow';
      },

      request: (request) => new Promise<PermissionChoice>((resolve) => {
        const entry: Pending = { request, resolve };
        // Timeouts are per entry, counted from enqueue: a card queued behind
        // two others still expires on its own clock, so a lane cannot be held
        // hostage by the prompts in front of it.
        entry.timer = setTimeout(() => {
          set((s) => dropPending(s.pendingQueue, entry));
          resolve('deny');
        }, PERMISSION_TIMEOUT_MS);
        // Queue, don't displace. Whatever is already on the card stays there
        // until it is answered; this caller waits its turn.
        set((s) => pushPending(s.pendingQueue, entry));
      }),

      resolve: (choice) => {
        const queue = get().pendingQueue;
        const head = queue[0];
        if (!head) return;
        if (head.timer) clearTimeout(head.timer);
        set((s) => shiftPending(s.pendingQueue));
        get().grant(head.request, choice);
        head.resolve(choice);
      },

      checkTool: async (toolId, toolName, args, options) => {
        const request = classifyToolRequest(toolId, toolName, args, options);
        const verdict = get().verdict(request);
        if (verdict === 'allow') {
          set((s) => ({
            audit: appendAudit(s.audit, {
              id: request.id, toolId, toolName, risk: request.risk,
              choice: 'auto', scope: request.scope, headline: request.headline, at: Date.now(),
            }),
            sessionGrants: bumpUse(s.sessionGrants, request.scope),
            grants: bumpUse(s.grants, request.scope),
          }));
          return { allowed: true, choice: 'once' as PermissionChoice, request };
        }
        if (verdict === 'block') {
          set((s) => ({
            audit: appendAudit(s.audit, {
              id: request.id, toolId, toolName, risk: request.risk,
              choice: 'blocked', scope: request.scope, headline: request.headline, at: Date.now(),
            }),
          }));
          return {
            allowed: false,
            choice: 'deny' as PermissionChoice,
            request,
            refusalReason: 'The kill switch is engaged, so GIA is not allowed to run tools.',
          };
        }
        const choice = await get().request(request);
        if (choice === 'deny') {
          return {
            allowed: false,
            choice,
            request,
            refusalReason: request.reasons.length > 0
              ? `The user declined this action. What flagged it: ${request.reasons[0]}`
              : 'The user declined this action.',
          };
        }
        return { allowed: true, choice, request };
      },

      grant: (request, choice) => {
        if (choice === 'deny') {
          set((s) => ({
            audit: appendAudit(s.audit, {
              id: request.id, toolId: request.toolId, toolName: request.toolName,
              risk: request.risk, choice: 'deny', scope: request.scope,
              headline: request.headline, at: Date.now(),
            }),
          }));
          return;
        }
        const entry: Grant = {
          scope: request.scope,
          label: request.scopeLabel,
          toolId: request.toolId,
          risk: request.risk,
          grantedAt: Date.now(),
          uses: 1,
          session: choice === 'session',
        };
        set((s) => ({
          // A narrower grant must not be shadowed by an older broader one, and
          // re-granting a scope should refresh its label rather than duplicate.
          sessionGrants: choice === 'session'
            ? upsert(s.sessionGrants, entry)
            : s.sessionGrants,
          grants: choice === 'always' ? upsert(s.grants, entry) : s.grants,
          audit: appendAudit(s.audit, {
            id: request.id, toolId: request.toolId, toolName: request.toolName,
            risk: request.risk, choice, scope: request.scope,
            headline: request.headline, at: Date.now(),
          }),
        }));
      },

      revoke: (scope) => set((s) => ({
        grants: s.grants.filter(g => g.scope !== scope),
        sessionGrants: s.sessionGrants.filter(g => g.scope !== scope),
      })),

      revokeAll: () => set({ grants: [], sessionGrants: [] }),

      setArmed: (armed) => set({ armed }),

      toggleArmed: () => {
        const next = !get().armed;
        // Disarming should also clear everything the user was about to answer:
        // an open prompt is a decision waiting to be made on stale terms — and
        // that goes for every queued one, not just the card on top.
        if (!next) {
          for (const entry of get().pendingQueue) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.resolve('deny');
          }
          set({ pendingQueue: [], pending: null });
        }
        set({ armed: next });
        return next;
      },

      setAskThreshold: (askThreshold) => set({ askThreshold }),
      clearAudit: () => set({ audit: [] }),
    }),
    {
      name: 'gia-trust-v1',
      storage: createJSONStorage(() => localStorage),
      // `pending` holds a promise resolver and a timer — neither survives a
      // reload, and persisting them would restore a prompt nobody can answer.
      partialize: (s) => ({
        grants: s.grants,
        armed: s.armed,
        askThreshold: s.askThreshold,
        audit: s.audit,
      }),
    },
  ),
);

function upsert(grants: Grant[], entry: Grant): Grant[] {
  const idx = grants.findIndex(g => g.scope === entry.scope);
  if (idx === -1) return [...grants, entry];
  const next = [...grants];
  next[idx] = { ...next[idx], ...entry, uses: next[idx].uses };
  return next;
}

function bumpUse(grants: Grant[], scope: string): Grant[] {
  let touched = false;
  const next = grants.map(g => {
    if (g.scope !== scope) return g;
    touched = true;
    return { ...g, uses: g.uses + 1 };
  });
  return touched ? next : grants;
}

function appendAudit(audit: AuditEntry[], entry: AuditEntry): AuditEntry[] {
  const next = [entry, ...audit];
  return next.length > MAX_AUDIT ? next.slice(0, MAX_AUDIT) : next;
}

// ── the prompt queue ───────────────────────────────────────────────────

/** The queue and its head are one shape — every update keeps both in step. */
type QueueSlice = Pick<TrustStore, 'pendingQueue' | 'pending'>;

function pushPending(queue: Pending[], entry: Pending): QueueSlice {
  const next = [...queue, entry];
  return { pendingQueue: next, pending: next[0] ?? null };
}

function dropPending(queue: Pending[], entry: Pending): QueueSlice {
  const next = queue.filter(p => p !== entry);
  return { pendingQueue: next, pending: next[0] ?? null };
}

function shiftPending(queue: Pending[]): QueueSlice {
  const next = queue.slice(1);
  return { pendingQueue: next, pending: next[0] ?? null };
}

/** Non-reactive read, for callers outside React. */
export function trustSnapshot() {
  return useTrustStore.getState();
}
