import React, { useEffect, useState } from 'react';
import { X, Check, ChevronRight, KeyRound, Settings2, Zap, Eye, Wrench, Cpu, RefreshCw, Film, AudioLines, Image as ImageIcon, Brain, Info } from 'lucide-react';
import { useProviderStore } from '../../store/useProviderStore';
import { providerRegistry } from '../../services/ProviderRegistry';
import { useShallow } from 'zustand/react/shallow';
import ProviderIcon from '../ProviderIcon';
import BottomSheet from '../ui/BottomSheet';
import { resolveCapabilities, capabilityBadges, type ModelCapabilities } from '../../services/ModelCapabilities';

interface ModelSwitcherSheetProps {
  open: boolean;
  onClose: () => void;
  onOpenEngine?: () => void;
}

const BADGE_ICON: Record<string, React.ReactNode> = {
  vision: <Eye size={8} />, video: <Film size={8} />, audio: <AudioLines size={8} />,
  imagegen: <ImageIcon size={8} />, tools: <Wrench size={8} />, reasoning: <Brain size={8} />,
};

/**
 * Capability badges.
 *
 * Three badges used to be all this showed, so a vision model and a reasoning
 * model looked identical in the list and picking between them was guesswork.
 * These are the abilities that actually change what GIA can do, so they are
 * what gets shown — including the ones people rarely think to look for
 * (audio input, video, image generation).
 */
const ModelBadges: React.FC<{ free?: boolean; caps: ModelCapabilities }> = ({ free, caps }) => {
  const badges = capabilityBadges(caps);
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {free && (
        <span className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[8px] font-semibold" style={{ background: 'rgba(52,211,153,0.12)', color: '#34d399' }}>
          <Zap size={8} /> FREE
        </span>
      )}
      {badges.map(b => (
        <span
          key={b.key}
          title={b.title}
          className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[8px] font-semibold"
          style={{ background: `${b.color}1f`, color: b.color }}
        >
          {BADGE_ICON[b.key]}
          {b.label}
        </span>
      ))}
      {caps.inferred && (
        <span
          title="The provider did not declare these — they were inferred from the model name."
          className="px-1 py-0.5 rounded text-[8px] font-semibold"
          style={{ background: 'rgba(148,163,184,0.12)', color: '#94a3b8' }}
        >
          INFERRED
        </span>
      )}
    </div>
  );
};

const ModelSwitcherSheet: React.FC<ModelSwitcherSheetProps> = ({ open, onClose, onOpenEngine }) => {
  const {
    providers, activeProvider, availableModels, modelListStatus,
    setActiveProvider, setProviderModel, setProviderImageModel, setProviderKey, fetchModels,
  } = useProviderStore(useShallow((s) => ({
    providers: s.providers,
    activeProvider: s.activeProvider,
    availableModels: s.availableModels,
    modelListStatus: s.modelListStatus,
    setActiveProvider: s.setActiveProvider,
    setProviderModel: s.setProviderModel,
    setProviderImageModel: s.setProviderImageModel,
    setProviderKey: s.setProviderKey,
    fetchModels: s.fetchModels,
  })));

  const [selected, setSelected] = useState(activeProvider);
  const [keyInput, setKeyInput] = useState('');
  const [imageModelInput, setImageModelInput] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  // Which model row has its capability detail open (at most one).
  const [detailFor, setDetailFor] = useState<string | null>(null);

  // Keep the selected provider in sync when the sheet (re)opens.
  useEffect(() => { if (open) setSelected(activeProvider); }, [open, activeProvider]);

  // Load the current image-model override whenever the selected provider changes.
  useEffect(() => {
    setImageModelInput(providers[selected]?.imageModel ?? providerRegistry.getImageModel(selected) ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, open]);

  const providerIds = providerRegistry.getAllIds();
  const selectedCfg = providers[selected];
  const selectedConnected = !!selectedCfg?.enabled && !!selectedCfg?.apiKey;
  const selectedNeedsKey = providerRegistry.getNeedsApiKey(selected);
  const currentModelId = selectedCfg?.model;

  // Pull LIVE models for the selected provider whenever the current list is
  // missing OR is just the curated fallback catalog — so opening the sheet with
  // a stale/catalog list auto-refreshes instead of being stuck on fallback.
  useEffect(() => {
    let cancelled = false;
    if (open && selectedConnected) {
      const have = availableModels[selected]?.length ?? 0;
      const isLive = modelListStatus[selected] === 'live';
      if (have === 0 || !isLive) {
        setLoadingModels(true);
        fetchModels(selected).catch(() => {}).finally(() => { if (!cancelled) setLoadingModels(false); });
      }
    }
    return () => { cancelled = true; };
  }, [open, selected, selectedConnected, availableModels, modelListStatus, fetchModels]);

  const models = selectedConnected
    ? (availableModels[selected] ?? []).length > 0
      ? (availableModels[selected] ?? [])
      : providerRegistry.getModels(selected)   // never show a blank pane — fall back to the curated catalog
    : providerRegistry.getModels(selected);

  const handleConnect = () => {
    const key = keyInput.trim();
    if (!key) return;
    setProviderKey(selected, key);
    setKeyInput('');
    setLoadingModels(true);
    fetchModels(selected).catch(() => {}).finally(() => setLoadingModels(false));
  };

  const handlePickModel = (modelId: string) => {
    setProviderModel(selected, modelId);
    if (selected !== activeProvider) setActiveProvider(selected);
    onClose();
  };

  const saveImageModel = () => {
    setProviderImageModel(selected, imageModelInput);
  };

  return (
    <BottomSheet open={open} onClose={onClose} maxHeight="78vh" zIndex={120}>
      {/* Grabber + header */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--gia-border)' }}>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: 'rgba(168,85,247,0.15)' }}>
                  <Cpu size={16} style={{ color: '#a855f7' }} />
                </div>
                <div>
                  <p className="text-sm font-semibold" style={{ color: 'var(--gia-text)' }}>Model & Provider</p>
                  <p className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>Switch without leaving the chat</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {onOpenEngine && (
                  <button
                    onClick={() => { onClose(); onOpenEngine(); }}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all"
                    style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-muted)' }}
                    title="View live agent thinking, tool calls, and results"
                  >
                    <Settings2 size={12} /> Activity
                  </button>
                )}
                <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center transition-colors" style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-muted)' }}>
                  <X size={15} />
                </button>
              </div>
            </div>

            <div className="flex flex-1 min-h-0">
              {/* Provider column */}
              <div className="w-[42%] sm:w-[38%] overflow-y-auto p-2 space-y-1 shrink-0" style={{ borderRight: '1px solid var(--gia-border)' }}>
                {providerIds.map((pid) => {
                  const cfg = providers[pid];
                  const connected = !!cfg?.enabled && !!cfg?.apiKey;
                  const isActive = pid === activeProvider;
                  const isSel = pid === selected;
                  return (
                    <button
                      key={pid}
                      onClick={() => setSelected(pid)}
                      className="w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl text-left transition-all tap-feedback"
                      style={{
                        background: isSel ? 'rgba(168,85,247,0.12)' : 'transparent',
                        border: isSel ? '1px solid rgba(168,85,247,0.3)' : '1px solid transparent',
                      }}
                    >
                      <span className="relative shrink-0">
                        <ProviderIcon provider={pid} size={24} />
                        <span
                          className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2"
                          style={{ background: connected ? '#34d399' : '#52525b', borderColor: 'var(--gia-surface)' }}
                        />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[12px] font-medium truncate" style={{ color: isSel ? 'var(--gia-text)' : 'var(--gia-muted)' }}>
                          {providerRegistry.getLabel(pid)}
                        </span>
                        <span className="block text-[9px]" style={{ color: 'var(--gia-muted-2)' }}>
                          {connected ? (isActive ? 'Active' : 'Connected') : 'Not connected'}
                        </span>
                      </span>
                      {isActive && <Check size={13} style={{ color: '#a855f7' }} />}
                    </button>
                  );
                })}
              </div>

              {/* Model column — list + its footer controls share one vertical
                  flex column so they stack, instead of competing for width
                  as siblings in the outer row. That competition was the bug:
                  the refresh bar and image-model input have unshrinkable
                  content, so the model list (the only child with min-w-0)
                  was getting squeezed to ~0 width and effectively vanishing
                  even though models had fetched successfully. */}
              <div className="flex-1 flex flex-col min-w-0 min-h-0">
                <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-0">
                  {!selectedConnected && selectedNeedsKey ? (
                  <div className="p-3 flex flex-col gap-3">
                    <p className="text-[11px] leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
                      Connect a <span className="font-semibold" style={{ color: 'var(--gia-text)' }}>{providerRegistry.getLabel(selected)}</span> API key to use its models.
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        value={keyInput}
                        onChange={(e) => setKeyInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleConnect(); }}
                        placeholder="Paste API key…"
                        className="gia-input flex-1"
                        style={{ fontSize: '12px' }}
                      />
                      <button
                        onClick={handleConnect}
                        disabled={!keyInput.trim()}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[11px] font-semibold disabled:opacity-40 transition-all"
                        style={{ background: 'rgba(168,85,247,0.18)', color: '#c4b5fd', border: '1px solid rgba(168,85,247,0.3)' }}
                      >
                        <KeyRound size={12} /> Connect
                      </button>
                    </div>
                    <p className="text-[9px]" style={{ color: 'var(--gia-muted-2)' }}>
                      Keys are stored locally on this device. Or open Engine for advanced options.
                    </p>
                  </div>
                ) : loadingModels ? (
                  <div className="flex items-center justify-center py-10">
                    <div className="w-5 h-5 rounded-full border-2 animate-spin" style={{ borderColor: 'var(--gia-border)', borderTopColor: '#a855f7' }} />
                  </div>
                ) : models.length === 0 ? (
                  <p className="text-[11px] text-center py-10" style={{ color: 'var(--gia-muted-2)' }}>No models available</p>
                ) : (
                  models.map((m) => {
                    const isCurrent = m.id === currentModelId && selected === activeProvider;
                    const caps = resolveCapabilities(m.id, {
                      // Provider-declared values win over inference.
                      vision: m.vision,
                      tools: m.tools,
                      context: m.context,
                    });
                    const expanded = detailFor === m.id;
                    return (
                      <div key={m.id}>
                        <div
                          className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-left transition-all tap-feedback"
                          style={{
                            background: isCurrent ? 'rgba(168,85,247,0.12)' : 'transparent',
                            border: isCurrent ? '1px solid rgba(168,85,247,0.3)' : '1px solid transparent',
                          }}
                        >
                          <button
                            onClick={() => handlePickModel(m.id)}
                            className="flex-1 min-w-0 text-left"
                          >
                            <span className="flex items-center gap-1.5">
                              <span className="text-[12px] font-medium truncate" style={{ color: 'var(--gia-text)' }}>{m.label}</span>
                              {caps.contextWindow && (
                                <span className="shrink-0 text-[9px]" style={{ color: 'var(--gia-muted-2)' }}>
                                  {(caps.contextWindow / 1000).toFixed(caps.contextWindow >= 100000 ? 0 : 0)}k ctx
                                </span>
                              )}
                            </span>
                            <span className="block mt-1"><ModelBadges free={m.free} caps={caps} /></span>
                          </button>
                          <button
                            onClick={() => setDetailFor(expanded ? null : m.id)}
                            title="What this model can do"
                            className="shrink-0 p-1.5 rounded-lg transition-colors hover:bg-white/5"
                            style={{ color: expanded ? '#a855f7' : 'var(--gia-muted-2)' }}
                          >
                            <Info size={14} />
                          </button>
                          {isCurrent
                            ? <Check size={15} style={{ color: '#a855f7' }} />
                            : <ChevronRight size={14} style={{ color: 'var(--gia-muted-2)' }} />}
                        </div>

                        {expanded && (
                          <div className="px-3 pb-3 -mt-1">
                            <div className="rounded-xl p-3 space-y-2" style={{ background: 'var(--gia-overlay)', border: '1px solid var(--gia-overlay-2)' }}>
                              <p className="text-[10px] font-semibold" style={{ color: 'var(--gia-muted)' }}>
                                GIA uses this model to
                              </p>
                              <ul className="space-y-1">
                                {capabilityBadges(caps).map(b => (
                                  <li key={b.key} className="flex items-center gap-2 text-[11px]">
                                    <span style={{ color: b.color }}>{BADGE_ICON[b.key]}</span>
                                    <span style={{ color: 'var(--gia-text)' }}>{b.title}</span>
                                  </li>
                                ))}
                                {capabilityBadges(caps).length === 0 && (
                                  <li className="text-[11px]" style={{ color: 'var(--gia-muted)' }}>
                                    Nothing beyond plain text is known for this model.
                                  </li>
                                )}
                              </ul>
                              <div className="pt-1.5 text-[10px] space-y-0.5" style={{ color: 'var(--gia-muted-2)', borderTop: '1px solid var(--gia-overlay-2)' }}>
                                <p>id: <code>{m.id}</code></p>
                                <p>context: {caps.contextWindow ? `${caps.contextWindow.toLocaleString()} tokens` : 'unknown'}</p>
                                {caps.inferred && (
                                  <p style={{ color: '#fbbf24' }}>
                                    Inferred from the model name — the provider did not declare these.
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Live model refresh — always available so you can re-fetch from the API anytime */}
              {selectedConnected && (
                <div className="p-3 shrink-0 flex items-center justify-between gap-2" style={{ borderTop: '1px solid var(--gia-border)' }}>
                  <div className="flex items-center gap-2 min-w-0">
                    {loadingModels ? (
                      <div className="w-4 h-4 rounded-full border-2 animate-spin shrink-0" style={{ borderColor: 'var(--gia-border)', borderTopColor: '#a855f7' }} />
                    ) : (
                      <span className="text-[9px] truncate" style={{ color: modelListStatus[selected] === 'live' ? '#34d399' : 'var(--gia-muted-2)' }}>
                        {modelListStatus[selected] === 'live'
                          ? '● Live model list from API'
                          : '○ Showing built-in catalog — refresh to fetch live models'}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => { setLoadingModels(true); fetchModels(selected).catch(() => {}).finally(() => setLoadingModels(false)); }}
                    disabled={loadingModels}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] font-semibold disabled:opacity-40 transition-all"
                    style={{ background: 'rgba(168,85,247,0.18)', color: '#c4b5fd', border: '1px solid rgba(168,85,247,0.3)' }}
                  >
                    <RefreshCw size={11} className={loadingModels ? 'animate-spin' : ''} /> Refresh
                  </button>
                </div>
              )}

              {/* Image model override — the image_generation tool is NOT stuck on dall-e-3. */}
              {selectedConnected && (
                <div className="p-3 shrink-0 flex flex-col gap-1.5" style={{ borderTop: '1px solid var(--gia-border)' }}>
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-semibold" style={{ color: 'var(--gia-muted)' }}>
                      Image model <span style={{ color: 'var(--gia-muted-2)' }}>(used by image_generation)</span>
                    </label>
                    <span className="text-[9px]" style={{ color: 'var(--gia-muted-2)' }}>
                      default: {providerRegistry.getImageModel(selected) || 'none'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={imageModelInput}
                      onChange={(e) => setImageModelInput(e.target.value)}
                      onBlur={saveImageModel}
                      onKeyDown={(e) => { if (e.key === 'Enter') { saveImageModel(); (e.target as HTMLInputElement).blur(); } }}
                      placeholder={providerRegistry.getImageModel(selected) ? 'Override…' : 'e.g. dall-e-3 · gpt-image-1 · flux'}
                      className="gia-input flex-1"
                      style={{ fontSize: '11px' }}
                    />
                  </div>
                </div>
              )}
            </div>
            </div>
    </BottomSheet>
  );
};

export default ModelSwitcherSheet;
