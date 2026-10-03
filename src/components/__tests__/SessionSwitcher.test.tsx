import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SessionSwitcher } from '../SessionSwitcher';
import { useGiaStore, type ChatSession } from '../../store/useGiaStore';

function session(id: string, title: string, updatedAt: number): ChatSession {
  return { id, title, messages: [], createdAt: updatedAt, updatedAt, currentBranchId: `${id}-branch` };
}

beforeEach(() => {
  useGiaStore.setState({
    sessions: [session('s1', 'Refactor the parser', 2000), session('s2', 'Fix the login bug', 1000)],
    activeSessionId: 's1',
    generationState: { active: false, module: null, sessionId: null, messageId: null },
  });
});

describe('SessionSwitcher — parallel conversations, reachable', () => {
  it('shows which conversation is open', () => {
    render(<SessionSwitcher />);
    expect(screen.getByText('Refactor the parser')).toBeInTheDocument();
  });

  it('keeps the list closed until asked', () => {
    render(<SessionSwitcher />);
    // Sessions used to live only in the Dashboard, so a second conversation was
    // unreachable from the surface you were working on.
    expect(screen.queryByText('Fix the login bug')).toBeNull();
  });

  it('reveals every conversation on demand', () => {
    render(<SessionSwitcher />);
    fireEvent.click(screen.getByTestId('session-switcher').firstElementChild!);
    expect(screen.getByText('Fix the login bug')).toBeInTheDocument();
  });

  it('lists the most recently touched conversation first', () => {
    render(<SessionSwitcher />);
    fireEvent.click(screen.getByTestId('session-switcher').firstElementChild!);
    const items = screen.getAllByTestId(/^session-item-/);
    expect(items[0]).toHaveTextContent('Refactor the parser');
  });

  it('switches conversations and closes the list', () => {
    render(<SessionSwitcher />);
    fireEvent.click(screen.getByTestId('session-switcher').firstElementChild!);
    act(() => { fireEvent.click(screen.getByTestId('session-item-s2')); });

    expect(useGiaStore.getState().activeSessionId).toBe('s2');
    expect(screen.queryByTestId('session-item-s2')).toBeNull();
  });

  it('starts a new conversation', () => {
    render(<SessionSwitcher />);
    fireEvent.click(screen.getByTestId('session-switcher').firstElementChild!);
    const before = useGiaStore.getState().sessions.length;
    fireEvent.click(screen.getByText('New'));
    expect(useGiaStore.getState().sessions.length).toBe(before + 1);
  });

  it('counts conversations so you know there are others', () => {
    render(<SessionSwitcher />);
    // Parallel work has to be visible, or you never start any.
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('does not count when there is only one conversation', () => {
    useGiaStore.setState({ sessions: [session('s1', 'Only one', 1)], activeSessionId: 's1' });
    render(<SessionSwitcher />);
    expect(screen.queryByText('2')).toBeNull();
  });

  it('marks the conversation GIA is generating in', () => {
    useGiaStore.setState({
      generationState: { active: true, module: 'chat', sessionId: 's2', messageId: 'msg-9' },
    });
    render(<SessionSwitcher />);
    fireEvent.click(screen.getByTestId('session-switcher').firstElementChild!);

    // The dot belongs on the session that is generating — keyed by SESSION id.
    // Matching on messageId instead would never fire, and the indicator would
    // be pure decoration.
    expect(screen.getByTestId('session-item-s2')).toContainElement(screen.getByTestId('session-busy'));
    expect(screen.getByTestId('session-item-s1')).not.toContainElement(screen.queryByTestId('session-busy'));
  });

  it('shows no busy dot when nothing is generating', () => {
    useGiaStore.setState({
      generationState: { active: false, module: null, sessionId: null, messageId: null },
    });
    render(<SessionSwitcher />);
    fireEvent.click(screen.getByTestId('session-switcher').firstElementChild!);
    expect(screen.queryByTestId('session-busy')).toBeNull();
  });
});