import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTrustStore, type Grant } from '../../store/useTrustStore';

// The TerminalService singleton resolves its plugin at import time, so the
// Tauri marker must be in place before the first dynamic import below.
vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as Parameters<typeof invokeMock>)),
}));

function execResult(output = 'ok') {
  return { output, exitCode: 0, sessionId: 's1' };
}

function tauriExecCall(nth: number) {
  return invokeMock.mock.calls.filter(c => c[0] === 'terminal_exec')[nth];
}

/** Push the invoke mock's behavior for a full allow round-trip. */
function mockGateRoundTrip(behavior: (cmd: string, callIndex: number) => unknown) {
  let execCalls = 0;
  invokeMock.mockImplementation(async (cmd: string) => {
    const result = behavior(cmd, cmd === 'terminal_exec' ? execCalls++ : -1);
    if (result instanceof Error) throw result;
    return result;
  });
}

function grantSession(scope: string) {
  const grant: Grant = {
    scope,
    label: scope,
    toolId: 'terminal_run',
    risk: 'moderate',
    grantedAt: Date.now(),
    uses: 0,
    session: true,
  };
  useTrustStore.setState({ sessionGrants: [grant] });
}

function resetTrust() {
  useTrustStore.setState({
    grants: [], sessionGrants: [], audit: [], armed: true, askThreshold: 'low',
    pendingQueue: [], pending: null,
  });
}

describe('parseGateError — the gate.rs typed-error contract', () => {
  it('splits a prompt error on the FIRST TWO colons only', async () => {
    const { parseGateError } = await import('../TerminalService');
    // The scope is a command prefix and may contain ':' itself — everything
    // after the second colon is scope, never part of the id.
    expect(parseGateError('GIA_GATE_PROMPT:req-1:git push')).toEqual({
      kind: 'prompt', requestId: 'req-1', scope: 'git push',
    });
    expect(parseGateError('GIA_GATE_PROMPT:req-2:npm config set registry https://x')).toEqual({
      kind: 'prompt', requestId: 'req-2', scope: 'npm config set registry https://x',
    });
  });

  it('parses a deny error into its scope', async () => {
    const { parseGateError } = await import('../TerminalService');
    expect(parseGateError('GIA_GATE_DENY:rm -rf')).toEqual({ kind: 'deny', scope: 'rm -rf' });
  });

  it('returns null for anything that is not a gate token', async () => {
    const { parseGateError } = await import('../TerminalService');
    expect(parseGateError('Process crashed')).toBeNull();
    expect(parseGateError('GIA_GATE_PROMPT:no-scope')).toBeNull();
    expect(parseGateError('GIA_GATE_PROMPT:')).toBeNull();
    expect(parseGateError('GIA_GATE_DENY:')).toBeNull();
  });
});

describe('TerminalService — the gate round-trip', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetTrust();
  });

  async function loadService() {
    const mod = await import('../TerminalService');
    return mod.default;
  }

  it('retries once after mirroring an allow rust-side', async () => {
    grantSession('git push');
    mockGateRoundTrip((cmd, call) => {
      if (cmd === 'terminal_exec' && call === 0) {
        return new Error('GIA_GATE_PROMPT:req-1:git push');
      }
      if (cmd === 'terminal_exec') return execResult('pushed');
      return undefined; // gate_grant / gate_decide
    });
    const svc = await loadService();

    const res = await svc.exec('git push');

    expect(res.output).toBe('pushed');
    // The TS-side grant covers the scope, so no second card — but the approval
    // must still exist in the gate's own store for the retry to pass.
    expect(invokeMock).toHaveBeenCalledWith('gate_grant', { scope: 'git push', sessionOnly: true });
    expect(invokeMock).toHaveBeenCalledWith('gate_decide', { requestId: 'req-1', allow: false });
    expect(tauriExecCall(0)).toBeDefined();
    expect(tauriExecCall(1)).toBeDefined();
    expect(tauriExecCall(2)).toBeUndefined();
  });

  it('shows the standard card and refuses in plain language on deny', async () => {
    mockGateRoundTrip((cmd) => {
      if (cmd === 'terminal_exec') return new Error('GIA_GATE_PROMPT:req-2:git push');
      return undefined;
    });
    const svc = await loadService();

    const pending = svc.exec('git push');
    await vi.waitFor(() => {
      expect(useTrustStore.getState().pending).not.toBeNull();
    });
    // The user sees the ordinary TrustGate card, not a protocol string.
    expect(useTrustStore.getState().pending?.request.preview?.command).toBe('git push');
    useTrustStore.getState().resolve('deny');

    await expect(pending).rejects.toThrow('Blocked by the desktop command gate: git push');
    // No grant recorded, the Rust pending prompt is dropped, and the command
    // never ran a second time.
    expect(useTrustStore.getState().sessionGrants).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith('gate_decide', { requestId: 'req-2', allow: false });
    expect(tauriExecCall(0)).toBeDefined();
    expect(tauriExecCall(1)).toBeUndefined();
  });

  it('maps an allow on a Deny-classified scope to grant + retry', async () => {
    let execCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'terminal_exec') {
        if (execCalls++ === 0) throw new Error('GIA_GATE_DENY:rm -rf ~');
        return execResult('gone');
      }
      return undefined;
    });
    const svc = await loadService();

    const pending = svc.exec('rm -rf ~');
    await vi.waitFor(() => {
      expect(useTrustStore.getState().pending).not.toBeNull();
    });
    // A hard-blocked command gets the critical card — explicit two-click
    // allow, no standing buttons — matching the TS rule table's weight.
    expect(useTrustStore.getState().pending?.request.risk).toBe('critical');
    useTrustStore.getState().resolve('once');

    await expect(pending).resolves.toMatchObject({ output: 'gone' });
    expect(invokeMock).toHaveBeenCalledWith('gate_grant', { scope: 'rm -rf ~', sessionOnly: true });
    expect(tauriExecCall(1)).toBeDefined();
  });

  it('refuses instead of looping when the retry is gate-flagged again', async () => {
    grantSession('git push');
    mockGateRoundTrip((cmd) => {
      if (cmd === 'terminal_exec') return new Error('GIA_GATE_PROMPT:req-3:git push');
      return undefined;
    });
    const svc = await loadService();

    // A second gate error after the grant means the mirror did not take.
    // Retrying forever would spin; surfacing the token would teach the model
    // a protocol string. One refusal, exactly two attempts.
    await expect(svc.exec('git push')).rejects.toThrow('Blocked by the desktop command gate: git push');
    expect(tauriExecCall(1)).toBeDefined();
    expect(tauriExecCall(2)).toBeUndefined();
  });

  it('still wraps ordinary failures as exec errors', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'terminal_exec') throw new Error('Process crashed');
      return undefined;
    });
    const svc = await loadService();
    await expect(svc.exec('bad')).rejects.toThrow('Terminal exec failed: Process crashed');
  });
});
