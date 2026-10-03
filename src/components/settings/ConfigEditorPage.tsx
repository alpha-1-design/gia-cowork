import React, { useState } from 'react';
import { ChevronRight, Braces, Copy, Download, Upload, Check, AlertTriangle, RotateCcw } from 'lucide-react';
import { exportConfigString, validateConfig, applyConfig, type GiaConfig } from '../../services/ConfigEditor';

const ConfigEditorPage: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [text, setText] = useState(() => exportConfigString());
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [status, setStatus] = useState('');

  const handleApply = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setErrors([`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`]);
      setWarnings([]);
      setStatus('');
      return;
    }
    const result = validateConfig(parsed);
    setErrors(result.errors);
    setWarnings(result.warnings);
    if (!result.ok) {
      setStatus('');
      return;
    }
    try {
      applyConfig(parsed as GiaConfig);
      setStatus('Applied. Changes take effect immediately.');
      // Re-export so the editor shows the canonical result, including any
      // redacted keys that were intentionally left alone.
      setText(exportConfigString());
    } catch (e) {
      setErrors([`Could not apply: ${e instanceof Error ? e.message : String(e)}`]);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Copied to clipboard.');
    } catch {
      setStatus('Clipboard unavailable — select the text and copy manually.');
    }
  };

  const handleDownload = () => {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gia-config.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setText(await file.text());
      setErrors([]);
      setWarnings([]);
      setStatus('Loaded file — review, then Apply.');
    };
    input.click();
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: 'var(--gia-bg)', padding: '20px 16px', gap: '14px' }}>
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="p-1 rounded-lg hover:bg-white/5 transition-colors" style={{ color: 'var(--gia-muted)' }}>
          <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <Braces size={16} style={{ color: '#a855f7' }} />
        <div>
          <span className="text-sm font-semibold" style={{ color: 'var(--gia-text)' }}>Configuration</span>
          <p className="text-[10px]" style={{ color: 'var(--gia-muted-2)' }}>Edit GIA's settings as JSON</p>
        </div>
      </div>

      <div className="gia-card p-3" style={{ borderColor: 'rgba(168,85,247,0.2)' }}>
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
          Every setting in one editable document. Changes apply live.
          API keys are shown as <code style={{ color: '#a855f7' }}>***redacted***</code> — leave them as-is to
          keep your existing keys; they are never overwritten by a re-import.
        </p>
      </div>

      <textarea
        value={text}
        onChange={e => { setText(e.target.value); setStatus(''); }}
        spellCheck={false}
        className="w-full font-mono text-[11px] leading-relaxed p-3 rounded-xl resize-none"
        style={{
          background: 'var(--gia-surface-2)',
          border: `1px solid ${errors.length ? '#ef4444' : 'var(--gia-border)'}`,
          color: 'var(--gia-text)',
          minHeight: '420px',
          outline: 'none',
        }}
      />

      {errors.length > 0 && (
        <div className="gia-card p-3" style={{ borderColor: 'rgba(239,68,68,0.3)' }}>
          {errors.map((e, i) => (
            <p key={i} className="text-[11px] flex items-start gap-1.5" style={{ color: '#f87171' }}>
              <AlertTriangle size={11} className="shrink-0 mt-0.5" />{e}
            </p>
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="gia-card p-3" style={{ borderColor: 'rgba(245,158,11,0.3)' }}>
          {warnings.map((w, i) => (
            <p key={i} className="text-[11px]" style={{ color: '#f59e0b' }}>{w}</p>
          ))}
        </div>
      )}

      {status && (
        <p className="text-[11px] flex items-center gap-1.5" style={{ color: '#34d399' }}>
          <Check size={11} />{status}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={handleApply} className="gia-btn gia-btn-primary">
          <Upload size={12} /> Apply
        </button>
        <button onClick={handleCopy} className="gia-btn">
          <Copy size={12} /> Copy
        </button>
        <button onClick={handleDownload} className="gia-btn">
          <Download size={12} /> Export
        </button>
        <button onClick={handleImport} className="gia-btn">
          <Upload size={12} /> Import
        </button>
        <button onClick={() => { setText(exportConfigString()); setErrors([]); setWarnings([]); setStatus(''); }} className="gia-btn">
          <RotateCcw size={12} /> Reset
        </button>
      </div>

      <p className="text-[9px] text-center pb-4 leading-relaxed" style={{ color: 'var(--gia-muted-2)' }}>
        Credentials live in the OS keychain and are never exported.
      </p>
    </div>
  );
};

export default ConfigEditorPage;