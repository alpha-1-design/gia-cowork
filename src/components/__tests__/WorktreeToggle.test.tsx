import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WorktreeToggle } from '../WorktreeToggle';
import { useGiaStore } from '../../store/useGiaStore';
import { useProjectContextStore } from '../../store/useProjectContextStore';
import { setShell, type ShellResult } from '../../services/git/worktree';

/** Ordered command-substring matchers; the first hit wins. */
interface Matcher { match: string; res: ShellResult }

/**
 * The behaviour under test is mostly refusal: git will not remove a worktree
 * with uncommitted changes, and GIA must not paper over that by forcing
 * silently. So the tests assert both that the force is NOT automatic and that
 * the offer survives a failed forced removal.
 */

let responses: Matcher[] = [];
let calls: string[] = [];

const shell = vi.fn(async (cmd: string): Promise<ShellResult> => {
  calls.push(cmd);
  for (const r of responses) {
    if (cmd.includes(r.match)) return r.res;
  }
  return { output: '', exitCode: 0 };
});

const REPO = '/repo';

function seedSession(over: Record<string, unknown> = {}) {
  useGiaStore.setState({
    sessions: [{
      id: 's1', title: 'Fix login', messages: [], createdAt: 1, updatedAt: 1,
      currentBranchId: 'b1', ...over,
    }],
  } as never);
}

beforeEach(() => {
  calls = [];
  responses = [{ match: '--is-inside-work-tree', res: { output: 'true', exitCode: 0 } }];
  shell.mockClear();
  setShell(shell);
  useProjectContextStore.setState({ entry: { path: REPO, projectName: 'p', markdown: '', updatedAt: 1 } } as never);
  seedSession();
});

describe('WorktreeToggle', () => {
  it('renders nothing when the project is not a git repository', async () => {
    responses = [{ match: '--is-inside-work-tree', res: { output: 'false', exitCode: 0 } }];
    const { container } = render(<WorktreeToggle sessionId="s1" />);
    await waitFor(() => expect(shell).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when there is no project path yet', () => {
    useProjectContextStore.setState({ entry: null } as never);
    const { container } = render(<WorktreeToggle sessionId="s1" />);
    expect(container.innerHTML).toBe('');
  });

  it('offers isolation for a repository and enables it on click', async () => {
    render(<WorktreeToggle sessionId="s1" />);
    const btn = await screen.findByTestId('worktree-enable');

    responses.push({ match: 'worktree list', res: { output: `worktree ${REPO}\nHEAD a\nbranch refs/heads/main\n`, exitCode: 0 } });
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByTestId('worktree-on')).toBeTruthy());
    const on = screen.getByTestId('worktree-on').textContent || '';
    expect(on).toContain('gia/fix-login-');
    expect(calls.some(c => c.includes('git worktree add'))).toBe(true);
  });

  it('surfaces a git failure instead of pretending isolation is on', async () => {
    useGiaStore.setState({
      sessions: [{
        id: 's1', title: 'Fix login', messages: [], createdAt: 1, updatedAt: 1, currentBranchId: 'b1',
        worktree: { path: '', branch: '', repoRoot: REPO, error: 'fatal: invalid reference' },
      }],
    } as never);

    render(<WorktreeToggle sessionId="s1" />);
    await screen.findByTestId('worktree-off');
    expect(screen.getByText('fatal: invalid reference')).toBeTruthy();
  });

  it('does NOT force removal when the worktree still has changes', async () => {
    useGiaStore.setState({
      sessions: [{
        id: 's1', title: 'Fix login', messages: [], createdAt: 1, updatedAt: 1, currentBranchId: 'b1',
        worktree: { path: `${REPO}/.gia/worktrees/fix-login-abcd`, branch: 'gia/fix-login-abcd', repoRoot: REPO },
      }],
    } as never);
    responses.push({
      match: 'git worktree remove',
      res: { output: 'fatal: contains modified or untracked files', exitCode: 128 },
    });

    render(<WorktreeToggle sessionId="s1" />);
    fireEvent.click(await screen.findByTestId('worktree-remove'));

    await waitFor(() => expect(screen.getByTestId('worktree-offer-force')).toBeTruthy());
    const removeCall = calls.find(c => c.includes('git worktree remove'))!;
    expect(removeCall).not.toContain('--force');
    // Still isolated — nothing was destroyed.
    expect(screen.getByTestId('worktree-on')).toBeTruthy();
  });

  it('forces only after the user explicitly asks, and clears the offer only on success', async () => {
    useGiaStore.setState({
      sessions: [{
        id: 's1', title: 'Fix login', messages: [], createdAt: 1, updatedAt: 1, currentBranchId: 'b1',
        worktree: { path: `${REPO}/.gia/worktrees/fix-login-abcd`, branch: 'gia/fix-login-abcd', repoRoot: REPO },
      }],
    } as never);
    // First (safe) removal fails; even the forced one fails.
    responses.push({ match: 'git worktree remove', res: { output: 'fatal: still locked', exitCode: 128 } });

    render(<WorktreeToggle sessionId="s1" />);
    fireEvent.click(await screen.findByTestId('worktree-remove'));

    // Two-step confirm: the offer only REVEALS the destructive button.
    fireEvent.click(await screen.findByTestId('worktree-offer-force'));
    fireEvent.click(await screen.findByTestId('worktree-force'));

    await waitFor(() => expect(calls.some(c => c.includes('git worktree remove --force'))).toBe(true));
    // Failed even when forced, so the offer must remain for another attempt.
    await waitFor(() => expect(screen.getByTestId('worktree-force')).toBeTruthy());
    expect(screen.getByTestId('worktree-on')).toBeTruthy();
  });

  it('drops the isolation state after a successful removal', async () => {
    useGiaStore.setState({
      sessions: [{
        id: 's1', title: 'Fix login', messages: [], createdAt: 1, updatedAt: 1, currentBranchId: 'b1',
        worktree: { path: `${REPO}/.gia/worktrees/fix-login-abcd`, branch: 'gia/fix-login-abcd', repoRoot: REPO },
      }],
    } as never);
    responses.push({ match: 'git worktree remove', res: { output: '', exitCode: 0 } });

    render(<WorktreeToggle sessionId="s1" />);
    fireEvent.click(await screen.findByTestId('worktree-remove'));

    await waitFor(() => expect(screen.getByTestId('worktree-off')).toBeTruthy());
    const session = useGiaStore.getState().sessions.find(s => s.id === 's1');
    expect(session?.worktree).toBeNull();
  });
});