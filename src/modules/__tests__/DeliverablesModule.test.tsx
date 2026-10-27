import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DeliverablesModule from '../DeliverablesModule';
import { useGiaStore, type ChatSession } from '../../store/useGiaStore';

/**
 * The index is only useful if it finds things. These tests pin the two
 * behaviours that would make it lie: flattening artifacts off a session's
 * active branch, and saying "nothing yet" only when there really is nothing.
 */

const sessionWithArtifact: ChatSession = {
  id: 's1',
  title: 'Launch plan',
  createdAt: 1,
  updatedAt: 1,
  currentBranchId: 'b1',
  messages: [
    {
      message: {
        id: 'm1',
        role: 'assistant',
        content: 'Here is the page.',
        timestamp: 1_700_000_000_000,
        branchId: 'b1',
        artifacts: [
          { identifier: 'a1', type: 'text/html', title: 'Landing page', content: '<h1>Hello</h1>' },
          { identifier: 'a2', type: 'application/vnd.mermaid', title: 'Flow', content: 'graph TD; A-->B' },
        ],
      },
      children: [],
    },
  ],
};

beforeEach(() => {
  useGiaStore.setState({
    sessions: [sessionWithArtifact],
    archivedSessions: [],
    activeSessionId: 's1',
  } as never);
});

describe('DeliverablesModule', () => {
  it('lists artifacts from the active branch', () => {
    render(<DeliverablesModule />);
    expect(screen.getByText('Landing page')).toBeTruthy();
    expect(screen.getByText('Flow')).toBeTruthy();
  });

  it('opens a sandboxed preview when a card is selected', () => {
    render(<DeliverablesModule />);
    fireEvent.click(screen.getByText('Landing page'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/text\/html/)).toBeTruthy();
  });

  it('filters by artifact kind', () => {
    render(<DeliverablesModule />);
    fireEvent.click(screen.getByRole('button', { name: /Pages/ }));
    expect(screen.getByText('Landing page')).toBeTruthy();
    expect(screen.queryByText('Flow')).toBeNull();
  });

  it('includes hibernated sessions', () => {
    useGiaStore.setState({ sessions: [], archivedSessions: [sessionWithArtifact] } as never);
    render(<DeliverablesModule />);
    expect(screen.getByText('Landing page')).toBeTruthy();
  });

  it('shows an honest empty state', () => {
    useGiaStore.setState({ sessions: [], archivedSessions: [] } as never);
    render(<DeliverablesModule />);
    expect(screen.getByText('Nothing delivered yet')).toBeTruthy();
  });
});
