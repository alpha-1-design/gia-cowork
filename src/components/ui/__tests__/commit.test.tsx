import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Commit from '../commit';

describe('Commit card (changed files)', () => {
  const files = [
    { path: 'src/services/voice/VoiceSession.ts', additions: 120, deletions: 4 },
    { path: 'src/components/ui/commit.tsx', additions: 260, deletions: 0 },
    { path: 'README.md', additions: 2, deletions: 1 },
  ];

  it('renders the summary counts and groups by folder', () => {
    render(<Commit files={files} />);
    expect(screen.getByText('3 changed files')).toBeTruthy();
    expect(screen.getByText('+382')).toBeTruthy();
    expect(screen.getByText('−5')).toBeTruthy();
    // folder rows exist with the grouped counts
    expect(screen.getByText('src/services/voice')).toBeTruthy();
    expect(screen.getByText('src/components/ui')).toBeTruthy();
    // root-level file is directly listed
    expect(screen.getByText('README.md')).toBeTruthy();
  });

  it('collapses and expands via the header toggle', () => {
    render(<Commit files={files} />);
    const toggle = screen.getByLabelText('Collapse changed files');
    fireEvent.click(toggle);
    expect(screen.getByLabelText('Expand changed files')).toBeTruthy();
    // The content wrapper is the element carrying aria-controls/hidden.
    const content = screen.getByText('VoiceSession.ts').closest('div[id]') as HTMLElement | null;
    expect(content?.hasAttribute('hidden')).toBe(true);
    fireEvent.click(screen.getByLabelText('Expand changed files'));
    expect(content?.hasAttribute('hidden')).toBe(false);
  });

  it('folder toggles hide nested files only', () => {
    render(<Commit files={files} />);
    const folderBtn = screen.getByText('src/services/voice').closest('button');
    fireEvent.click(folderBtn!);
    expect(screen.queryByText('VoiceSession.ts')).toBeNull();
    expect(screen.getByText('commit.tsx')).toBeTruthy(); // other folder untouched
  });

  it('fileAction puts a per-file action on every row', () => {
    const onSelect = vi.fn();
    render(<Commit files={files} fileAction={{ label: 'Revert', onSelect }} />);
    fireEvent.click(screen.getByLabelText('Revert README.md'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: 'README.md' }));
  });

  it('handles the empty case', () => {
    render(<Commit files={[]} />);
    expect(screen.getByText('No changed files.')).toBeTruthy();
  });
});
