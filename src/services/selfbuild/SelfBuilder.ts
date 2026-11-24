import GiaBrain from '../GiaBrain';
import GiaTools from '../GiaTools';
import { fileSnapshots } from '../FileSnapshots';
import { reviewAction } from '../brain/guardian';
import { gateToolCall } from '../brain/permissionGate';
import { classifyToolRequest } from '../permissions';
import { useTrustStore } from '../../store/useTrustStore';
import { logger } from '../../utils/logger';

/**
 * SelfBuilder — GIA changes GIA.
 *
 * Sometimes the thing the user asks for is a change to GIA itself: a new
 * capability, a tweak to a module, a fix in GIA's own code. That is the most
 * powerful thing a desktop agent can do and also the most dangerous, so this
 * service wraps it in a bounded, fully-gated loop and gives GIA *zero* new
 * privileges for it:
 *
 *   1. PLAN   — GiaBrain turns the request into a small step list, each step
 *               naming exact target files and a validation command.
 *   2. EDIT   — the writes happen through the normal filesystem tools, so
 *               every one is snapshotted by FileSnapshots and passes through
 *               the ordinary compliance → Guardian → permission-gate path.
 *   3. VALIDATE — `validateStep` runs `tsc` / targeted `vitest` through the
 *               REGISTERED `terminal_run` tool object — not a side channel —
 *               after calling the same Guardian review and permission gate
 *               the runner uses. A self-edit that cannot prove it compiles
 *               and passes its tests does not ship.
 *   4. ROLLBACK — if validation fails, `rollback(planId)` restores every
 *               file the plan touched from FileSnapshots. Failing
 *               validation means rollback, never shipping.
 *
 * The one absolute rule is the path deny-list: self-edits may never touch
 * src-tauri/**, the Rust gate, the terminal bridge, TrustGate, the codex
 * approval bridge, permissions, the credential vault, the untrusted-content
 * labeling, Guardian, the tool runner/schemas, the permission gate bridge,
 * the trust store, the compliance rules or the input guardrails. Those files
 * are the enforcement layer itself — a self-edit that could weaken the gate
 * would make every other guarantee here decorative. The deny-list is checked
 * here. The Guardian does not know the deny-list and must not have to: it
 * already escalates anything the ordinary path analysis flags (writes
 * outside the project, destructive commands, injected content), so the belt
 * and the braces do not share a failure mode. If Guardian is later taught
 * the deny-list (W4's integration pass), the two checks stack instead of
 * replacing each other.
 */

// ── shapes ───────────────────────────────────────────────────────────────

export type ValidationKind = 'typecheck' | 'test' | 'command';

export interface StepValidation {
  kind: ValidationKind;
  /** For kind 'test': the single test file to run (`npx vitest run <file>`). */
  testFile?: string;
  /** For kind 'command': an explicit validation command. */
  command?: string;
}

export interface SelfBuildStep {
  description: string;
  /** Repo-relative paths this step will create or modify. */
  targetFiles: string[];
  validation: StepValidation;
}

export interface SelfBuildPlan {
  id: string;
  request: string;
  steps: SelfBuildStep[];
  createdAt: number;
}

/** Why a validation step did not run or did not pass. */
export type ValidationBlock =
  | 'protected-path'
  | 'guardian-hold'
  | 'permission-denied'
  | 'tool-unavailable'
  | 'no-validation';

export interface ValidationResult {
  ok: boolean;
  /** Set when the step was refused or blocked rather than simply failing. */
  blocked?: ValidationBlock;
  /** One plain sentence for the chat surface to display. */
  reason?: string;
  command?: string;
  output?: string;
  exitCode?: number | null;
}

// ── the deny-list ────────────────────────────────────────────────────────

/**
 * Paths a self-edit may never target. Matched against normalized,
 * lower-cased paths (see isProtectedPath), with `(^|/)` anchors so both
 * repo-relative and absolute paths match. src/ai is guarded even though the
 * directory does not exist today — the rule should survive the directory.
 */
// The deny-list lives in ./protectedPaths (dependency-free) so Guardian can
// enforce the same list without importing this file (which imports Guardian
// — a cycle). Imported here for the validateStep check, and re-exported so
// existing imports keep working.
import { isProtectedPath } from './protectedPaths';
export { PROTECTED_PATHS, isProtectedPath } from './protectedPaths';

/**
 * Normalize a path for deny-list matching: backslashes to forward slashes
 * (Windows), drive letters and leading `./` or `/` stripped. Kept exported
 * for callers that want case-sensitive comparisons; the deny-list check
 * itself is `isProtectedPath` from ./protectedPaths (re-exported above).
 */
export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/^\.\//, '')
    .replace(/^\//, '');
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Turn a step's validation spec into the terminal command to run. */
export function buildValidationCommand(v: StepValidation): string | null {
  switch (v.kind) {
    case 'typecheck':
      return 'npx tsc --noEmit';
    case 'test':
      return v.testFile && v.testFile.trim() ? `npx vitest run ${v.testFile.trim()}` : 'npx vitest run';
    case 'command': {
      const c = (v.command ?? '').trim();
      return c ? c : null;
    }
  }
}

/**
 * Pull the exit code back out of terminal_run's output. The native backend
 * renders `_Exit code: N_`, the sandbox backend `Exit code: N`; both spell
 * it "exit code". Returns null when the marker is absent — an unknown exit
 * code must count as failure, never as pass.
 */
function parseExitCode(output: string): number | null {
  const m = /exit code:?\s*(-?\d+)/i.exec(output);
  return m ? parseInt(m[1], 10) : null;
}

function newPlanId(): string {
  const rand = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `sb-${Date.now().toString(36)}-${rand}`;
}

// ── bounds ───────────────────────────────────────────────────────────────

/** A self-build plan is a sprint, not an epic — eight steps is generous. */
const MAX_PLAN_STEPS = 8;
/** Plans are kept only so the tools can resolve them; bounded like everything else. */
const MAX_STORED_PLANS = 20;
/** terminal_run caps at 300 000 ms; typecheck/test runs deserve all of it. */
const VALIDATION_TIMEOUT_MS = 300_000;
const FALLBACK_STEP: SelfBuildStep = {
  description: 'Propose the change manually in chat — the self-build planner could not generate a plan for this request.',
  targetFiles: [],
  validation: { kind: 'command' },
};

const PLANNING_PROMPT = (request: string) => `You are GIA's self-build planner. The user wants GIA (this codebase) changed or extended:

${request}

Plan the MINIMAL set of steps to implement it in this repository. The repo layout:
- src/services — service singletons and feature services (co-located __tests__ folders)
- src/services/brain — the agent loop (tool runner, schemas, guardian, permission gate)
- src/services/tools — tool registry files, one domain per file, built with defineTool
- src/components — React components (co-located __tests__)
- src/store — Zustand stores
- src/modules — top-level UI modules
- Tests live in __tests__ folders next to the code they cover.

Return ONLY valid JSON with this exact structure:
{
  "steps": [
    {
      "description": "What this step does",
      "targetFiles": ["src/services/..."],
      "validation": { "kind": "typecheck" | "test" | "command", "testFile": "path/to/x.test.ts (for kind=test)", "command": "shell command (for kind=command)" }
    }
  ]
}

Hard rules:
- At most ${MAX_PLAN_STEPS} steps, in logical order.
- Every step lists the exact repo-relative files it will create or modify in targetFiles.
- Every step ends with validation. Use kind "typecheck" after type-level changes, "test" (with testFile) after behavior changes, "command" only when tsc/vitest cannot prove the step.
- NEVER target protected paths: src-tauri/**, gate.rs, codex_client.rs, terminal.rs, desktop_fs.rs, src/components/TrustGate.tsx, src/components/CodexApprovalBridge.tsx, src/services/permissions.ts, src/services/CredentialVault.ts, src/services/untrusted.ts, src/services/brain/guardian.ts, src/services/brain/toolRunner.ts, src/services/brain/toolSchemas.ts, src/services/brain/permissionGate.ts, src/store/useTrustStore.ts, src/services/system/compliance.ts, src/services/InputGuardrails.ts, src/ai/**. The enforcement layer is not self-editable.

Return ONLY the JSON, no other text.`;

// ── the service ──────────────────────────────────────────────────────────

export class SelfBuilder {
  private plans = new Map<string, SelfBuildPlan>();

  private store(plan: SelfBuildPlan): void {
    this.plans.set(plan.id, plan);
    // Bounded: drop the oldest plans so a long session cannot grow this forever.
    if (this.plans.size > MAX_STORED_PLANS) {
      const oldest = this.plans.keys().next().value;
      if (oldest) this.plans.delete(oldest);
    }
  }

  getPlan(planId: string): SelfBuildPlan | undefined {
    return this.plans.get(planId);
  }

  listPlans(): SelfBuildPlan[] {
    return [...this.plans.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Turn a self-change request into a bounded step plan via GiaBrain — the
   * same generate() entry point the PlannerModule uses, with forceJson and
   * a strict response schema. Generation failing or returning garbage is a
   * normal outcome, not an error: the fallback plan proposes the change
   * manually in chat, which is always a safe way forward.
   */
  async plan(request: string): Promise<SelfBuildPlan> {
    const id = newPlanId();
    try {
      const res = await GiaBrain.generate({
        prompt: PLANNING_PROMPT(request),
        maxTokens: 2000,
        forceJson: true,
      });
      const steps = sanitizeSteps(JSON.parse(res.text) as unknown);
      if (steps.length > 0) {
        const plan: SelfBuildPlan = { id, request, steps, createdAt: Date.now() };
        this.store(plan);
        return plan;
      }
      logger.warn('[SelfBuilder] Plan generation produced no usable steps; using fallback.');
    } catch (e) {
      logger.warn('[SelfBuilder] Plan generation failed; using fallback:', e);
    }
    const fallback: SelfBuildPlan = {
      id,
      request,
      steps: [FALLBACK_STEP],
      createdAt: Date.now(),
    };
    this.store(fallback);
    return fallback;
  }

  /**
   * Validate one plan step — through the EXISTING tool execution path, no
   * side channel. SelfBuilder fetches the registered `terminal_run` tool
   * object and, because it is invoking the tool directly rather than
   * through the runner's chat loop, it replays the runner's own pre-flight
   * itself: Guardian review first, then the permission gate. No shortcut,
   * no bypass, no special privilege for self-edits.
   */
  async validateStep(
    step: SelfBuildStep,
    options: { planId?: string; workdir?: string } = {},
  ): Promise<ValidationResult> {
    // 1. The deny-list is absolute: never write, never validate, refuse.
    const hits = step.targetFiles.filter(isProtectedPath);
    if (hits.length > 0) {
      return {
        ok: false,
        blocked: 'protected-path',
        reason: `Refusing this self-build step: it targets protected paths (${hits.join(', ')}). ` +
          'The gate, terminal bridge, TrustGate, permissions, credentials and safety layers are not self-editable. ' +
          'Propose the change to the user in chat instead.',
      };
    }

    // 2. The command comes from the step's own validation spec.
    const command = buildValidationCommand(step.validation);
    if (!command) {
      return {
        ok: false,
        blocked: 'no-validation',
        reason: 'The step carries no runnable validation command, so it cannot be proven safe to ship.',
      };
    }

    // 3. The registered tool object — the same one chat uses.
    const tool = GiaTools.getTool('terminal_run');
    if (!tool) {
      return {
        ok: false,
        blocked: 'tool-unavailable',
        reason: 'terminal_run is not registered, so validation cannot run. Self-edits never ship unvalidated.',
        command,
      };
    }

    const args: Record<string, unknown> = { command, timeout: VALIDATION_TIMEOUT_MS };
    if (options.workdir) args.workdir = options.workdir;

    // 4. Guardian advisory review — the exact call the runner makes. A
    // 'high'-risk or un-owned ('unknown' authorization) action must prompt
    // even where a standing grant exists, exactly as the runner's
    // guardian-hold handling does.
    const guardian = reviewAction('terminal_run', tool.name, args);
    if (guardian.risk === 'high' || guardian.authorization === 'unknown') {
      const request = classifyToolRequest('terminal_run', tool.name, args);
      const preVerdict = useTrustStore.getState().verdict(request);
      if (preVerdict === 'allow') {
        // The grant never saw what Guardian saw — bypass it and ask.
        const choice = await useTrustStore.getState().request(request);
        if (choice === 'deny') {
          return {
            ok: false,
            blocked: 'guardian-hold',
            reason: `Guardian hold: ${guardian.reason} The user declined the validation run.`,
            command,
          };
        }
      }
      // 'ask' and 'block' fall through: gateToolCall prompts or refuses
      // through the normal path below.
    }

    // 5. The permission gate — the real one, same as any terminal call.
    const gate = await gateToolCall('terminal_run', tool.name, args);
    if (!gate.allowed) {
      return {
        ok: false,
        blocked: 'permission-denied',
        reason: gate.refusalReason ?? 'Permission denied by the trust gate.',
        command,
      };
    }

    // 6. Run and judge: exit code plus presence of error LINES in the output.
    const result = await tool.execute(args);
    const output = [result.content, result.error].filter(Boolean).join('\n');
    const exitCode = result.success ? 0 : parseExitCode(output);
    // S4-28: match error LINES, not the word — "0 errors" or an "error.ts"
    // filename in a passing run must not churn a rollback. A real tsc/vitest
    // failure always has a line that starts with `error`/`error TS` (or a
    // FAIL/✕ test marker); whitespace-leading lines are matched too.
    const hasError = /^\s*(error|error TS|FAIL|✕|×)\b/m.test(output);
    const failed = exitCode === null || exitCode !== 0 || hasError;

    return {
      ok: !failed,
      command,
      output: output.slice(0, 8000),
      exitCode,
      reason: failed
        ? `Validation failed${exitCode !== null ? ` (exit code ${exitCode})` : ' (unknown exit code)'}${hasError ? ' and the output contains errors' : ''}. Roll back the plan's writes instead of shipping.`
        : undefined,
    };
  }

  /**
   * Undo every write a plan made, by reverting FileSnapshots for the
   * plan's target files, newest first (the snapshot list is already sorted
   * that way, so overlapping writes unwind cleanly).
   */
  async rollback(planId: string): Promise<boolean> {
    const plan = this.plans.get(planId);
    if (!plan) return false;

    const targets = new Set(
      plan.steps
        .flatMap(s => s.targetFiles)
        .map(p => normalizePath(p).toLowerCase()),
    );
    if (targets.size === 0) return true; // the plan never touched a file

    const pending = fileSnapshots.listPending();
    const toRevert = pending.filter(s => targets.has(normalizePath(s.path).toLowerCase()));

    let failed = 0;
    for (const snap of toRevert) {
      const res = await fileSnapshots.revert(snap.id);
      if (!res.success) {
        failed++;
        logger.warn(`[SelfBuilder] Rollback of ${snap.path} failed: ${res.error ?? 'unknown error'}`);
      }
    }
    return failed === 0;
  }
}

/**
 * Coerce whatever the model returned into safe steps. Anything unusable is
 * dropped; a plan with zero usable steps falls back in plan().
 */
function sanitizeSteps(parsed: unknown): SelfBuildStep[] {
  const raw = (parsed as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(raw)) return [];
  const steps: SelfBuildStep[] = [];
  for (const entry of raw.slice(0, MAX_PLAN_STEPS)) {
    const e = entry as Record<string, unknown>;
    const description = typeof e.description === 'string' && e.description.trim()
      ? e.description.trim()
      : 'Untitled step';
    const targetFiles = Array.isArray(e.targetFiles)
      ? e.targetFiles.filter((t): t is string => typeof t === 'string' && !!t.trim()).map(t => t.trim())
      : [];
    const v = (e.validation ?? {}) as Record<string, unknown>;
    const rawKind = v.kind;
    const kind: ValidationKind = rawKind === 'test' || rawKind === 'command' ? rawKind : 'typecheck';
    const validation: StepValidation = {
      kind,
      ...(typeof v.testFile === 'string' && v.testFile.trim() ? { testFile: v.testFile.trim() } : {}),
      ...(typeof v.command === 'string' && v.command.trim() ? { command: v.command.trim() } : {}),
    };
    steps.push({ description, targetFiles, validation });
  }
  return steps;
}

// ── system prompt ────────────────────────────────────────────────────────

/**
 * selfBuilderPrompt — the self-edit paragraph for buildGiaSystem.
 *
 * Deliberately NOT inserted from inside buildGiaSystem.ts: that file is
 * warm from W2/W3, and this task's report hands the orchestrator the
 * one-line hook instead. The prompt keeps GIA inside the loop defined
 * above: plan → snapshot → edit → validate → rollback, with the deny-list
 * stated in the same words the code enforces.
 */
export function selfBuilderPrompt(userName?: string): string {
  const name = userName || 'the user';
  return `## Changing GIA itself (self-build)
When ${name} asks you to change or extend GIA itself, use the self-build loop — plan, edit, validate, ship or roll back. Never edit yourself ad hoc.

The repo layout: \`src/services\` (feature and brain services, with co-located \`__tests__\` folders), \`src/services/tools\` (tool registry files built with \`defineTool\`), \`src/components\` (React components, tests co-located), \`src/store\` (Zustand stores), \`src/modules\` (top-level UI modules).

The loop:
1. \`selfbuild_plan\` — turn the request into a small step plan (exact target files + a validation command per step).
2. Edit through the normal filesystem tools, so every write is snapshotted and permission-gated like any other. Self-edits get NO special privileges.
3. \`selfbuild_validate\` — prove each step with \`tsc\` / targeted \`vitest\` through the terminal tool before declaring anything done.
4. If validation fails: \`selfbuild_rollback\` — restore the plan's files from snapshots. A failing self-edit is rolled back, NEVER shipped.

Hard rule, enforced in code: self-edits may never target \`src-tauri/**\`, \`gate.rs\`, \`codex_client.rs\`, \`terminal.rs\`, \`desktop_fs.rs\`, \`TrustGate.tsx\`, \`CodexApprovalBridge.tsx\`, \`permissions.ts\`, \`CredentialVault.ts\`, \`untrusted.ts\`, \`brain/guardian.ts\`, \`brain/toolRunner.ts\`, \`brain/toolSchemas.ts\`, \`brain/permissionGate.ts\`, \`useTrustStore.ts\`, \`system/compliance.ts\`, \`InputGuardrails.ts\` or \`src/ai/**\`. Those are the enforcement layer; a step that names one is refused, and the honest move is to tell ${name} what you wanted to change there and let them do it.`;
}

export const selfBuilder = new SelfBuilder();
export default selfBuilder;
