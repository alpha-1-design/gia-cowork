import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiffViewer } from '../DiffViewer';

function lines(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => `line ${i + offset}`).join('\n');
}

describe('DiffViewer — large inputs', () => {
  it('renders a normal diff with no truncation notice', () => {
    render(<DiffViewer oldText={lines(50)} newText={lines(50)} sideBySide={false} />);
    expect(screen.queryByTestId('diff-truncated')).toBeNull();
    expect(screen.queryByTestId('diff-show-more')).toBeNull();
  });

  it('says so when it is showing only part of a large file', () => {
    render(<DiffViewer oldText={lines(5000)} newText={lines(5000)} sideBySide={false} />);
    const notice = screen.getByTestId('diff-truncated');
    // A diff that silently drops the last 3000 lines is worse than one that
    // admits it, so the omission is stated rather than hidden.
    expect(notice).toHaveTextContent(/2,000/);
    expect(notice).toHaveTextContent(/were not compared/);
  });

  it('mounts only a chunk of a large diff at a time', () => {
    render(<DiffViewer oldText={lines(1500)} newText={lines(1500)} sideBySide={false} />);
    expect(screen.getByTestId('diff-show-more')).toBeInTheDocument();
    // Not every line is in the DOM up front — that was the second half of the cost.
    expect(screen.getAllByText(/^line \d+$/).length).toBeLessThan(1400);
  });

  it('reveals more lines on request', () => {
    render(<DiffViewer oldText={lines(1500)} newText={lines(1500)} sideBySide={false} />);
    const before = screen.getAllByText(/^line \d+$/).length;
    fireEvent.click(screen.getByTestId('diff-show-more'));
    expect(screen.getAllByText(/^line \d+$/).length).toBeGreaterThan(before);
  });

  it('shows the change counts even when truncated', () => {
    const oldT = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const newT = oldT.map((l, i) => (i < 5 ? l.replace('line', 'changed') : l));
    render(<DiffViewer oldText={oldT.join('\n')} newText={newT.join('\n')} sideBySide={false} />);
    // +5/-5 is the change; the header must report it even though the tail was cut.
    expect(screen.getByText('+5')).toBeInTheDocument();
    expect(screen.getByText('-5')).toBeInTheDocument();
  });

  it('handles a huge file without rendering thousands of nodes', () => {
    render(<DiffViewer oldText={lines(20000)} newText={lines(20000)} sideBySide={false} />);
    // The point of the fix: node count is bounded by the chunk, not the file.
    expect(screen.getAllByText(/^line \d+$/).length).toBeLessThanOrEqual(400);
  });
});