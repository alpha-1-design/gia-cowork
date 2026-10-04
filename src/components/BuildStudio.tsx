import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Sparkles, ChevronRight, Check, Loader2, Brain, Palette, Wand2, X, Users,
} from 'lucide-react';
import { useGiaStore } from '../store/useGiaStore';
import { useProviderStore } from '../store/useProviderStore';
import { DESKTOP_THEMES, DEFAULT_THEME, type ThemeId } from '../config/themes';
import { buildBlockedReason } from '../services/build/builderPrompt';
import { BUILD_STYLES, DEFAULT_BUILD_STYLE_ID, getBuildStyle } from '../services/build/giaThemes';
import { PEER_AGENTS, type DetectionResult } from '../services/agents/peerAgents';
import { warmPeerAgentDetection } from '../services/buildGiaSystem';

/**
 * Build studio — the front door to BUILD mode.
 *
 * The request to describe what you want and hit send is the old way, and it
 * fails in a specific way: the model is chosen for you, the skill is never
 * loaded, and the look is decided by whatever the framework defaults to. All
 * three are decisions the user is better at than a default.
 *
 * So this front-loads them, in the order they actually constrain the work:
 * what you want, then which model builds it, then how it should look. Only then
 * do you start.
 *
 * The skill gate is the part that is easy to get wrong. It is not an advisory
 * hint — the send button stays disabled until a real skill is loaded, because
 * a build without one is the specific failure this whole screen exists to
 * prevent.
 */

interface Props {
  onClose: () => void;
  /** Send the finished brief into the chat. */
  onStart: (brief: string) => void;
}

/** Skills that are not the catch-all default. */
function realSkills(skills: { id: string; name: string; description: string; systemPrompt: string; tools: string[]; category: 'core' | 'user' | 'dev' | 'creative'; icon?: string }[]) {
  return skills.filter(s => s.id !== 'core-general' && s.name.trim().toLowerCase() !== 'general');
}

export function BuildStudio({ onClose, onStart }: Props) {
  const skills = useGiaStore(s => s.skills);
  const activeSkillId = useGiaStore(s => s.activeSkillId);
  const setSkill = useGiaStore(s => s.setSkill);
  const theme = useGiaStore(s => s.theme);
  const setTheme = useGiaStore(s => s.setTheme);
  const buildStyleId = useGiaStore(s => s.buildStyleId);
  const setBuildStyle = useGiaStore(s => s.setBuildStyle);

  const providers = useProviderStore(s => s.providers);
  const activeProvider = useProviderStore(s => s.activeProvider);
  const availableModels = useProviderStore(s => s.availableModels);
  const setProviderModel = useProviderStore(s => s.setProviderModel);

  const [brief, setBrief] = useState('');
  const [providerId, setProviderId] = useState(activeProvider);
  const [modelId, setModelId] = useState(providers[activeProvider]?.model ?? '');
  const [peers, setPeers] = useState<DetectionResult[] | null>(null);

  // Warm peer detection so the panel can say what is on this machine without
  // blocking the rest of the UI on six subprocesses.
  //
  // This has to go through `warmPeerAgentDetection`, not `detectPeerAgents`.
  // The panel listing agents is not the same thing as the model knowing them:
  // the prompt builder reads a short-lived cache that only the warm function
  // populates. Calling the raw detector here populated the panel while leaving
  // the cache cold, so opening Build Studio — the one moment the user is most
  // likely to delegate — was exactly when the prompt still said nothing.
  useEffect(() => {
    let cancelled = false;
    warmPeerAgentDetection()
      .then(r => { if (!cancelled) setPeers(r); })
      .catch(() => { if (!cancelled) setPeers([]); });
    return () => { cancelled = true; };
  }, []);

  const connectedProviders = useMemo(
    () => Object.entries(providers).filter(([, c]) => c.enabled && c.apiKey),
    [providers],
  );
  const models = availableModels[providerId] ?? [];

  // Keep the model valid whenever the provider changes, otherwise the build
  // silently runs on a model the new provider does not have.
  useEffect(() => {
    const current = providers[providerId]?.model;
    const exists = models.some(m => m.id === modelId);
    if (!exists) setModelId(current ?? models[0]?.id ?? '');
  }, [providerId, models, modelId, providers]);

  const candidates = realSkills(skills);
  const activeSkill = skills.find(s => s.id === activeSkillId) ?? null;
  const blocked = buildBlockedReason(activeSkill);

  const briefOk = brief.trim().length >= 12;
  const canStart = briefOk && !blocked;

  const onStartBuild = useCallback(() => {
    if (!canStart) return;
    const providerLabel = providers[providerId]?.enabled ? `${providerId} / ${modelId}` : 'the default model';
    const skill = activeSkill;
    const message = [
      brief.trim(),
      '',
      '---',
      `Build with: ${providerLabel}`,
      `Visual style: ${getBuildStyle(buildStyleId).name}`,
      `Theme: ${DESKTOP_THEMES.find(t => t.id === theme)?.label ?? theme}`,
      skill ? `Skill: ${skill.name}` : '',
    ].filter(Boolean).join('\n');
    onStart(message);
    onClose();
  }, [brief, canStart, providerId, providers, modelId, theme, buildStyleId, activeSkill, onStart, onClose]);

  const installedPeers = (peers ?? []).filter(p => p.installed);

  return (
    <motion.div
      className="fixed inset-0 z-[160] flex items-center justify-center p-4"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ background: 'rgba(0,0,0,0.62)' }}
      onClick={onClose}
      data-testid="build-studio"
    >
      <motion.div
        className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-2xl"
        initial={{ y: 20, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 20, scale: 0.98 }}
        style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 sticky top-0 z-10" style={{ background: 'var(--gia-surface)', borderBottom: '1px solid var(--gia-border)' }}>
          <Sparkles size={16} style={{ color: 'var(--gia-accent)' }} />
          <div className="flex-1">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--gia-text)' }}>Build something</h2>
            <p className="text-[11px]" style={{ color: 'var(--gia-muted)' }}>
              Say what you want, choose the model and the look, load a skill.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close build studio" className="p-1.5 rounded-lg" style={{ color: 'var(--gia-muted)' }}>
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-5">
          {/* 1 — What you want */}
          <section>
            <Step n={1} title="Describe what you want" />
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              data-testid="build-brief"
              rows={4}
              placeholder="A task tracker with a kanban board, drag-and-drop between columns, and due dates that highlight when overdue…"
              className="w-full rounded-xl p-3 text-[13px] resize-y outline-none"
              style={{
                background: 'var(--gia-surface-2)',
                border: '1px solid var(--gia-border)',
                color: 'var(--gia-text)',
              }}
            />
            <p className="text-[10px] mt-1" style={{ color: 'var(--gia-muted-2)' }}>
              {briefOk
                ? 'Good — that is specific enough to build from.'
                : 'Add a little more detail — a sentence about what it should do.'}
            </p>
          </section>

          {/* 2 — Model */}
          <section>
            <Step n={2} title="Choose the model" icon={<Brain size={12} />} />
            {connectedProviders.length === 0 ? (
              <p className="text-[11px]" style={{ color: 'var(--gia-muted)' }}>
                No provider is connected yet — GIA will use whatever the app is already configured with. Connect one in Settings → Connections.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <select
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                  data-testid="build-provider"
                  className="rounded-lg px-2.5 py-2 text-[12px] outline-none"
                  style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
                >
                  {connectedProviders.map(([id]) => <option key={id} value={id}>{id}</option>)}
                </select>
                <select
                  value={modelId}
                  onChange={(e) => { setModelId(e.target.value); setProviderModel(providerId, e.target.value); }}
                  data-testid="build-model"
                  className="rounded-lg px-2.5 py-2 text-[12px] outline-none"
                  style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
                >
                  {(models.length ? models : [{ id: providers[providerId]?.model ?? '', label: providers[providerId]?.model || 'default', free: false } as never])
                    .map((m: { id: string; label: string }) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>
            )}
          </section>

          {/* 3 — Look */}
          <section>
            <Step n={3} title="Choose the look" icon={<Palette size={12} />} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {DESKTOP_THEMES.map(t => {
                const active = (theme ?? DEFAULT_THEME) === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id as ThemeId)}
                    data-testid={`build-theme-${t.id}`}
                    title={t.description}
                    className="rounded-xl overflow-hidden text-left transition-all"
                    style={{
                      border: active ? `2px solid ${t.preview.accent}` : '1px solid var(--gia-border)',
                    }}
                  >
                    {/* A real miniature of the theme, not a coloured square. */}
                    <div className="h-16 p-2 flex flex-col gap-1" style={{ background: t.preview.bg }}>
                      <div className="h-2.5 rounded" style={{ background: t.preview.surface }} />
                      <div className="h-1.5 w-3/4 rounded" style={{ background: `${t.preview.accent}66` }} />
                      <div className="h-1.5 w-1/2 rounded" style={{ background: `${t.preview.accent}33` }} />
                    </div>
                    <div className="px-2 py-1.5 flex items-center gap-1" style={{ background: 'var(--gia-surface-2)' }}>
                      <span className="text-[10px] truncate flex-1" style={{ color: active ? t.preview.accent : 'var(--gia-muted)' }}>
                        {t.label}
                      </span>
                      {active && <Check size={10} style={{ color: t.preview.accent }} />}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 4 — Visual style for what gets built */}
          <section>
            <Step n={4} title="Choose the look of what you're building" icon={<Palette size={12} />} />
            <p className="text-[11px] mb-2" style={{ color: 'var(--gia-muted)' }}>
              Seven styles, loaded instantly — no install, no fetch. This is the app or site's look, separate from GIA's own theme above.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {BUILD_STYLES.map(s => {
                const active = (buildStyleId || DEFAULT_BUILD_STYLE_ID) === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => setBuildStyle(s.id)}
                    data-testid={`build-style-${s.id}`}
                    title={s.direction}
                    className="rounded-xl overflow-hidden text-left transition-all"
                    style={{ border: active ? `2px solid ${s.swatch.accent}` : '1px solid var(--gia-border)' }}
                  >
                    <div className="h-14 p-2 flex flex-col gap-1" style={{ background: s.swatch.bg }}>
                      <div className="h-2 rounded" style={{ background: s.swatch.surface }} />
                      <div className="h-1.5 w-3/4 rounded" style={{ background: `${s.swatch.accent}66` }} />
                      <div className="mt-auto h-2 w-1/2 rounded" style={{ background: s.gradient }} />
                    </div>
                    <div className="px-2 py-1.5 flex items-center gap-1" style={{ background: 'var(--gia-surface-2)' }}>
                      <span className="text-[10px] truncate flex-1" style={{ color: active ? s.swatch.accent : 'var(--gia-muted)' }}>
                        {s.name}
                      </span>
                      {active && <Check size={10} style={{ color: s.swatch.accent }} />}
                    </div>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] mt-1.5" style={{ color: 'var(--gia-muted-2)' }}>
              {getBuildStyle(buildStyleId).blurb}
            </p>
          </section>

          {/* 5 — Skill (required) */}
          <section>
            <Step n={5} title="Load a skill" icon={<Wand2 size={12} />} required />
            <p className="text-[11px] mb-2" style={{ color: 'var(--gia-muted)' }}>
              {blocked
                ? 'A build does not start without one. This is the difference between output that looks finished and output that is.'
                : <><strong style={{ color: 'var(--gia-text)' }}>{activeSkill?.name}</strong> is loaded and will govern this build.</>}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {candidates.length === 0 && (
                <span className="text-[11px]" style={{ color: 'var(--gia-muted-2)' }}>
                  No specialised skills installed yet — create one in Settings → Skills.
                </span>
              )}
              {candidates.map(s => {
                const active = s.id === activeSkillId;
                return (
                  <button
                    key={s.id}
                    onClick={() => setSkill(s.id)}
                    data-testid={`build-skill-${s.id}`}
                    title={s.description}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] transition-all"
                    style={{
                      background: active ? 'var(--gia-accent-dim)' : 'var(--gia-surface-2)',
                      color: active ? 'var(--gia-accent)' : 'var(--gia-muted)',
                      border: `1px solid ${active ? 'var(--gia-accent-glow)' : 'var(--gia-border)'}`,
                    }}
                  >
                    {s.icon && <span aria-hidden>{s.icon}</span>}
                    {s.name}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Peer agents — informational, never blocking */}
          {installedPeers.length > 0 && (
            <section>
              <Step n={6} title="Agents on this machine" icon={<Users size={12} />} />
              <p className="text-[11px] mb-2" style={{ color: 'var(--gia-muted)' }}>
                GIA can hand scoped work to these instead of redoing it.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {installedPeers.map(p => (
                  <span
                    key={p.agent.id}
                    data-testid={`build-peer-${p.agent.id}`}
                    title={p.agent.strength}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px]"
                    style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-muted)' }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#22c55e' }} />
                    {p.agent.name}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center gap-2 px-5 py-3.5 sticky bottom-0"
          style={{ background: 'var(--gia-surface)', borderTop: '1px solid var(--gia-border)' }}
        >
          <div className="flex-1 text-[10px]" style={{ color: 'var(--gia-muted-2)' }}>
            {!briefOk ? 'Describe what you want first.' : blocked ? 'Load a skill to continue.' : 'Ready.'}
          </div>
          <button
            onClick={onStartBuild}
            disabled={!canStart}
            data-testid="build-start"
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-semibold transition-all disabled:opacity-35"
            style={{ background: 'var(--gia-accent)', color: '#0b0b10' }}
          >
            <ChevronRight size={13} /> Start building
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** Numbered step header, so the order is visible rather than implied. */
const Step: React.FC<{ n: number; title: string; icon?: React.ReactNode; required?: boolean }> = ({ n, title, icon, required }) => (
  <div className="flex items-center gap-2 mb-2">
    <span
      className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
      style={{ background: 'var(--gia-accent-dim)', color: 'var(--gia-accent)' }}
    >
      {n}
    </span>
    <span className="text-[12px] font-semibold" style={{ color: 'var(--gia-text)' }}>{title}</span>
    {icon}
    {required && (
      <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
        required
      </span>
    )}
  </div>
);

export default BuildStudio;