import { describe, it, expect, vi, beforeEach } from 'vitest';

// SelfBuilder talks to GiaBrain for planning; the tests below feed it
// scripted responses instead of a live provider.
const generateMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../../GiaBrain', () => ({
  default: { generate: (...args: unknown[]) => generateMock(...args) },
}));

// Rollback must go through FileSnapshots' real API shape — mocked here so
// the tests assert the calls, not localStorage.
import type { FileSnapshot } from '../../FileSnapshots';
const listPendingMock = vi.fn<() => FileSnapshot[]>(() => []);
const revertMock = vi.fn<(id: string) => Promise<{ success: boolean; error?: string }>>(
  async () => ({ success: true }),
);
vi.mock('../../FileSnapshots', () => ({
  fileSnapshots: {
    listPending: () => listPendingMock(),
    revert: (id: string) => revertMock(id),
  },
}));

import {
  SelfBuilder,
  selfBuilder,
  isProtectedPath,
  buildValidationCommand,
  PROTECTED_PATHS,
} from '../SelfBuilder';
import GiaTools from '../../GiaTools';

// ── the deny-list ────────────────────────────────────────────────────────

describe('isProtectedPath', () => {
  it('blocks every deny-list entry (positive cases)', () => {
    const positives = [
      'src-tauri/src/main.rs',
      'src-tauri\\src\\gate.rs', // Windows separators
      'src-tauri/Cargo.toml',
      'src-tauri/src/gate.rs',
      'src-tauri/src/codex_client.rs',
      'src-tauri/src/terminal.rs',
      'src-tauri/src/desktop_fs.rs',
      'src/components/TrustGate.tsx',
      'src/services/permissions.ts',
      'src/services/CredentialVault.ts',
      'src/services/untrusted.ts',
      'src/services/brain/guardian.ts',
      'src/services/brain/toolRunner.ts',
      'src/services/brain/toolSchemas.ts',
      'src/services/brain/permissionGate.ts',
      'src/store/useTrustStore.ts',
      'src/components/CodexApprovalBridge.tsx',
      'src/services/system/compliance.ts',
      'src/services/InputGuardrails.ts',
      'src/ai/provider.ts',
      // absolute + case-insensitive, the Windows reality
      'C:\\Users\\me\\gia-cowork\\SRC-TAURI\\src\\gate.rs',
      'C:/Users/me/gia-cowork/Src/Services/Permissions.ts',
    ];
    for (const p of positives) {
      expect(isProtectedPath(p), `expected protected: ${p}`).toBe(true);
    }
  });

  it('does not block ordinary editable files (negative cases)', () => {
    const negatives = [
      'src/components/WorkLog.tsx',
      'src/services/SelfImprovement.ts',
      'src/services/brain/rollout.ts',
      'src/services/tools/selfbuild.ts',
      'src/modules/BuildModule.tsx',
      'src/services/permissions.test.ts',
      'src/services/TerminalService.ts',
      'src/utils/gatekeeper.ts',
      'src/services/GiaTools.ts',
    ];
    for (const p of negatives) {
      expect(isProtectedPath(p), `expected editable: ${p}`).toBe(false);
    }
  });

  it('exports one regex per deny-list entry, all usable directly', () => {
    expect(PROTECTED_PATHS.length).toBeGreaterThanOrEqual(17);
    for (const re of PROTECTED_PATHS) {
      expect(re).toBeInstanceOf(RegExp);
    }
  });
});

// ── planning ─────────────────────────────────────────────────────────────

describe('SelfBuilder.plan', () => {
  beforeEach(() => {
    generateMock.mockReset();
    listPendingMock.mockClear();
    revertMock.mockClear();
  });

  it('parses a valid LLM plan into typed steps', async () => {
    generateMock.mockResolvedValue({
      text: JSON.stringify({
        steps: [
          {
            description: 'Add a Build card',
            targetFiles: ['src/modules/BuildModule.tsx'],
            validation: { kind: 'typecheck' },
          },
          {
            description: 'Add its tests',
            targetFiles: ['src/modules/__tests__/BuildModule.test.tsx'],
            validation: { kind: 'test', testFile: 'src/modules/__tests__/BuildModule.test.tsx' },
          },
        ],
      }),
    });
    const plan = await selfBuilder.plan('add a build card');
    expect(plan.id).toMatch(/^sb-/);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].targetFiles).toEqual(['src/modules/BuildModule.tsx']);
    expect(plan.steps[1].validation).toEqual({
      kind: 'test',
      testFile: 'src/modules/__tests__/BuildModule.test.tsx',
    });
    // The planner was asked through the normal brain entry point with JSON forcing.
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0][0]).toMatchObject({ forceJson: true });
  });

  it('falls back to a single propose-in-chat step when generation fails', async () => {
    generateMock.mockRejectedValue(new Error('provider offline'));
    const plan = await selfBuilder.plan('make yourself smarter');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].description.toLowerCase()).toContain('propose the change manually in chat');
    expect(plan.steps[0].targetFiles).toEqual([]);
  });

  it('falls back when the model returns unusable JSON', async () => {
    generateMock.mockResolvedValue({ text: 'I would add some features, sure!' });
    const plan = await selfBuilder.plan('anything');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].description.toLowerCase()).toContain('propose the change manually in chat');
  });

  it('keeps the plan resolvable by id for the validate/rollback tools', async () => {
    generateMock.mockResolvedValue({
      text: JSON.stringify({ steps: [{ description: 'x', targetFiles: ['src/a.ts'], validation: { kind: 'typecheck' } }] }),
    });
    const plan = await selfBuilder.plan('x');
    expect(selfBuilder.getPlan(plan.id)).toBe(plan);
  });
});

// ── validation ───────────────────────────────────────────────────────────

describe('SelfBuilder.validateStep', () => {
  beforeEach(() => {
    generateMock.mockReset();
  });

  it('refuses a step that targets a protected path WITHOUT running anything', async () => {
    const getToolSpy = vi.spyOn(GiaTools, 'getTool');
    const result = await selfBuilder.validateStep({
      description: 'weaken the gate',
      targetFiles: ['src-tauri/src/gate.rs', 'src/services/permissions.ts'],
      validation: { kind: 'command', command: 'echo pwned' },
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe('protected-path');
    expect(result.reason).toContain('protected');
    // No tool was resolved, so nothing could have run — the refusal is the
    // whole interaction.
    expect(getToolSpy).not.toHaveBeenCalled();
    getToolSpy.mockRestore();
  });

  it('refuses a step whose command form is empty', async () => {
    const result = await selfBuilder.validateStep({
      description: 'vague',
      targetFiles: ['src/services/SelfImprovement.ts'],
      validation: { kind: 'command' },
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe('no-validation');
  });

  it('maps validation kinds to terminal commands', () => {
    expect(buildValidationCommand({ kind: 'typecheck' })).toBe('npx tsc --noEmit');
    expect(buildValidationCommand({ kind: 'test', testFile: 'src/x.test.ts' })).toBe('npx vitest run src/x.test.ts');
    expect(buildValidationCommand({ kind: 'test' })).toBe('npx vitest run');
    expect(buildValidationCommand({ kind: 'command', command: ' npm test ' })).toBe('npm test');
    expect(buildValidationCommand({ kind: 'command' })).toBeNull();
  });
});

// ── rollback ─────────────────────────────────────────────────────────────

describe('SelfBuilder.rollback', () => {
  beforeEach(() => {
    listPendingMock.mockReset().mockReturnValue([]);
    revertMock.mockReset().mockResolvedValue({ success: true });
  });

  it('reverts FileSnapshots for the plan\'s target files only', async () => {
    const builder = new SelfBuilder();
    // Seed a plan directly through the store seam: getPlan is what rollback reads.
    const plan = {
      id: 'sb-test-1',
      request: 'test',
      createdAt: Date.now(),
      steps: [
        { description: 'a', targetFiles: ['src/a.ts', 'src/b.ts'], validation: { kind: 'typecheck' as const } },
      ],
    };
    (builder as unknown as { plans: Map<string, typeof plan> }).plans.set(plan.id, plan);

    listPendingMock.mockReturnValue([
      { id: 'snap-a', path: 'src/a.ts', previousContent: null, newContent: '', timestamp: 1, seq: 1, source: 'filesystem_write', reverted: false },
      { id: 'snap-b', path: 'src/b.ts', previousContent: 'old', newContent: '', timestamp: 2, seq: 2, source: 'filesystem_write', reverted: false },
      { id: 'snap-other', path: 'src/unrelated.ts', previousContent: 'x', newContent: '', timestamp: 3, seq: 3, source: 'filesystem_write', reverted: false },
    ]);

    const ok = await builder.rollback('sb-test-1');
    expect(ok).toBe(true);
    expect(revertMock).toHaveBeenCalledTimes(2);
    expect(revertMock).toHaveBeenCalledWith('snap-a');
    expect(revertMock).toHaveBeenCalledWith('snap-b');
    expect(revertMock).not.toHaveBeenCalledWith('snap-other');
  });

  it('returns false for an unknown plan id', async () => {
    const ok = await selfBuilder.rollback('sb-does-not-exist');
    expect(ok).toBe(false);
    expect(revertMock).not.toHaveBeenCalled();
  });

  it('returns true without touching snapshots when the plan wrote nothing', async () => {
    const builder = new SelfBuilder();
    const plan = {
      id: 'sb-test-2',
      request: 'test',
      createdAt: Date.now(),
      steps: [{ description: 'fallback', targetFiles: [], validation: { kind: 'command' as const } }],
    };
    (builder as unknown as { plans: Map<string, typeof plan> }).plans.set(plan.id, plan);
    const ok = await builder.rollback('sb-test-2');
    expect(ok).toBe(true);
    expect(revertMock).not.toHaveBeenCalled();
  });

  it('returns false when any revert fails', async () => {
    const builder = new SelfBuilder();
    const plan = {
      id: 'sb-test-3',
      request: 'test',
      createdAt: Date.now(),
      steps: [{ description: 'a', targetFiles: ['src/a.ts'], validation: { kind: 'typecheck' as const } }],
    };
    (builder as unknown as { plans: Map<string, typeof plan> }).plans.set(plan.id, plan);
    listPendingMock.mockReturnValue([
      { id: 'snap-a', path: 'src/a.ts', previousContent: null, newContent: '', timestamp: 1, seq: 1, source: 'filesystem_write', reverted: false },
    ]);
    revertMock.mockResolvedValue({ success: false, error: 'disk full' });
    const ok = await builder.rollback('sb-test-3');
    expect(ok).toBe(false);
  });
});

// ── the system prompt ────────────────────────────────────────────────────

describe('selfBuilderPrompt', () => {
  it('describes the loop and the deny-list', async () => {
    const { selfBuilderPrompt } = await import('../SelfBuilder');
    const prompt = selfBuilderPrompt();
    expect(prompt).toContain('selfbuild_plan');
    expect(prompt).toContain('selfbuild_validate');
    expect(prompt).toContain('selfbuild_rollback');
    expect(prompt).toContain('src-tauri');
    expect(prompt).toContain('guardian.ts');
    expect(prompt.toLowerCase()).toContain('rolled back');
  });
});
