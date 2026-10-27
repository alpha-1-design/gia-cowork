import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

let storeState: Record<string, unknown> = {};

vi.mock('../../store/useGiaStore', () => ({
  useGiaStore: Object.assign(
    vi.fn(() => ({})),
    {
      getState: vi.fn(() => storeState),
      setState: vi.fn((updates: unknown) => {
        if (typeof updates === 'function') {
          storeState = updates(storeState);
        } else {
          storeState = { ...storeState, ...(updates as Record<string, unknown>) };
        }
      }),
    }
  ),
}));

const mockAddNotification = vi.fn();

const { useChatMessages } = await import('../useChatMessages');

describe('useChatMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const flatMessages = [
      { id: 'm1', role: 'user', content: 'hi', timestamp: 1000 },
      { id: 'm2', role: 'assistant', content: 'hello', timestamp: 2000, parentId: 'm1' },
    ];
    storeState = {
      sessions: [{
        id: 'sess-1',
        title: 'Test',
        messages: [{ message: flatMessages[0], children: [{ message: flatMessages[1], children: [] }] }],
        currentBranchId: 'b1',
        createdAt: 100,
        updatedAt: 100,
      }],
      activeSessionId: 'sess-1',
      addNotification: mockAddNotification,
      forkSession: vi.fn(),
      addBranch: vi.fn(),
      deleteMessage: vi.fn(),
      getBranchMessages: vi.fn(() => flatMessages),
      getActiveSession: vi.fn(() => (storeState.sessions as Array<{ id: string; messages: Array<{ id: string; role: string; content: string }> }>)[0]),
    };
  });

  it('returns initial state', () => {
    const { result } = renderHook(() => useChatMessages());
    expect(result.current.undoMsg).toBeNull();
    expect(result.current.copiedId).toBeNull();
    expect(result.current.showBranchView).toBe(false);
  });

  it('handleFork calls forkSession on active session', () => {
    const { result } = renderHook(() => useChatMessages());
    act(() => result.current.handleFork('m1'));
    expect(storeState.forkSession).toHaveBeenCalledWith('sess-1', 'm1');
  });

  it('handleCreateBranch calls addBranch', () => {
    const { result } = renderHook(() => useChatMessages());
    act(() => result.current.handleCreateBranch('m1'));
    expect(storeState.addBranch).toHaveBeenCalledWith('sess-1', 'm1');
  });

  it('handleEditResend finds a nested message in the active branch', () => {
    const { result } = renderHook(() => useChatMessages());
    const setInput = vi.fn();
    let handled = false;
    act(() => {
      handled = result.current.handleEditResend('m2', setInput);
    });
    expect(handled).toBe(true);
    expect(setInput).toHaveBeenCalledWith('hi');
  });

  it('handleEditResend returns false when the message is not in the branch', () => {
    const { result } = renderHook(() => useChatMessages());
    const setInput = vi.fn();
    let handled = true;
    act(() => {
      handled = result.current.handleEditResend('missing', setInput);
    });
    expect(handled).toBe(false);
    expect(setInput).not.toHaveBeenCalled();
  });

  it('handleDeleteWithUndo removes message and stores backup', () => {
    const { result } = renderHook(() => useChatMessages());
    act(() => result.current.handleDeleteWithUndo('m1'));
    expect(result.current.undoMsg).not.toBeNull();
    expect(result.current.undoMsg!.id).toBe('m1');
  });

  it('handleUndoDelete restores backup and clears undo', () => {
    const { result } = renderHook(() => useChatMessages());
    act(() => result.current.handleDeleteWithUndo('m1'));
    act(() => result.current.handleUndoDelete());
    expect(result.current.undoMsg).toBeNull();
    expect(mockAddNotification).toHaveBeenCalledWith('Message restored');
  });

  it('copyMessage sets copiedId', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const origClipboard = globalThis.navigator.clipboard;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { result } = renderHook(() => useChatMessages());
    await act(async () => {
      await result.current.copyMessage('m1', 'hello');
    });
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(result.current.copiedId).toBe('m1');
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: origClipboard,
      configurable: true,
    });
  });

  it('showBranchView toggles', () => {
    const { result } = renderHook(() => useChatMessages());
    act(() => result.current.setShowBranchView(true));
    expect(result.current.showBranchView).toBe(true);
  });
});
