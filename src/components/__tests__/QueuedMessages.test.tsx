import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueuedMessages } from '../QueuedMessages';
import { useGiaStore, type QueuedMessage } from '../../store/useGiaStore';

function queued(id: string, text: string, sessionId = 's1'): QueuedMessage {
  return { id, sessionId, text, attachments: [], queuedAt: Date.now() };
}

beforeEach(() => {
  useGiaStore.setState({ sessions: [], activeSessionId: 's1', queuedMessages: [] });
});

describe('message queue', () => {
  it('adds messages in the order they were sent', () => {
    const s = useGiaStore.getState();
    s.enqueueMessage(queued('q1', 'first'));
    s.enqueueMessage(queued('q2', 'second'));
    expect(useGiaStore.getState().queuedMessages.map(m => m.text)).toEqual(['first', 'second']);
  });

  it('removes a specific message and returns it', () => {
    const s = useGiaStore.getState();
    s.enqueueMessage(queued('q1', 'first'));
    s.enqueueMessage(queued('q2', 'second'));
    expect(s.dequeueMessage('q1')?.text).toBe('first');
    expect(useGiaStore.getState().queuedMessages.map(m => m.id)).toEqual(['q2']);
  });

  it('clears only the named session, so switching chats does not lose the other queue', () => {
    const s = useGiaStore.getState();
    s.enqueueMessage(queued('q1', 'here', 's1'));
    s.enqueueMessage(queued('q2', 'there', 's2'));
    s.clearQueue('s1');
    expect(useGiaStore.getState().queuedMessages.map(m => m.id)).toEqual(['q2']);
  });
});

describe('QueuedMessages — the queue must be visible', () => {
  it('shows nothing when the queue is empty', () => {
    render(<QueuedMessages />);
    expect(screen.queryByTestId('queued-messages')).toBeNull();
  });

  it('shows what is waiting, not just that something is', () => {
    // A message that vanishes into a buffer you cannot see gets sent twice.
    useGiaStore.setState({ queuedMessages: [queued('q1', 'also check the deploy script')] });
    render(<QueuedMessages />);
    expect(screen.getByText('also check the deploy script')).toBeInTheDocument();
  });

  it('counts multiple queued messages', () => {
    useGiaStore.setState({ queuedMessages: [queued('q1', 'a'), queued('q2', 'b')] });
    render(<QueuedMessages />);
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('2 messages queued');
  });

  it('lets the user cancel a queued message', () => {
    useGiaStore.setState({ queuedMessages: [queued('q1', 'oops', 's1')] });
    render(<QueuedMessages />);
    fireEvent.click(screen.getByTestId('queued-cancel-q1'));
    expect(useGiaStore.getState().queuedMessages).toHaveLength(0);
  });

  it('does not show another session\'s queue', () => {
    useGiaStore.setState({
      activeSessionId: 's1',
      queuedMessages: [queued('q2', 'other chat', 's2')],
    });
    render(<QueuedMessages />);
    expect(screen.queryByText('other chat')).toBeNull();
  });
});