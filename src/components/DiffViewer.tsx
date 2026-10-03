import { useEffect, useMemo, useState } from 'react';
import { GitBranch, GitCommit, ChevronDown } from 'lucide-react';

interface DiffLine {
  type: 'add' | 'remove' | 'same';
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

/**
 * Ceiling on how many lines go into the comparison.
 *
 * computeDiff builds an (n+1)x(m+1) matrix before it emits anything, so cost
 * is set by the size of the INPUT, not the size of the change. Measured on a
 * representative agent rewrite: 2000 lines 0.5s, 4000 lines 1.6s, 8000 lines
 * 3.2s — a visible freeze on files that are entirely ordinary (a JSON export,
 * a lockfile, a generated bundle). Claude rebuilt their viewer for the same
 * reason.
 *
 * Capping the input bounds that work. The cap is stated in the UI rather than
 * applied quietly, because a diff that silently omits the last 6000 lines is
 * worse than one that admits it.
 */
const MAX_DIFF_LINES = 2000;

/** How many diff lines are mounted at once. Bounds DOM cost independently. */
const RENDER_CHUNK = 400;

function capLines(text: string): { text: string; omitted: number } {
  const lines = text.split('\n');
  if (lines.length <= MAX_DIFF_LINES) return { text, omitted: 0 };
  return { text: lines.slice(0, MAX_DIFF_LINES).join('\n'), omitted: lines.length - MAX_DIFF_LINES };
}

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: DiffLine[] = [];

  let oi = 0, ni = 0;
  const lcs: [number, number][] = [];

  const dp: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
    Array(newLines.length + 1).fill(0)
  );
  for (let i = 1; i <= oldLines.length; i++) {
    for (let j = 1; j <= newLines.length; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = oldLines.length, j = newLines.length;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      lcs.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  let lcsIdx = 0;
  while (oi < oldLines.length || ni < newLines.length) {
    if (lcsIdx < lcs.length && oi === lcs[lcsIdx][0] && ni === lcs[lcsIdx][1]) {
      result.push({ type: 'same', oldLine: oi, newLine: ni, content: oldLines[oi] });
      oi++;
      ni++;
      lcsIdx++;
    } else if (lcsIdx < lcs.length && oi < lcs[lcsIdx][0]) {
      result.push({ type: 'remove', oldLine: oi, newLine: null, content: oldLines[oi] });
      oi++;
    } else if (lcsIdx < lcs.length && ni < lcs[lcsIdx][1]) {
      result.push({ type: 'add', oldLine: null, newLine: ni, content: newLines[ni] });
      ni++;
    } else if (oi < oldLines.length) {
      result.push({ type: 'remove', oldLine: oi, newLine: null, content: oldLines[oi] });
      oi++;
    } else if (ni < newLines.length) {
      result.push({ type: 'add', oldLine: null, newLine: ni, content: newLines[ni] });
      ni++;
    }
  }

  return result;
}

interface DiffViewerProps {
  oldText: string;
  newText: string;
  oldFilename?: string;
  newFilename?: string;
  height?: string;
  sideBySide?: boolean;
}

export function DiffViewer({
  oldText,
  newText,
  oldFilename = 'original',
  newFilename = 'modified',
  height = '400px',
  sideBySide: initialSideBySide = true,
}: DiffViewerProps) {
  const [sideBySide, setSideBySide] = useState(initialSideBySide);
  // Reset the render window when the diff being shown changes, or "show more"
  // from a previous file would carry over and mount the wrong lines.
  const [shown, setShown] = useState(RENDER_CHUNK);

  const capped = useMemo(() => ({
    old: capLines(oldText),
    new: capLines(newText),
  }), [oldText, newText]);

  const diff = useMemo(
    () => computeDiff(capped.old.text, capped.new.text),
    [capped.old.text, capped.new.text],
  );

  // A new diff means the old "show more" window is meaningless — reset it.
  useEffect(() => { setShown(RENDER_CHUNK); }, [oldText, newText]);

  const stats = useMemo(() => {
    const adds = diff.filter((l) => l.type === 'add').length;
    const removes = diff.filter((l) => l.type === 'remove').length;
    return { adds, removes, total: diff.length };
  }, [diff]);

  const omitted = Math.max(capped.old.omitted, capped.new.omitted);
  const visible = diff.slice(0, shown);
  const hasMore = diff.length > shown;

  const truncationNotice = omitted > 0 ? (
    <div
      className="px-3 py-1.5 text-[10px] border-b border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400"
      data-testid="diff-truncated"
    >
      Showing the first {MAX_DIFF_LINES.toLocaleString()} lines only — {omitted.toLocaleString()} more
      {' '}in {capped.old.omitted > capped.new.omitted ? 'the original' : 'the new file'} were not compared.
      Open the file to review the rest.
    </div>
  ) : null;

  const showMore = hasMore ? (
    <button
      onClick={() => setShown(s => s + RENDER_CHUNK)}
      data-testid="diff-show-more"
      className="w-full flex items-center justify-center gap-1 py-1.5 text-[10px] text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors border-t border-gray-200 dark:border-gray-700"
    >
      <ChevronDown size={11} />
      Show more — {diff.length - shown} of {diff.length.toLocaleString()} lines remaining
    </button>
  ) : null;

  if (sideBySide) {
    const leftLines: DiffLine[] = [];
    const rightLines: DiffLine[] = [];
    for (const line of visible) {
      if (line.type === 'add') {
        leftLines.push({ type: 'same', oldLine: null, newLine: null, content: '' });
        rightLines.push(line);
      } else if (line.type === 'remove') {
        leftLines.push(line);
        rightLines.push({ type: 'same', oldLine: null, newLine: null, content: '' });
      } else {
        leftLines.push(line);
        rightLines.push(line);
      }
    }

    return (
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-gray-900">
        <DiffHeader
          oldFilename={oldFilename}
          newFilename={newFilename}
          adds={stats.adds}
          removes={stats.removes}
          sideBySide={sideBySide}
          onToggleView={() => setSideBySide(false)}
        />
        {truncationNotice}
        <div className="flex" style={{ height }}>
          <div className="flex-1 overflow-auto border-r border-gray-200 dark:border-gray-700">
            {leftLines.map((line, i) => (
              <DiffSideLine key={i} line={line} side="left" />
            ))}
            {showMore}
          </div>
          <div className="flex-1 overflow-auto">
            {rightLines.map((line, i) => (
              <DiffSideLine key={i} line={line} side="right" />
            ))}
            {showMore}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-gray-900">
      <DiffHeader
        oldFilename={oldFilename}
        newFilename={newFilename}
        adds={stats.adds}
        removes={stats.removes}
        sideBySide={sideBySide}
        onToggleView={() => setSideBySide(true)}
      />
      {truncationNotice}
      <div className="overflow-auto font-mono text-xs leading-relaxed" style={{ height }}>
        {visible.map((line, i) => (
          <DiffUnifiedLine key={i} line={line} />
        ))}
        {showMore}
      </div>
    </div>
  );
}

function DiffHeader({
  oldFilename,
  newFilename,
  adds,
  removes,
  sideBySide,
  onToggleView,
}: {
  oldFilename: string;
  newFilename: string;
  adds: number;
  removes: number;
  sideBySide: boolean;
  onToggleView: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-2">
        <GitBranch size={14} className="text-gray-400" />
        <span className="text-xs text-gray-500">{oldFilename}</span>
        <GitCommit size={12} className="text-gray-300" />
        <span className="text-xs text-gray-500">{newFilename}</span>
        <span className="text-xs text-green-600 dark:text-green-400 font-medium">+{adds}</span>
        <span className="text-xs text-red-600 dark:text-red-400 font-medium">-{removes}</span>
      </div>
      <button
        onClick={onToggleView}
        className="text-[10px] px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
      >
        {sideBySide ? 'Unified' : 'Side-by-side'}
      </button>
    </div>
  );
}

function DiffSideLine({ line, side }: { line: DiffLine; side: 'left' | 'right' }) {
  const bg = line.type === 'add'
    ? 'bg-green-50 dark:bg-green-950/20'
    : line.type === 'remove'
    ? 'bg-red-50 dark:bg-red-950/20'
    : '';

  const prefix = line.type === 'add' ? '+'
    : line.type === 'remove' ? '−'
    : ' ';

  const prefixColor = line.type === 'add'
    ? 'text-green-600 dark:text-green-400'
    : line.type === 'remove'
    ? 'text-red-600 dark:text-red-400'
    : 'text-gray-400';

  return (
    <div className={`flex items-center ${bg} hover:bg-opacity-80`}>
      <span className={`w-5 text-right px-1 text-gray-400 select-none text-[10px]`}>
        {line.type === 'add' && side === 'right' ? (line.newLine !== null ? line.newLine + 1 : '') : ''}
        {line.type === 'remove' && side === 'left' ? (line.oldLine !== null ? line.oldLine + 1 : '') : ''}
        {line.type === 'same' ? (side === 'left' ? (line.oldLine !== null ? line.oldLine + 1 : '') : (line.newLine !== null ? line.newLine + 1 : '')) : ''}
      </span>
      <span className={`w-4 text-center select-none ${prefixColor}`}>{line.content === '' ? '' : prefix}</span>
      <span className="flex-1 px-1 whitespace-pre">{line.content}</span>
    </div>
  );
}

function DiffUnifiedLine({ line }: { line: DiffLine }) {
  const bg = line.type === 'add'
    ? 'bg-green-50 dark:bg-green-950/20'
    : line.type === 'remove'
    ? 'bg-red-50 dark:bg-red-950/20'
    : '';

  const prefix = line.type === 'add' ? '+'
    : line.type === 'remove' ? '-'
    : ' ';

  const prefixColor = line.type === 'add'
    ? 'text-green-600 dark:text-green-400'
    : line.type === 'remove'
    ? 'text-red-600 dark:text-red-400'
    : 'text-gray-400';

  return (
    <div className={`flex items-center ${bg} hover:bg-opacity-80`}>
      <span className="w-8 text-right px-1 text-gray-400 select-none text-[10px]">
        {line.oldLine !== null ? line.oldLine + 1 : ''}
      </span>
      <span className="w-8 text-right px-1 text-gray-400 select-none text-[10px]">
        {line.newLine !== null ? line.newLine + 1 : ''}
      </span>
      <span className={`w-4 text-center select-none ${prefixColor}`}>{prefix}</span>
      <span className="flex-1 px-1 whitespace-pre">{line.content}</span>
    </div>
  );
}
