import { logger } from '../utils/logger';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { idbStorage } from './idb-storage';
import type { AmendmentRecord } from '../services/selfbuild/myelin';

/**
 * The amendments ledger — MYELIN's memory, persisted like every other store
 * so she wakes up knowing what she has learned. The journal IS this store:
 * one append-only list of amendment records, every status transition included
 * (nothing is ever edited in place — a rollback is a NEW record state).
 *
 * CAPS (attack-A3's answer): at most 3 ACTIVE constitution rules can exist and
 * the store refuses a fourth — the amendment block in the prompt is bounded
 * by construction, not by hope that the governor spares it.
 */
export const MAX_ACTIVE_CONSTITUTION = 3;

interface AmendmentState {
  amendments: AmendmentRecord[];
  /** The earned reveal: true once the first amendment SURVIVED its trial. */
  unlocked: boolean;
  /** Sessions observed since the last proposal (cadence: propose every 5). */
  sessionsSinceProposal: number;

  append: (a: AmendmentRecord) => void;
  /** Transition the LATEST record with this id to a new status (journal is append-imitating). */
  transition: (id: string, patch: Partial<AmendmentRecord>) => void;
  /** Active constitution rules (status ON_TRIAL or ACTIVE), newest last. */
  activeConstitution: () => AmendmentRecord[];
  /** Live run-scoped rules (not yet expired). */
  activeRunRules: () => AmendmentRecord[];
  hasActiveOrTrial: (ruleId: string) => boolean;
  markUnlocked: () => void;
  noteSessionObserved: () => void;
  /** Proposal cadence: observed-session counter reset when a proposal fires. */
  transitionResetCadence: () => void;
  expireRunRules: () => number;
  reset: () => void;
}

export const useAmendmentStore = create<AmendmentState>()(
  persist(
    (set, get) => ({
      amendments: [],
      unlocked: false,
      sessionsSinceProposal: 0,

      append: (a) => {
        if (a.scope === 'constitution' && (a.status === 'ON_TRIAL' || a.status === 'ACTIVE')) {
          const active = get().activeConstitution().length;
          if (active >= MAX_ACTIVE_CONSTITUTION) {
            logger.warn('[amendments] active-rule cap reached; refusing to attach a new constitution rule');
            return;
          }
        }
        set((s) => ({ amendments: [...s.amendments, a] }));
      },

      transition: (id, patch) => {
        set((s) => {
          const idx = s.amendments.findIndex((x) => x.id === id);
          if (idx < 0) return s;
          const next = [...s.amendments];
          next[idx] = { ...next[idx], ...patch };
          return { amendments: next };
        });
      },

      activeConstitution: () => {
        const all = get().amendments.filter((a) => a.scope === 'constitution' && (a.status === 'ON_TRIAL' || a.status === 'ACTIVE'));
        // Keep only the LATEST record per ruleId, then cap at MAX_ACTIVE_CONSTITUTION.
        const latest = new Map<string, AmendmentRecord>();
        for (const a of all) latest.set(a.ruleId, a);
        return [...latest.values()].filter((a) => a.status === 'ON_TRIAL' || a.status === 'ACTIVE').slice(0, MAX_ACTIVE_CONSTITUTION);
      },

      activeRunRules: () => {
        const latest = new Map<string, AmendmentRecord>();
        for (const a of get().amendments) {
          if (a.scope !== 'run') continue;
          latest.set(a.ruleId, a);
        }
        return [...latest.values()].filter((a) => a.status === 'ACTIVE' && !a.expiredAt);
      },

      hasActiveOrTrial: (ruleId) => {
        const latest = new Map<string, AmendmentRecord>();
        for (const a of get().amendments) {
          if (a.ruleId !== ruleId) continue;
          latest.set(a.scope, a);
        }
        for (const a of latest.values()) {
          if (a.status === 'ON_TRIAL' || a.status === 'ACTIVE') return true;
        }
        return false;
      },

      markUnlocked: () => set({ unlocked: true }),

      noteSessionObserved: () => set((s) => ({ sessionsSinceProposal: s.sessionsSinceProposal + 1 })),

      transitionResetCadence: () => set({ sessionsSinceProposal: 0 }),

      expireRunRules: () => {
        const live = get().amendments.filter((a) => a.scope === 'run' && a.status === 'ACTIVE' && !a.expiredAt);
        if (live.length === 0) return 0;
        const now = Date.now();
        set((s) => ({
          amendments: s.amendments.map((a) =>
            a.scope === 'run' && a.status === 'ACTIVE' && !a.expiredAt
              ? { ...a, expiredAt: now, status: 'ROLLED_BACK' as const, rollbackReason: 'expired at next run start (run scope auto-expires)' }
              : a,
          ),
        }));
        return live.length;
      },

      reset: () => set({ amendments: [], unlocked: false, sessionsSinceProposal: 0 }),
    }),
    {
      name: 'gia-amendments-v1',
      storage: createJSONStorage(() => idbStorage),
    },
  ),
);
