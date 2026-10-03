import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { AgentActivityStrip } from '../AgentActivityStrip';
import { useGiaStore } from '../../store/useGiaStore';
import { useProtocolStore } from '../../store/useProtocolStore';
import { browserSession } from '../../services/browser/BrowserSession';

beforeEach(() => {
  useGiaStore.setState({ currentTool: null });
  useProtocolStore.setState({ protocols: [], consoleProtocols: [] });
  browserSession.closeAll();
});

afterEach(() => {
  vi.unstubAllGlobals();
  browserSession.closeAll();
});

describe('AgentActivityStrip — one glanceable answer', () => {
  it('is absent when nothing is happening', () => {
    // A permanent status bar is a permanent thing to look past.
    render(<AgentActivityStrip />);
    expect(screen.queryByTestId('agent-activity-strip')).toBeNull();
  });

  it('appears the moment a tool starts', () => {
    useGiaStore.setState({ currentTool: 'filesystem_write' });
    render(<AgentActivityStrip />);
    expect(screen.getByTestId('agent-activity-strip')).toBeInTheDocument();
  });

  it('names what is happening in words, not a tool id', () => {
    useGiaStore.setState({ currentTool: 'filesystem_write' });
    render(<AgentActivityStrip />);
    // "filesystem_write" is an implementation detail; the user needs the action.
    expect(screen.getByTestId('agent-activity-strip').textContent).not.toBe('');
    expect(screen.getByTestId('agent-activity-strip')).not.toHaveTextContent('undefined');
  });

  it('shows elapsed time once work starts', () => {
    vi.useFakeTimers();
    useGiaStore.setState({ currentTool: 'terminal_run' });
    render(<AgentActivityStrip />);

    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId('agent-activity-elapsed')).toHaveTextContent('3s');
    vi.useRealTimers();
  });

  it('formats longer elapsed time readably', () => {
    vi.useFakeTimers();
    useGiaStore.setState({ currentTool: 'terminal_run' });
    render(<AgentActivityStrip />);
    act(() => { vi.advanceTimersByTime(65_000); });
    expect(screen.getByTestId('agent-activity-elapsed')).toHaveTextContent('1m 05s');
    vi.useRealTimers();
  });

  it('counts multi-step work', () => {
    useProtocolStore.setState({
      protocols: [
        { id: 'a', type: 'file_read', summary: '', description: '', args: {}, impact: 'read', state: 'executing', createdAt: 0 },
        { id: 'b', type: 'file_write', summary: '', description: '', args: {}, impact: 'write', state: 'executing', createdAt: 0 },
      ],
      consoleProtocols: [],
    });
    render(<AgentActivityStrip />);
    expect(screen.getByTestId('agent-activity-strip')).toHaveTextContent('2 steps');
  });

  it('disappears when the work stops', () => {
    const { rerender } = render(<AgentActivityStrip />);
    useGiaStore.setState({ currentTool: 'terminal_run' });
    rerender(<AgentActivityStrip />);
    expect(screen.getByTestId('agent-activity-strip')).toBeInTheDocument();

    useGiaStore.setState({ currentTool: null });
    rerender(<AgentActivityStrip />);
    expect(screen.queryByTestId('agent-activity-strip')).toBeNull();
  });
});