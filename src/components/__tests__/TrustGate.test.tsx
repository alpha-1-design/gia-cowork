import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TrustGate } from '../TrustGate';
import { useTrustStore } from '../../store/useTrustStore';
import { classifyToolRequest } from '../../services/permissions';

function open(toolId: string, args: Record<string, unknown>, beforeContent?: string | null) {
  const request = classifyToolRequest(toolId, toolId, args, { beforeContent });
  // Drive the store the way the runner does, so the prompt is genuinely open.
  void useTrustStore.getState().request(request);
  return request;
}

describe('TrustGate', () => {
  beforeEach(() => {
    useTrustStore.setState({
      grants: [], sessionGrants: [], audit: [], armed: true, askThreshold: 'low', pending: null,
    });
  });

  it('renders nothing when no action is waiting', () => {
    render(<TrustGate />);
    expect(screen.queryByTestId('trust-gate')).toBeNull();
  });

  it('states the action in one sentence and shows the risk', () => {
    open('filesystem_write', { path: 'src/app.ts', content: 'new' }, 'old');
    render(<TrustGate />);

    expect(screen.getByTestId('trust-gate')).toBeInTheDocument();
    expect(screen.getByText(/Overwrites src\/app\.ts/)).toBeInTheDocument();
    expect(screen.getByTestId('trust-gate-risk')).toHaveTextContent('Low');
  });

  it('shows a real diff for a file write, not the raw payload', () => {
    open('filesystem_write', { path: 'src/app.ts', content: 'brand new line' }, 'the original line');
    render(<TrustGate />);

    // Both sides of the change must be visible — an approval card that only
    // shows the incoming content is not a review.
    expect(screen.getByText('the original line')).toBeInTheDocument();
    expect(screen.getByText('brand new line')).toBeInTheDocument();
  });

  it('labels a create as a new file rather than showing an empty diff', () => {
    open('filesystem_write', { path: 'src/new.ts', content: 'x' }, null);
    render(<TrustGate />);
    expect(screen.getByText(/New file/)).toBeInTheDocument();
  });

  it('shows the command itself and why it is dangerous', () => {
    open('terminal_run', { command: 'git push --force origin main' });
    render(<TrustGate />);

    expect(screen.getByTestId('trust-gate-command')).toHaveTextContent('git push --force origin main');
    expect(screen.getByText(/Force-pushes/)).toBeInTheDocument();
    expect(screen.getByTestId('trust-gate-risk')).toHaveTextContent('Dangerous');
  });

  it('marks data loss as Severe', () => {
    open('terminal_run', { command: 'rm -rf ~' });
    render(<TrustGate />);
    expect(screen.getByTestId('trust-gate-risk')).toHaveTextContent('Severe');
  });

  it('focuses Deny, so a reflexive Enter cannot approve', () => {
    open('terminal_run', { command: 'sudo rm -rf /' });
    render(<TrustGate />);
    expect(screen.getByTestId('trust-deny')).toHaveFocus();
  });

  it('resolves to deny on Escape', async () => {
    open('filesystem_write', { path: 'src/a.ts', content: 'x' }, null);
    render(<TrustGate />);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('trust-gate')).toBeNull());
    expect(useTrustStore.getState().grants).toHaveLength(0);
  });

  it('allows once without creating a standing grant', async () => {
    open('filesystem_write', { path: 'src/a.ts', content: 'x' }, null);
    render(<TrustGate />);

    fireEvent.click(screen.getByTestId('trust-once'));
    await waitFor(() => expect(screen.queryByTestId('trust-gate')).toBeNull());
    expect(useTrustStore.getState().sessionGrants).toHaveLength(0);
    expect(useTrustStore.getState().grants).toHaveLength(0);
  });

  it('scopes a session grant to the directory that was approved', async () => {
    open('filesystem_write', { path: 'src/a.ts', content: 'x' }, null);
    render(<TrustGate />);

    fireEvent.click(screen.getByTestId('trust-session'));
    await waitFor(() => expect(useTrustStore.getState().sessionGrants).toHaveLength(1));
    expect(useTrustStore.getState().sessionGrants[0].scope).toBe('write:src');
    expect(useTrustStore.getState().sessionGrants[0].label).toMatch(/writes under src/);
  });

  it('requires two deliberate clicks for a severe action', async () => {
    open('terminal_run', { command: 'rm -rf ~' });
    render(<TrustGate />);

    fireEvent.click(screen.getByTestId('trust-once'));
    // First click only arms — it must not run.
    expect(screen.getByTestId('trust-gate')).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    expect(screen.getByTestId('trust-once')).toHaveTextContent('Run it anyway');

    fireEvent.click(screen.getByTestId('trust-once'));
    await waitFor(() => expect(screen.queryByTestId('trust-gate')).toBeNull());
  });

  it('does not offer a standing grant for a severe action', () => {
    open('terminal_run', { command: 'rm -rf ~' });
    render(<TrustGate />);
    // "always delete everything" is not a permission worth handing out by
    // reflex, so it is not on the table at all.
    expect(screen.queryByTestId('trust-always')).toBeNull();
    expect(screen.queryByTestId('trust-session')).toBeNull();
  });
});