import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { CodexApprovalBridge } from '../CodexApprovalBridge';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

type Handler = (event: { payload: unknown }) => void;

const listenMock = vi.mocked(listen);
const invokeMock = vi.mocked(invoke);

/** Event name -> captured handler, filled in when the component subscribes. */
const handlers = new Map<string, Handler>();

function approvalParams(command: string) {
  return { id: 'req-1', method: 'item/commandExecution/requestApproval', params: { command } };
}

/** Deliver an event through the mock the way the Tauri pump would. */
function emit(event: string, payload: unknown) {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no listener registered for ${event}`);
  act(() => handler({ payload }));
}

describe('CodexApprovalBridge', () => {
  beforeEach(() => {
    handlers.clear();
    listenMock.mockReset();
    // Cast: the mock is registered per event name, which the real
    // UnlistenFn-returning signature cannot express directly.
    listenMock.mockImplementation((async (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => {};
    }) as unknown as typeof listen);
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing until an approval event arrives', () => {
    render(<CodexApprovalBridge />);
    expect(screen.queryByTestId('codex-approval-card')).toBeNull();
  });

  it('rates a command approval with GIA\'s own rules and shows the command', async () => {
    render(<CodexApprovalBridge />);
    await act(async () => {}); // let the subscriptions register
    emit('codex://approval-request', approvalParams('git push --force origin main'));

    expect(screen.getByTestId('codex-approval-card')).toBeInTheDocument();
    expect(screen.getByTestId('codex-approval-risk')).toHaveTextContent('Dangerous');
    expect(screen.getByTestId('codex-approval-preview')).toHaveTextContent('git push --force origin main');
    expect(screen.getByText(/Force-pushes/)).toBeInTheDocument();
    // Same safe default as the trust gate: deny starts focused.
    expect(screen.getByTestId('codex-approval-deny')).toHaveFocus();
  });

  it('denies by echoing the request id back through codex_approval_respond', async () => {
    render(<CodexApprovalBridge />);
    await act(async () => {});
    // Numeric JSON-RPC id, the way codex_client.rs stringifies it.
    emit('codex://approval-request', {
      id: 12,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'npm test' },
    });
    expect(screen.getByTestId('codex-approval-card')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('codex-approval-deny'));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('codex_approval_respond', { requestId: '12', decision: false }),
    );
    expect(screen.queryByTestId('codex-approval-card')).toBeNull();
  });

  it('allow-once sends a true decision and grants nothing', async () => {
    render(<CodexApprovalBridge />);
    await act(async () => {});
    emit('codex://approval-request', approvalParams('npm test'));

    fireEvent.click(screen.getByTestId('codex-approval-once'));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('codex_approval_respond', { requestId: 'req-1', decision: true }),
    );
    expect(screen.queryByTestId('codex-approval-card')).toBeNull();
  });

  it('a session grant auto-approves later requests in the same scope', async () => {
    render(<CodexApprovalBridge />);
    await act(async () => {});
    emit('codex://approval-request', approvalParams('npm install zod'));
    expect(screen.getByTestId('codex-approval-card')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('codex-approval-session'));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('codex_approval_respond', { requestId: 'req-1', decision: true }),
    );
    invokeMock.mockClear();

    // Same scope ("npm install"), different command: answered without a card.
    emit('codex://approval-request', { ...approvalParams('npm install left-pad'), id: 'req-2' });
    expect(screen.queryByTestId('codex-approval-card')).toBeNull();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('codex_approval_respond', { requestId: 'req-2', decision: true }),
    );
  });

  it('offers no session grant for a severe action', async () => {
    render(<CodexApprovalBridge />);
    await act(async () => {});
    emit('codex://approval-request', approvalParams('rm -rf ~'));

    expect(screen.getByTestId('codex-approval-risk')).toHaveTextContent('Severe');
    expect(screen.queryByTestId('codex-approval-session')).toBeNull();
  });

  it('auto-denies when the request sits unanswered for 120s', async () => {
    vi.useFakeTimers();
    render(<CodexApprovalBridge />);
    await act(async () => {});
    emit('codex://approval-request', approvalParams('npm test'));
    expect(screen.getByTestId('codex-approval-card')).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(119_999); });
    expect(invokeMock).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(invokeMock).toHaveBeenCalledWith('codex_approval_respond', { requestId: 'req-1', decision: false });
    expect(screen.queryByTestId('codex-approval-card')).toBeNull();
  });

  it('denies the older request when a second approval arrives first', async () => {
    render(<CodexApprovalBridge />);
    await act(async () => {});
    emit('codex://approval-request', { ...approvalParams('npm install a'), id: 'req-1' });
    emit('codex://approval-request', { ...approvalParams('npm install b'), id: 'req-2' });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('codex_approval_respond', { requestId: 'req-1', decision: false }),
    );
    // The card now belongs to the newer request only.
    expect(screen.getByTestId('codex-approval-preview')).toHaveTextContent('npm install b');
    fireEvent.click(screen.getByTestId('codex-approval-deny'));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('codex_approval_respond', { requestId: 'req-2', decision: false }),
    );
  });

  it('classifies a fileChange approval through the write path', async () => {
    render(<CodexApprovalBridge />);
    await act(async () => {});
    emit('codex://approval-request', {
      id: 'req-3',
      method: 'item/fileChange/requestApproval',
      params: { path: 'src/x.ts', content: 'new body' },
    });

    expect(screen.getByTestId('codex-approval-card')).toBeInTheDocument();
    expect(screen.getByText(/Creates a new file at src\/x\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/Cannot show a diff/)).toBeInTheDocument();
    expect(screen.getByTestId('codex-approval-preview')).toHaveTextContent('new body');
  });

  it('shows the verbatim patch for a fileChange that carries one', async () => {
    render(<CodexApprovalBridge />);
    await act(async () => {});
    emit('codex://approval-request', {
      id: 'req-4',
      method: 'item/fileChange/requestApproval',
      params: { path: 'src/x.ts', patch: '*** Update File: src/x.ts\n@@\n-old\n+new' },
    });

    expect(screen.getByText(/Patch/)).toBeInTheDocument();
    expect(screen.getByTestId('codex-approval-preview')).toHaveTextContent('*** Update File: src/x.ts');
  });
});
