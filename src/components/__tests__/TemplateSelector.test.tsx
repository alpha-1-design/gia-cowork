import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { TemplateSelector } from '../TemplateSelector';
import { useGiaStore } from '../../store/useGiaStore';

describe('TemplateSelector', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders nothing when closed', () => {
    const { container } = render(<TemplateSelector isOpen={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows templates on a fresh account instead of an empty screen', () => {
    const { container } = render(<TemplateSelector isOpen={true} onClose={() => {}} />);
    expect(container.textContent).toContain('Code Help');
    expect(container.textContent).toContain('Build an App');
    expect(container.textContent).not.toContain('No templates yet');
  });

  it('never claims a fake "auto-rotate" feature that does not exist', () => {
    const { container } = render(<TemplateSelector isOpen={true} onClose={() => {}} />);
    expect(container.textContent).not.toMatch(/auto-?rotate/i);
  });

  it('shows honest, real usage counts instead of a hardcoded "Used 0 times"', () => {
    const { container, rerender } = render(<TemplateSelector isOpen={true} onClose={() => {}} />);
    expect(container.textContent).toContain('Not used yet');

    // Select a template, which records real usage...
    const card = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Code Help'));
    fireEvent.click(card!);

    // ...reopen and it should now reflect that real usage.
    rerender(<TemplateSelector isOpen={false} onClose={() => {}} />);
    rerender(<TemplateSelector isOpen={true} onClose={() => {}} />);
    expect(container.textContent).toContain('Used 1 time');
  });

  it('drops the selected template prompt into the composer and closes', () => {
    let closed = false;
    const { container } = render(<TemplateSelector isOpen={true} onClose={() => { closed = true; }} />);
    const card = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Build an App'));
    fireEvent.click(card!);

    expect(closed).toBe(true);
    expect(useGiaStore.getState().pendingInput).toContain('Build a web app');
  });
});
