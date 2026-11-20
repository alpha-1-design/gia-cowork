import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * The testimony ledger (W13 TESTIMONY) — the quiet half of the feature.
 *
 * The voice speaks at most one receipt-backed sentence per day; everything
 * else it almost said lands here instead. The ledger is the difference
 * between attention and surveillance: it makes the watching auditable —
 * "here is everything I almost said" — and the budget falsifiable, because
 * every spoken AND suppressed moment has an entry you can read.
 *
 * No menu, no settings tab. `unlockStage` moves from 'dormant' to 'revealed'
 * the first time a moment is actually spoken; the reveal can honestly fail
 * to arrive (nothing qualifies → silence, forever), and that is by design.
 */

export type TestimonyCategory = 'gate' | 'failure' | 'cost' | 'revert';

/** One moment — spoken or suppressed, identical shape, both auditable. */
export interface TestimonyMoment {
  id: string;
  category: TestimonyCategory;
  /** The sentence she would say. */
  line: string;
  /** Evidence lines backing it — every claim must be clickable to a record. */
  receipts: string[];
  at: number;
}

interface TestimonyState {
  spokenLog: TestimonyMoment[];
  silenceLog: TestimonyMoment[];
  /** Set when the user answers a moment with "not now" — doubles the quiet period. */
  budgetHalved: boolean;
  /** 'dormant' until the first spoken moment; then the reveal is spent. */
  unlockStage: 'dormant' | 'revealed';
  recordSpoken: (moment: Omit<TestimonyMoment, 'at'>, now: number) => void;
  recordSilent: (moment: Omit<TestimonyMoment, 'at'>, now: number) => void;
  halfBudget: () => void;
  clearLedgers: () => void;
}

const MAX_LEDGER = 50;

/** Quiet period after a spoken moment. Halved budget → doubled silence. */
export const QUIET_MS = 24 * 60 * 60 * 1000;

export const useTestimonyStore = create<TestimonyState>()(
  persist(
    (set) => ({
      spokenLog: [],
      silenceLog: [],
      budgetHalved: false,
      unlockStage: 'dormant',

      recordSpoken: (moment, now) =>
        set((s) => ({
          spokenLog: [{ ...moment, at: now }, ...s.spokenLog].slice(0, MAX_LEDGER),
          unlockStage: 'revealed',
          // A spoken moment resets the halving: the "not now" was about that
          // moment, not a standing gag.
          budgetHalved: false,
        })),

      recordSilent: (moment, now) =>
        set((s) => ({
          silenceLog: [{ ...moment, at: now }, ...s.silenceLog].slice(0, MAX_LEDGER),
        })),

      halfBudget: () => set({ budgetHalved: true }),

      clearLedgers: () => set({ spokenLog: [], silenceLog: [], budgetHalved: false, unlockStage: 'dormant' }),
    }),
    {
      name: 'gia-testimony-ledger',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        spokenLog: s.spokenLog,
        silenceLog: s.silenceLog,
        budgetHalved: s.budgetHalved,
        unlockStage: s.unlockStage,
      }),
    },
  ),
);

/** When the voice may next speak, given the last spoken moment and budget state. */
export function nextAllowedAt(spokenLog: TestimonyMoment[], budgetHalved: boolean): number {
  const last = spokenLog[0];
  if (!last) return 0; // never spoken: the voice is allowed immediately
  return last.at + (budgetHalved ? QUIET_MS * 2 : QUIET_MS);
}
