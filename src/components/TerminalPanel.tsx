import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Terminal as TerminalIcon, Loader2, Circle } from 'lucide-react';
import terminalService from '../services/TerminalService';
import { isTauri } from '../platform';

type LineKind = 'cmd' | 'out' | 'err' | 'info' | 'success';

interface Line {
  id: number;
  kind: LineKind;
  text: string;
}

let lid = 0;
const mk = (kind: LineKind, text: string): Line => ({ id: lid++, kind, text });

const WELCOME: Line[] = [
  mk('info', '╔══════════════════════════════════════════╗'),
  mk('info', '║       GIA COWORK · HOST SHELL v0.1.0      ║'),
  mk('info', '║  Real commands on this machine — not a    ║'),
  mk('info', '║  fake shell. Sessions, kill & timeouts    ║'),
  mk('info', '║  are handled by the desktop host (Tauri). ║'),
  mk('info', '╚══════════════════════════════════════════╝'),
  mk('out', ''),
  mk('out', 'Type a command and press Enter. ↑/↓ for history.'),
  mk('out', 'Note: commands run non-interactively with smart'),
  mk('out', 'timeouts — foreground servers (npm run dev, vite)'),
  mk('out', 'fast-fail so they never hang this panel.'),
  mk('out', ''),
];

const QUICK = [
  { label: 'pwd', cmd: 'pwd' },
  { label: 'ls -la', cmd: 'ls -la' },
  { label: 'uname -a', cmd: 'uname -a' },
  { label: 'whoami', cmd: 'whoami' },
];

const UNAVAILABLE_LINES: Line[] = [
  mk('err', 'Host shell unavailable in this preview.'),
  mk('err', 'The real terminal only runs inside the GIA Cowork desktop app'),
  mk('err', '(Tauri host shell). In the browser preview you can still:'),
  mk('out', '  • Open Engine Room  — manage providers, models & network'),
  mk('out', '  • Use GIA in Build mode — it scaffolds and runs apps for you'),
];

interface TerminalPanelProps {
  onClose: () => void;
}

const TerminalPanel: React.FC<TerminalPanelProps> = ({ onClose }) => {
  const available = isTauri() && terminalService.isAvailable();
  const [lines, setLines] = useState<Line[]>(available ? WELCOME : UNAVAILABLE_LINES);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [lines, busy]);

  const push = useCallback((...newLines: Line[]) => setLines(ls => [...ls, ...newLines]), []);

  const run = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || busy) return;
    setInput('');
    setHistIdx(-1);
    setHistory(h => [trimmed, ...h].slice(0, 50));
    push(mk('cmd', `$ ${trimmed}`));
    setBusy(true);
    const started = performance.now();
    try {
      const result = await terminalService.exec(trimmed);
      const elapsed = Math.round(performance.now() - started);
      const out = (result.output ?? '').replace(/\n$/, '');
      if (out) push(...out.split('\n').map(l => mk('out', l)));
      push(mk(result.exitCode === 0 ? 'success' : 'err', `[exit ${result.exitCode} · ${elapsed}ms]`));
    } catch (e) {
      const elapsed = Math.round(performance.now() - started);
      const msg = e instanceof Error ? e.message : String(e);
      push(mk('err', `[failed · ${elapsed}ms] ${msg}`));
    } finally {
      setBusy(false);
    }
  }, [busy, push]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void run(input); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); const i = Math.min(histIdx + 1, history.length - 1); setHistIdx(i); setInput(history[i] ?? ''); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); const i = Math.max(histIdx - 1, -1); setHistIdx(i); setInput(i === -1 ? '' : history[i] ?? ''); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  const colorFor = (kind: LineKind) =>
    kind === 'cmd' ? 'text-emerald-400'
      : kind === 'err' ? 'text-rose-400'
      : kind === 'info' ? 'text-indigo-300'
      : kind === 'success' ? 'text-emerald-300'
      : 'text-zinc-300';

  return (
    <div className="fixed inset-0 z-[160] bg-zinc-950 flex flex-col font-mono text-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-zinc-900 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-3">
          <TerminalIcon size={14} className="text-emerald-400" />
          <span className="text-xs font-medium text-zinc-300 tracking-widest uppercase">Terminal — Host Shell</span>
          <span
            className="flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-full"
            style={{
              background: available ? 'rgba(52,211,153,0.1)' : 'rgba(251,146,60,0.1)',
              color: available ? '#34d399' : '#fb923c',
              border: `1px solid ${available ? 'rgba(52,211,153,0.25)' : 'rgba(251,146,60,0.25)'}`,
            }}
          >
            <Circle size={6} fill="currentColor" />
            {available ? 'Host shell connected' : 'Unavailable in preview'}
          </span>
        </div>
        <button onClick={onClose} className="flex items-center gap-2 text-zinc-400 hover:text-zinc-100 transition-colors">
          <X size={15} />
        </button>
      </div>

      {/* Output */}
      <div ref={scrollRef} onClick={() => inputRef.current?.focus()} className="flex-1 overflow-y-auto p-5 space-y-1 cursor-text">
        {lines.map(line => (
          <div key={line.id} className={`whitespace-pre-wrap leading-relaxed break-all ${colorFor(line.kind)}`}>{line.text}</div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-amber-400 animate-pulse">
            <Loader2 size={12} className="animate-spin" /> running…
          </div>
        )}
      </div>

      {/* Quick commands */}
      {available && (
        <div className="flex items-center gap-1.5 px-5 pb-2 shrink-0">
          {QUICK.map(q => (
            <button
              key={q.label}
              onClick={() => { setInput(q.cmd); inputRef.current?.focus(); }}
              className="text-[10px] px-2 py-1 rounded-lg transition-colors"
              style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--gia-muted)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              {q.label}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <form
        onSubmit={(e) => { e.preventDefault(); void run(input); }}
        className="flex items-center gap-3 px-5 py-4 bg-zinc-900 border-t border-zinc-800 shrink-0"
      >
        <span className="text-emerald-400 shrink-0 select-none">$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy || !available}
          placeholder={available ? 'Type a command…' : 'Host shell requires the desktop app'}
          className="flex-1 bg-transparent border-none outline-none text-zinc-100 caret-emerald-400 min-w-0 placeholder-zinc-600 disabled:opacity-50"
          autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
        />
        <button
          type="submit"
          disabled={busy || !input.trim() || !available}
          className="text-emerald-500 hover:text-emerald-400 disabled:text-zinc-700 transition-colors"
        >
          ↵
        </button>
      </form>
    </div>
  );
};

export default TerminalPanel;