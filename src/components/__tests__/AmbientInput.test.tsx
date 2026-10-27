import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

vi.mock('../../store/useGiaStore', () => ({
  useGiaStore: Object.assign(vi.fn(() => 'idle'), { getState: () => ({ intentState: 'idle' }) }),
}));

const { default: AmbientInput } = await import('../AmbientInput');

describe('AmbientInput — paste should never auto-send', () => {
  it('submits on a genuine Enter keypress', () => {
    const onSubmit = vi.fn();
    const { getByPlaceholderText } = render(
      <AmbientInput value="hello" onChange={() => {}} onSubmit={onSubmit} placeholder="Message GIA…" />,
    );
    const input = getByPlaceholderText('Message GIA…');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not submit when Enter arrives immediately after a paste', () => {
    const onSubmit = vi.fn();
    const { getByPlaceholderText } = render(
      <AmbientInput value="pasted multi-line text" onChange={() => {}} onSubmit={onSubmit} placeholder="Message GIA…" />,
    );
    const input = getByPlaceholderText('Message GIA…');
    // Simulate an Android WebView paste that synthesizes an Enter keydown
    // while committing the pasted text.
    fireEvent.paste(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('resumes normal Enter-to-send behavior shortly after the paste window closes', async () => {
    const onSubmit = vi.fn();
    const { getByPlaceholderText } = render(
      <AmbientInput value="hello again" onChange={() => {}} onSubmit={onSubmit} placeholder="Message GIA…" />,
    );
    const input = getByPlaceholderText('Message GIA…');
    fireEvent.paste(input);
    await new Promise(r => setTimeout(r, 200));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('AmbientInput — queue while GIA is working', () => {
  it('keeps the composer enabled and queues on Enter', () => {
    const onSubmit = vi.fn();
    const { getByPlaceholderText } = render(
      <AmbientInput value="next task" onChange={() => {}} onSubmit={onSubmit} isLoading placeholder="Message GIA…" />,
    );
    const input = getByPlaceholderText('Type to queue a follow-up…');
    expect(input).not.toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('turns the action into Queue when text is present and Stop when it is empty', () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    const { getByLabelText, rerender } = render(
      <AmbientInput value="next task" onChange={() => {}} onSubmit={onSubmit} onStop={onStop} isLoading placeholder="Message GIA…" />,
    );
    fireEvent.click(getByLabelText('Queue message'));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(
      <AmbientInput value="" onChange={() => {}} onSubmit={onSubmit} onStop={onStop} isLoading placeholder="Message GIA…" />,
    );
    fireEvent.click(getByLabelText('Stop generating'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
