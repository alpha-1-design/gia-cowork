import type { ModeId } from './compliance';
import { useGiaStore } from '../../store/useGiaStore';

/**
 * The runtime seam for the compliance auditor.
 *
 * The rules themselves are pure data with no store dependency, which is what
 * makes them testable in isolation. But the tool runner needs two pieces of
 * live state — which mode is active, and whether the user armed the auditor —
 * and importing `useGiaStore` directly into `toolRunner` would couple the whole
 * agent loop to the store for two reads.
 *
 * So they are read here instead, and the seam is deliberately overridable: a
 * test can set the mode without constructing a whole store, and the default
 * path reads the real one.
 */

let modeOverride: ModeId | null = null;
let enabledOverride: boolean | null = null;

/** Force a mode (tests). Pass null to fall back to the store. */
export function setModeForCompliance(mode: ModeId | null): void {
  modeOverride = mode;
}

/** Arm or disarm the auditor (tests). Null falls back to the store. */
export function setComplianceEnabledOverride(v: boolean | null): void {
  enabledOverride = v;
}

/** Reset both overrides — call between tests. */
export function resetComplianceOverrides(): void {
  modeOverride = null;
  enabledOverride = null;
}

/**
 * The active mode.
 *
 * Unknown values map to `code` rather than defaulting to a restrictive mode: a
 * garbled mode string should not silently turn every tool call into a violation.
 */
export function currentMode(): ModeId {
  if (modeOverride) return modeOverride;
  try {
    const raw = (useGiaStore.getState().sharedData as { currentMode?: string } | undefined)?.currentMode;
    if (raw === 'ask' || raw === 'plan' || raw === 'code' || raw === 'build' || raw === 'exam') return raw;
    return 'code';
  } catch {
    return 'code';
  }
}

/**
 * Whether the auditor runs.
 *
 * On by default, with the ability to turn it off. An auditor that has to be
 * switched on is one that will not be on when it matters, and the whole
 * purpose here is to catch things nobody noticed going wrong.
 */
export function isComplianceEnabled(): boolean {
  if (enabledOverride !== null) return enabledOverride;
  try {
    const v = (useGiaStore.getState() as unknown as { systemCompliance?: boolean }).systemCompliance;
    return v === undefined ? true : !!v;
  } catch {
    return true;
  }
}