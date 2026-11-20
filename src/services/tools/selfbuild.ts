import { z } from 'zod';
import { defineTool } from './defineTool';
import { selfBuilder, isProtectedPath } from '../selfbuild/SelfBuilder';
import type { Tool } from './types';

/**
 * Self-build tools (W4) — how GIA changes GIA.
 *
 * Three verbs, one loop: plan → edit → validate → ship-or-rollback. The
 * actual file edits never go through these tools; they go through the
 * normal filesystem tools so every write is snapshotted and passes the
 * ordinary compliance → Guardian → gate path. These tools exist so the
 * model can structure the work (plan), prove it (validate) and undo it
 * (rollback) — and so the permission cards name exactly what is at stake:
 * the plan id, the step index and the target files.
 */

const selfbuildPlan = defineTool({
  id: 'selfbuild_plan',
  name: 'selfbuild_plan',
  description: 'Plan a change to GIA itself. Call this FIRST when the user asks you to modify or extend GIA\'s own code. Returns a bounded step plan (target files + validation per step); edit the files afterwards with the normal filesystem tools.',
  category: 'selfbuild',
  input: z.object({
    request: z.string().min(3).max(4000).describe('What the user wants changed in GIA itself, in one or two sentences'),
  }),
  execute: async ({ request }) => {
    const plan = await selfBuilder.plan(request);
    const lines = [
      `## Self-build plan \`${plan.id}\``,
      '',
      ...plan.steps.map((s, i) => {
        const files = s.targetFiles.length > 0 ? s.targetFiles.join(', ') : '(no files — propose in chat)';
        const protectedHits = s.targetFiles.filter(isProtectedPath);
        const flag = protectedHits.length > 0
          ? ` ⚠️ **REFUSES AT VALIDATION: protected path(s) ${protectedHits.join(', ')}**`
          : '';
        const v = s.validation.kind === 'test' && s.validation.testFile
          ? `vitest ${s.validation.testFile}`
          : s.validation.kind === 'command'
            ? (s.validation.command || '(no command)')
            : 'npx tsc --noEmit';
        return `${i + 1}. ${s.description}\n   - files: ${files}${flag}\n   - validation: ${v}`;
      }),
      '',
      'Edit the files with the normal filesystem tools (every write is snapshotted and permission-gated), then validate each step with `selfbuild_validate` before declaring anything done.',
    ];
    return { success: true, content: lines.join('\n') };
  },
});

const selfbuildValidate = defineTool({
  id: 'selfbuild_validate',
  name: 'selfbuild_validate',
  description: 'Validate one step of a self-build plan: runs npx tsc --noEmit or npx vitest <file> through the gated terminal tool (Guardian-reviewed, permission-gated — no special privileges for self-edits). A failed validation means the plan must be rolled back, not shipped.',
  category: 'selfbuild',
  input: z.object({
    planId: z.string().min(1).describe('The plan id returned by selfbuild_plan (e.g. sb-…)'),
    stepIndex: z.number().int().min(0).describe('Zero-based index of the step to validate'),
    workdir: z.string().optional().describe('Optional working directory for the validation command (defaults to the repo root GIA is working in)'),
  }),
  execute: async ({ planId, stepIndex, workdir }) => {
    const plan = selfBuilder.getPlan(planId);
    if (!plan) {
      return {
        success: false,
        content: '',
        error: `Unknown plan id "${planId}". Call selfbuild_plan first — plans are not persisted across restarts.`,
      };
    }
    const step = plan.steps[stepIndex];
    if (!step) {
      return {
        success: false,
        content: '',
        error: `Plan ${planId} has ${plan.steps.length} step(s); stepIndex ${stepIndex} is out of range.`,
      };
    }
    const result = await selfBuilder.validateStep(step, { planId, workdir });
    const verdict = result.ok
      ? '✅ Step validated.'
      : result.blocked
        ? `🛑 Step refused (${result.blocked}).`
        : '❌ Step FAILED validation.';
    const body = [
      verdict,
      '',
      `**Step ${stepIndex}** of \`${planId}\`: ${step.description}`,
      result.command ? `**Command:** \`${result.command}\`` : '',
      result.reason ? `\n${result.reason}` : '',
      result.output ? `\n\`\`\`\n${result.output}\n\`\`\`` : '',
    ].filter(Boolean).join('\n');
    return { success: result.ok, content: body, error: result.ok ? undefined : result.reason };
  },
});

const selfbuildRollback = defineTool({
  id: 'selfbuild_rollback',
  name: 'selfbuild_rollback',
  description: 'Roll back a self-build plan: restore every file the plan touched from the snapshots taken before each write. Call this when validation fails or the user changes their mind — a failing self-edit is rolled back, never shipped.',
  category: 'selfbuild',
  input: z.object({
    planId: z.string().min(1).describe('The plan id whose writes should be reverted (e.g. sb-…)'),
  }),
  execute: async ({ planId }) => {
    const ok = await selfBuilder.rollback(planId);
    if (!ok) {
      const known = selfBuilder.getPlan(planId);
      return {
        success: false,
        content: '',
        error: known
          ? `Rollback of plan ${planId} failed for at least one file — check the undo list in the UI and restore manually if needed.`
          : `Unknown plan id "${planId}" — nothing to roll back.`,
      };
    }
    return {
      success: true,
      content: `↩️ Plan \`${planId}\` rolled back — every file it touched was restored from its pre-write snapshot. Report honestly to the user what was reverted and why.`,
    };
  },
});

export const selfBuildTools: Tool[] = [selfbuildPlan, selfbuildValidate, selfbuildRollback];
