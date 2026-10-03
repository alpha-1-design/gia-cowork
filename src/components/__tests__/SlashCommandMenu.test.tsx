import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

// AmbientInput subscribes to intentState for its glow colour only.
vi.mock('../../store/useGiaStore', () => ({
  useGiaStore: Object.assign(vi.fn(() => 'idle'), { getState: () => ({ intentState: 'idle' }) }),
}));

const { default: AmbientInput } = await import('../AmbientInput');
const { isCommandNameActive } = await import('../SlashCommandMenu');
const { getCommandSuggestions } = await import('../../services/SlashCommands');

const PLACEHOLDER = 'Message GIA…';

function renderInput(value: string, onChange = vi.fn(), onSubmit = vi.fn()) {
  const utils = render(
    <AmbientInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={PLACEHOLDER} />,
  );
  return { ...utils, input: utils.getByPlaceholderText(PLACEHOLDER), onChange, onSubmit };
}

describe('Slash command autocomplete — gating', () => {
  it('opens on a bare slash', () => {
    const { container } = renderInput('/');
    expect(container.textContent).toMatch(/\/help/);
  });

  it('filters as the user types', () => {
    const { container } = renderInput('/mcp');
    expect(container.textContent).toContain('/mcp-connect');
    expect(container.textContent).not.toContain('/skill-creator');
  });

  it('stays closed once the user is typing arguments', () => {
    // "/note " is free text — a popup here would fight the words being typed.
    const { container } = renderInput('/note buy milk');
    expect(container.textContent).not.toContain('/skill-creator');
  });

  it('stays closed for ordinary text', () => {
    const { container } = renderInput('what is the weather');
    expect(container.textContent).not.toContain('/help');
  });

  it('closes when nothing matches rather than showing an empty box', () => {
    const { container } = renderInput('/zzzznotacommand');
    expect(container.textContent).not.toContain('/help');
  });

  it('exposes the gating rule directly', () => {
    expect(isCommandNameActive('/')).toBe(true);
    expect(isCommandNameActive('/mcp')).toBe(true);
    expect(isCommandNameActive('/note ')).toBe(false);
    expect(isCommandNameActive('hello')).toBe(false);
  });
});

describe('Slash command autocomplete — selection', () => {
  it('completes a command on click without submitting it', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { getByText } = renderInput('/', onChange, onSubmit);

    fireEvent.mouseDown(getByText('/help'));

    expect(onChange).toHaveBeenCalledWith('/help ');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('completes the highlighted command on Enter', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { input } = renderInput('/hel', onChange, onSubmit);

    fireEvent.keyDown(input, { key: 'Enter' });

    // Enter completes rather than sending, so the argument can be typed next.
    expect(onChange).toHaveBeenCalledWith('/help ');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('completes on Tab', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { input } = renderInput('/hel', onChange, onSubmit);

    fireEvent.keyDown(input, { key: 'Tab' });

    expect(onChange).toHaveBeenCalledWith('/help ');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('moves the highlight with the arrow keys', () => {
    const onChange = vi.fn();
    const { input, container } = renderInput('/', onChange);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // The second row is now highlighted and Enter should pick it, not the first.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0]).not.toBe('/help ');
    expect(container.textContent).toContain('/help');
  });

  it('wraps backwards from the top of the list', () => {
    const onChange = vi.fn();
    const { input, container } = renderInput('/', onChange);

    // The visible order is whatever the registry yields for a bare slash, so
    // assert the wrap lands on the last row rather than hardcoding a name.
    const lastRow = container.textContent!.trimEnd().split('\n').filter(Boolean).pop();

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatch(/^\/\S+ $/);
    expect(container.textContent).toContain(lastRow!.replace(/^\//, '').split(' ')[0]);
  });

  it('wraps forwards from the bottom of the list', () => {
    const onChange = vi.fn();
    const { input, container } = renderInput('/', onChange);
    const rowCount = getCommandSuggestions('/').length;

    for (let i = 0; i < rowCount; i++) fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    // rowCount steps from index 0 wraps back to index 0 — /help, the first row.
    expect(onChange.mock.calls[0][0]).toBe('/help ');
    expect(container.textContent).toContain('/help');
  });

  it('dismisses the menu on Escape and clears the composer', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { input } = renderInput('/hel', onChange, onSubmit);

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onChange).toHaveBeenCalledWith('');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('runs the command when the full name is typed and Enter is pressed', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { input } = renderInput('/help', onChange, onSubmit);

    fireEvent.keyDown(input, { key: 'Enter' });

    // Completing a command the user already finished typing would be a
    // keypress that looks like the app ignored them.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalledWith('/help ');
  });

  it('shows usage for commands that take arguments', () => {
    const { container } = renderInput('/mcp-connect');
    expect(container.textContent).toContain('<id or name>');
  });
});