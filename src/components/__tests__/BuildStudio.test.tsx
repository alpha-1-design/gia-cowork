import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BuildStudio } from '../BuildStudio';
import { useGiaStore } from '../../store/useGiaStore';
import { useProviderStore } from '../../store/useProviderStore';
import { setShell, type ShellResult } from '../../services/agents/peerAgents';
import { DESKTOP_THEMES, DEFAULT_THEME } from '../../config/themes';
import { BUILD_STYLES } from '../../services/build/giaThemes';

/**
 * The gate is the behaviour worth protecting.
 *
 * A "load a skill first" rule that is only advisory is not a rule: the button
 * stays enabled, someone builds without one, and the difference between
 * generic output and finished output silently disappears. So these tests assert
 * the button is genuinely disabled, not merely styled to look disabled.
 */

const shell = vi.fn(async (_cmd: string): Promise<ShellResult> => ({ output: '', exitCode: 1 }));
const onStart = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  onStart.mockClear();
  onClose.mockClear();
  setShell(shell);

  useGiaStore.setState({
    activeSkillId: 'core-general',
    theme: DEFAULT_THEME,
    skills: [
      { id: 'core-general', name: 'General Assistant', description: 'General.', systemPrompt: '', tools: [], category: 'core' },
      { id: 'core-developer', name: 'Developer Mode', description: 'Engineering.', systemPrompt: '', tools: [], category: 'dev' },
      { id: 'skill-creative', name: 'Creative Architect', description: 'Design.', systemPrompt: '', tools: [], category: 'creative', icon: '✦' },
    ],
  } as never);

  useProviderStore.setState({
    providers: { openai: { apiKey: 'sk-x', model: 'gpt-4o', enabled: true } },
    activeProvider: 'openai',
    availableModels: { openai: [{ id: 'gpt-4o', label: 'GPT-4o', free: false }] },
  } as never);
});

const renderStudio = () => render(<BuildStudio onClose={onClose} onStart={onStart} />);

describe('BuildStudio', () => {
  it('keeps Start disabled until a real skill is loaded', () => {
    renderStudio();
    const btn = screen.getByTestId('build-start') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/Load a skill to continue|Describe what you want first/)).toBeTruthy();
  });

  it('unblocks Start once a specialised skill is chosen', async () => {
    renderStudio();
    fireEvent.change(screen.getByTestId('build-brief'), { target: { value: 'A kanban task board with drag and drop' } });
    fireEvent.click(screen.getByTestId('build-skill-core-developer'));

    await waitFor(() => expect((screen.getByTestId('build-start') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('Ready.')).toBeTruthy();
  });

  it('does not offer the catch-all General skill as a way past the gate', () => {
    renderStudio();
    expect(screen.queryByTestId('build-skill-core-general')).toBeNull();
  });

  it('still blocks on a skill when there is no brief', async () => {
    renderStudio();
    fireEvent.click(screen.getByTestId('build-skill-core-developer'));
    await waitFor(() => expect(screen.getByText(/Describe what you want first/)).toBeTruthy());
    expect((screen.getByTestId('build-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the brief together with the chosen model, theme and skill', async () => {
    renderStudio();
    fireEvent.change(screen.getByTestId('build-brief'), { target: { value: 'A kanban task board with drag and drop' } });
    fireEvent.click(screen.getByTestId('build-skill-core-developer'));
    await waitFor(() => expect((screen.getByTestId('build-start') as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByTestId('build-start'));

    expect(onStart).toHaveBeenCalledTimes(1);
    const msg = onStart.mock.calls[0][0] as string;
    expect(msg).toContain('A kanban task board with drag and drop');
    expect(msg).toContain('Developer Mode');
    expect(msg).toContain('openai');
    expect(msg).toContain('Obsidian Aurora');
    expect(onClose).toHaveBeenCalled();
  });

  it('renders every theme as a preview you can pick, and picking one applies it', () => {
    renderStudio();
    for (const t of DESKTOP_THEMES) {
      expect(screen.getByTestId(`build-theme-${t.id}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId('build-theme-light'));
    expect(useGiaStore.getState().theme).toBe('light');
  });

  it('does not probe for agents in a way that blocks opening', async () => {
    renderStudio();
    // No peers detected in this environment; the section must simply be absent.
    await waitFor(() => expect(shell).toHaveBeenCalled());
    expect(screen.queryByTestId('build-peer-claude')).toBeNull();
  });

  it('lists a detected peer agent without letting it gate the build', async () => {
    shell.mockImplementation(async (cmd: string) =>
      cmd.includes('code') ? { output: '/usr/bin/code', exitCode: 0 } : { output: '', exitCode: 1 });

    renderStudio();
    await waitFor(() => expect(screen.getByTestId('build-peer-vscode')).toBeTruthy());

    // A peer agent is informational — the skill gate still stands.
    fireEvent.change(screen.getByTestId('build-brief'), { target: { value: 'A kanban task board with drag and drop' } });
    expect((screen.getByTestId('build-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes when the backdrop is clicked, but not the panel', () => {
    const { container } = renderStudio();
    const backdrop = container.querySelector('[data-testid="build-studio"]')!;
    fireEvent.click(screen.getByTestId('build-brief'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('studio styles', () => {
  it('renders all seven build styles with distinct swatches', async () => {
    render(<BuildStudio onClose={() => {}} onStart={() => {}} />);
    for (const s of BUILD_STYLES) expect(screen.getByTestId(`build-style-${s.id}`)).toBeTruthy();
    expect(screen.getByTestId('build-style-obsidian')).toBeTruthy();
    expect(screen.getByTestId('build-style-prism')).toBeTruthy();
    await waitFor(() => expect(shell).toHaveBeenCalled());
  });

  it('persists the chosen style to the store', () => {
    render(<BuildStudio onClose={() => {}} onStart={() => {}} />);
    fireEvent.click(screen.getByTestId('build-style-carbon'));
    expect(useGiaStore.getState().buildStyleId).toBe('carbon');
  });

  it('includes the chosen style in the brief that starts the build', async () => {
    const onStart = vi.fn();
    render(<BuildStudio onClose={() => {}} onStart={onStart} />);
    fireEvent.change(screen.getByTestId('build-brief'), { target: { value: 'A kanban board with drag and drop' } });
    fireEvent.click(screen.getByTestId('build-style-verdant'));
    fireEvent.click(screen.getByTestId('build-skill-core-developer'));
    await waitFor(() => expect((screen.getByTestId('build-start') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('build-start'));
    expect(onStart.mock.calls[0][0]).toContain('Verdant');
  });
});
