import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PreviewPanel } from '../PreviewPanel';
import { useGiaStore } from '../../store/useGiaStore';

/**
 * Two things are under test.
 *
 * First, the iframe flags. This preview runs whatever the agent just built, so
 * it must not be able to reach the GIA origin. `allow-scripts` is required or
 * the app does not run at all; `allow-same-origin` is the one that must be
 * absent.
 *
 * Second, the reason the panel exists at all: the preview must sit beside the
 * terminal, not cover it. That is asserted structurally — the panel fills its
 * dock slot rather than being a fixed overlay.
 */

beforeEach(() => {
  useGiaStore.setState({ buildPreviewUrl: null } as never);
});

describe('PreviewPanel', () => {
  it('explains itself when nothing is running instead of showing a dead frame', () => {
    render(<PreviewPanel />);
    expect(screen.getByTestId('preview-empty')).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('renders the served URL once a build is running', () => {
    useGiaStore.setState({ buildPreviewUrl: 'http://localhost:5173' } as never);
    render(<PreviewPanel />);
    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('http://localhost:5173');
    expect(screen.getByTitle('http://localhost:5173')).toBeTruthy();
  });

  it('sandboxes the frame and denies it the GIA origin', () => {
    useGiaStore.setState({ buildPreviewUrl: 'http://localhost:5173' } as never);
    render(<PreviewPanel />);
    const sandbox = document.querySelector('iframe')!.getAttribute('sandbox')!;
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(document.querySelector('iframe')!.getAttribute('referrerPolicy')).toBe('no-referrer');
  });

  it('reloads on demand by remounting the frame', () => {
    useGiaStore.setState({ buildPreviewUrl: 'http://localhost:5173' } as never);
    render(<PreviewPanel />);
    const before = document.querySelector('iframe');
    fireEvent.click(screen.getByTestId('preview-refresh'));
    const after = document.querySelector('iframe');
    // A different element, so the browser actually reloads rather than no-oping.
    expect(after).not.toBe(before);
    expect(after!.getAttribute('src')).toBe('http://localhost:5173');
  });

  it('opens externally with noopener so the page cannot reach back', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    useGiaStore.setState({ buildPreviewUrl: 'http://localhost:5173' } as never);
    render(<PreviewPanel />);
    fireEvent.click(screen.getByLabelText('Open preview in browser'));
    expect(open).toHaveBeenCalledWith('http://localhost:5173', '_blank', 'noopener,noreferrer');
    vi.unstubAllGlobals();
  });

  it('offers the large sheet only when an expander is supplied', () => {
    useGiaStore.setState({ buildPreviewUrl: 'http://localhost:5173' } as never);
    const { rerender } = render(<PreviewPanel />);
    expect(screen.queryByText('Expand')).toBeNull();

    const onExpand = vi.fn();
    rerender(<PreviewPanel onExpand={onExpand} />);
    fireEvent.click(screen.getByText('Expand'));
    expect(onExpand).toHaveBeenCalled();
  });

  it('fills its dock slot rather than overlaying the terminal', () => {
    useGiaStore.setState({ buildPreviewUrl: 'http://localhost:5173' } as never);
    render(<PreviewPanel />);
    const root = screen.getByTestId('preview-panel');
    // No `fixed`/`absolute` positioning: an overlay would cover the terminal.
    expect(root.className).not.toContain('fixed');
    expect(root.className).not.toContain('absolute');
  });
});