import React, { useState, useEffect, useCallback } from 'react';
import { Search, Download, RefreshCw, CheckCircle } from 'lucide-react';
import { logger } from '../../utils/logger';
import {
  listOllamaModels,
  searchOllamaLibrary,
  pullOllamaModel,
  type PullProgress,
} from '../../services/modelHub';

export const OllamaBrowser: React.FC = () => {
  const [base, setBase] = useState('http://localhost:11434');
  const [installed, setInstalled] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [library, setLibrary] = useState<string[]>([]);
  const [pulling, setPulling] = useState<string | null>(null);
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const [status, setStatus] = useState<string | null>('Ollama must be running locally for this to work.');

  const loadInstalled = useCallback(async () => {
    setStatus('Reading local Ollama…');
    try {
      const list = await listOllamaModels(base);
      setInstalled(list.map((m) => m.name));
      setStatus(list.length ? `${list.length} model(s) installed.` : 'No models installed yet.');
    } catch (e) {
      setStatus(`Cannot reach Ollama at ${base}. Is it running? (${e instanceof Error ? e.message : 'error'})`);
    }
  }, [base]);

  const runSearch = useCallback(async () => {
    if (!query.trim()) return;
    setStatus('Searching Ollama library…');
    try {
      const list = await searchOllamaLibrary(query.trim());
      setLibrary(list);
      setStatus(list.length ? `${list.length} match(es).` : 'No matches.');
    } catch (e) {
      setStatus(`Library search failed: ${e instanceof Error ? e.message : 'error'}`);
    }
  }, [query]);

  const pull = useCallback(
    async (name: string) => {
      setPulling(name);
      setProgress(null);
      setStatus(`Pulling ${name}…`);
      try {
        await pullOllamaModel(name, (p) => setProgress(p), base);
        setStatus(`Pulled ${name}. Use the Ollama provider in Engine Room to chat with it.`);
        await loadInstalled();
      } catch (e) {
        setStatus(`Pull failed: ${e instanceof Error ? e.message : 'error'}`);
      } finally {
        setPulling(null);
        setProgress(null);
      }
    },
    [base, loadInstalled],
  );

  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);

  const renderList = (items: string[], pullingActive: boolean) => (
    <div className="space-y-2" style={{ maxHeight: 240, overflowY: 'auto' }}>
      {items.map((name) => (
        <div
          key={name}
          className="rounded-xl p-2.5 flex items-center justify-between gap-2"
          style={{ background: 'var(--gia-bg-2)', border: '1px solid var(--gia-border)' }}
        >
          <p className="text-[11px] font-semibold truncate" style={{ color: 'var(--gia-text)' }}>
            {name}
          </p>
          <button
            onClick={() => pull(name)}
            disabled={pullingActive}
            className="shrink-0 px-2 py-1 rounded text-[9px] font-medium flex items-center gap-1"
            style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.2)' }}
          >
            {pulling === name ? <RefreshCw size={9} className="animate-spin" /> : <Download size={9} />} Pull
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="px-3 py-2 rounded-xl" style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}>
        <p className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--gia-text)' }}>
          Ollama endpoint
        </p>
        <input
          value={base}
          onChange={(e) => setBase(e.target.value)}
          className="w-full px-2 py-1.5 rounded text-[10px] outline-none"
          style={{ background: 'var(--gia-bg-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
        />
      </div>

      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
          }}
          placeholder="Search Ollama library (e.g. llama3.1, qwen2.5)"
          className="flex-1 min-w-0 px-2 py-1.5 rounded text-[10px] outline-none"
          style={{ background: 'var(--gia-bg-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
        />
        <button
          onClick={runSearch}
          className="shrink-0 px-2.5 py-1.5 rounded text-[10px] font-medium flex items-center gap-1"
          style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.2)' }}
        >
          <Search size={10} /> Search
        </button>
      </div>

      {status && (
        <p className="text-[9px]" style={{ color: 'var(--gia-muted)' }}>
          {status}
        </p>
      )}

      {pulling && progress && (
        <div>
          <div className="flex items-center justify-between text-[9px] mb-1" style={{ color: 'var(--gia-muted)' }}>
            <span className="truncate">{progress.status || 'Pulling…'}</span>
            <span>{progress.percent}%</span>
          </div>
          <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <div
              className="h-full rounded-full"
              style={{ width: `${progress.percent}%`, background: 'linear-gradient(90deg, #22c55e, #34d399)' }}
            />
          </div>
        </div>
      )}

      {installed.length > 0 && (
        <div>
          <p className="text-[9px] font-semibold mb-1.5" style={{ color: 'var(--gia-muted)' }}>
            <CheckCircle size={9} className="inline mr-1" style={{ color: '#34d399' }} />
            Installed on this machine
          </p>
          {renderList(installed, pulling !== null)}
        </div>
      )}

      {library.length > 0 && (
        <div>
          <p className="text-[9px] font-semibold mb-1.5" style={{ color: 'var(--gia-muted)' }}>
            Library results
          </p>
          {renderList(library, pulling !== null)}
        </div>
      )}
    </div>
  );
};
