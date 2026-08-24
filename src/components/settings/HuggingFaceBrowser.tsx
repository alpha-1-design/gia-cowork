import React, { useState, useEffect, useCallback } from 'react';
import { Search, Download, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import { logger } from '../../utils/logger';
import LocalLLMService, { addCustomModel } from '../../services/LocalLLMService';
import { validateHfToken, searchHuggingFaceModels, type HfModel } from '../../services/modelHub';

const HF_TOKEN_KEY = 'gia:vision:hfToken';

export const HuggingFaceBrowser: React.FC = () => {
  const service = LocalLLMService;
  const [token, setToken] = useState(() => localStorage.getItem(HF_TOKEN_KEY) || '');
  const [tokenOk, setTokenOk] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HfModel[]>([]);
  const [searching, setSearching] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ percent: number; file?: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    return service.onProgress((id, p) => {
      if (id === downloading) setProgress({ percent: p.percent, file: p.file });
    });
  }, [service, downloading]);

  const saveToken = () => {
    localStorage.setItem(HF_TOKEN_KEY, token.trim());
    setStatus('Token saved.');
  };

  const checkToken = useCallback(async () => {
    if (!token.trim()) {
      setTokenOk(false);
      setStatus('Enter a token first.');
      return;
    }
    setStatus('Validating…');
    const ok = await validateHfToken(token.trim());
    setTokenOk(ok);
    setStatus(ok ? 'Token valid.' : 'Token rejected by HuggingFace.');
  }, [token]);

  const runSearch = useCallback(async () => {
    setSearching(true);
    setStatus(null);
    try {
      const list = await searchHuggingFaceModels(query.trim(), token.trim() || undefined, 40);
      setResults(list);
      if (!list.length) setStatus('No models found.');
    } catch (e) {
      setStatus(`Search failed: ${e instanceof Error ? e.message : 'network error'}`);
      logger.warn('[HF browser] search failed', e);
    } finally {
      setSearching(false);
    }
  }, [query, token]);

  const addAndDownload = useCallback(
    async (m: HfModel) => {
      addCustomModel({
        id: m.id,
        label: m.id.split('/').pop() || m.id,
        description: `HuggingFace model · ${m.downloads.toLocaleString()} downloads · ${m.likes} likes${m.pipeline_tag ? ` · ${m.pipeline_tag}` : ''}.`,
        parameters: 'hf',
      });
      setDownloading(m.id);
      setProgress(null);
      setStatus(`Downloading ${m.id}…`);
      try {
        await service.loadModel(m.id);
        setStatus(`Ready: ${m.id}. Set local-llm as your provider in Engine Room.`);
      } catch (e) {
        setStatus(`Download failed: ${e instanceof Error ? e.message : 'error'}`);
      } finally {
        setDownloading(null);
        setProgress(null);
      }
    },
    [service],
  );

  return (
    <div className="space-y-3">
      <div className="px-3 py-2 rounded-xl" style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}>
        <p className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--gia-text)' }}>
          HuggingFace token (optional — needed for gated models)
        </p>
        <div className="flex gap-2">
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="hf_…"
            className="flex-1 min-w-0 px-2 py-1.5 rounded text-[10px] outline-none"
            style={{ background: 'var(--gia-bg-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
          />
          <button
            onClick={saveToken}
            className="px-2.5 py-1.5 rounded text-[10px]"
            style={{ background: 'var(--gia-bg-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
          >
            Save
          </button>
          <button
            onClick={checkToken}
            className="px-2.5 py-1.5 rounded text-[10px]"
            style={{ background: 'var(--gia-bg-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
          >
            {tokenOk === null ? (
              'Check'
            ) : tokenOk ? (
              <span style={{ color: '#34d399' }}>
                <CheckCircle size={10} className="inline" /> OK
              </span>
            ) : (
              <span style={{ color: '#f87171' }}>
                <AlertTriangle size={10} className="inline" /> Bad
              </span>
            )}
          </button>
        </div>
      </div>

      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
          }}
          placeholder="Search HuggingFace models (e.g. Qwen, Llama, Mistral)"
          className="flex-1 min-w-0 px-2 py-1.5 rounded text-[10px] outline-none"
          style={{ background: 'var(--gia-bg-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
        />
        <button
          onClick={runSearch}
          disabled={searching}
          className="shrink-0 px-2.5 py-1.5 rounded text-[10px] font-medium flex items-center gap-1"
          style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.2)' }}
        >
          {searching ? <RefreshCw size={10} className="animate-spin" /> : <Search size={10} />} Search
        </button>
      </div>

      {status && (
        <p className="text-[9px]" style={{ color: 'var(--gia-muted)' }}>
          {status}
        </p>
      )}

      {downloading && progress && (
        <div>
          <div className="flex items-center justify-between text-[9px] mb-1" style={{ color: 'var(--gia-muted)' }}>
            <span className="truncate">{progress.file || 'Downloading…'}</span>
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

      <div className="space-y-2" style={{ maxHeight: 280, overflowY: 'auto' }}>
        {results.map((m) => (
          <div
            key={m.id}
            className="rounded-xl p-2.5"
            style={{ background: 'var(--gia-bg-2)', border: '1px solid var(--gia-border)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold truncate" style={{ color: 'var(--gia-text)' }}>
                  {m.id}
                </p>
                <p className="text-[9px]" style={{ color: 'var(--gia-muted-2)' }}>
                  {m.downloads.toLocaleString()} downloads · {m.likes} likes
                  {m.pipeline_tag ? ` · ${m.pipeline_tag}` : ''}
                </p>
              </div>
              <button
                onClick={() => addAndDownload(m)}
                disabled={downloading === m.id}
                className="shrink-0 px-2 py-1 rounded text-[9px] font-medium flex items-center gap-1"
                style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.2)' }}
              >
                {downloading === m.id ? <RefreshCw size={9} className="animate-spin" /> : <Download size={9} />} Get
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
