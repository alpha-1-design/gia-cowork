import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Send, Loader2, X, Trash2, ChevronDown, Cpu, Zap,
  Clock, CheckCircle2, AlertCircle, Ban, Sparkles, RefreshCw,
} from 'lucide-react';
import { useAgentTaskStore, type AgentDispatchTask } from '../store/useAgentTaskStore';
import { useProviderStore } from '../store/useProviderStore';
import { useAgentStore, type CustomAgent } from '../store/useAgentStore';
import { AGENT_ROLES } from '../services/brain/SubAgentManager';
import GiaBrain from '../services/GiaBrain';
import { useGiaStore } from '../store/useGiaStore';
import { genId } from '../utils/id';
import MarkdownRenderer from './MarkdownRenderer';
import OrbAvatar from './OrbAvatar';
import { resolveAgentIcon } from '../utils/agentIcons';

// ── Provider selector for an agent ────────────────────────────────────────
function ProviderSelect({
  agentName,
  value,
  onChange,
  compact = false,
}: {
  agentName: string;
  value: string;
  onChange: (providerId: string) => void;
  compact?: boolean;
}) {
  const { providers, getActiveProviders } = useProviderStore();
  const activeProviders = getActiveProviders();

  // All providers (enabled + disabled, for reference)
  const allProviderIds = Object.keys(providers);

  // If only one provider is configured (or none), show a simple badge
  if (activeProviders.length <= 1) {
    const label = activeProviders.length === 1
      ? `All → ${activeProviders[0].id}`
      : 'No providers configured';
    return (
      <span
        className="inline-flex items-center gap-1 text-[8px] px-1.5 py-0.5 rounded-full font-medium"
        style={{
          background: activeProviders.length === 1 ? 'rgba(52,211,153,0.1)' : 'rgba(239,68,68,0.1)',
          color: activeProviders.length === 1 ? '#34d399' : '#f87171',
          border: `1px solid ${activeProviders.length === 1 ? 'rgba(52,211,153,0.2)' : 'rgba(239,68,68,0.2)'}`,
        }}
      >
        <Cpu size={7} />
        {label}
      </span>
    );
  }

  // Multiple providers — show dropdown
  const selectClass = compact
    ? 'text-[8px] px-1 py-0.5 rounded font-medium bg-transparent outline-none cursor-pointer max-w-[80px]'
    : 'text-[9px] px-1.5 py-0.5 rounded-md font-medium bg-transparent outline-none cursor-pointer';

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={selectClass}
      style={{
        color: 'var(--gia-muted)',
        border: '1px solid var(--gia-border)',
        background: 'var(--gia-surface)',
      }}
      title={`Assign provider for ${agentName}`}
    >
      <option value="">auto (best)</option>
      {activeProviders.map((p) => (
        <option key={p.id} value={p.id}>
          {p.id}{p.config.model ? ` · ${p.config.model.split('/').pop()?.slice(0, 15) || ''}` : ''}
        </option>
      ))}
    </select>
  );
}

// ── Single task card ──────────────────────────────────────────────────────
function TaskCard({ task }: { task: AgentDispatchTask }) {
  const { cancel, remove } = useAgentTaskStore();
  const [expanded, setExpanded] = useState(false);
  const isRunning = task.status === 'running' || task.status === 'spawning';
  const isTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';

  const statusIcon = {
    queued: <Clock size={10} className="text-zinc-500" />,
    spawning: <Loader2 size={10} className="text-amber-400 animate-spin" />,
    running: <Loader2 size={10} className="text-blue-400 animate-spin" />,
    completed: <CheckCircle2 size={10} className="text-emerald-400" />,
    failed: <AlertCircle size={10} className="text-red-400" />,
    cancelled: <Ban size={10} className="text-zinc-500" />,
  }[task.status];

  const duration = task.startedAt
    ? ((task.completedAt || Date.now()) - task.startedAt) / 1000
    : 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="rounded-xl border overflow-hidden"
      style={{
        background: 'var(--gia-surface)',
        borderColor: isRunning ? `${task.agentColor}30` : 'var(--gia-border)',
        boxShadow: isRunning ? `0 0 20px ${task.agentColor}08` : 'none',
      }}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${task.agentColor}12` }}
        >
          {statusIcon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-bold" style={{ color: task.agentColor }}>
              {task.agentName}
            </span>
            <span className="text-[8px] px-1 py-0.5 rounded" style={{ background: `${task.agentColor}12`, color: 'var(--gia-muted-2)' }}>
              {task.agentRole}
            </span>
          </div>
          <p className="text-[10px] truncate mt-0.5" style={{ color: 'var(--gia-muted)' }}>
            {task.prompt.slice(0, 80)}{task.prompt.length > 80 ? '…' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {task.providerId && (
            <span className="text-[7px] font-mono px-1 py-0.5 rounded" style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-muted-2)' }}>
              {task.providerId}
            </span>
          )}
          {duration > 0 && (
            <span className="text-[9px] font-mono" style={{ color: 'var(--gia-muted-2)' }}>
              {duration.toFixed(1)}s
            </span>
          )}
          {isRunning && (
            <button
              onClick={(e) => { e.stopPropagation(); cancel(task.id); }}
              className="w-5 h-5 rounded flex items-center justify-center hover:bg-red-500/10"
              style={{ color: '#f87171' }}
            >
              <X size={10} />
            </button>
          )}
          {isTerminal && (
            <button
              onClick={(e) => { e.stopPropagation(); remove(task.id); }}
              className="w-5 h-5 rounded flex items-center justify-center hover:bg-zinc-500/10"
              style={{ color: 'var(--gia-muted-2)' }}
            >
              <Trash2 size={9} />
            </button>
          )}
        </div>
      </button>

      {/* Live activity (when running) */}
      {isRunning && task.currentActivity && (
        <div className="px-3 pb-2">
          <div className="flex items-center gap-1.5 text-[9px]" style={{ color: 'var(--gia-muted)' }}>
            <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: task.agentColor }} />
            {task.currentActivity}
          </div>
        </div>
      )}

      {/* Expanded content */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-2 border-t" style={{ borderColor: 'var(--gia-border)' }}>
              <div className="pt-2 text-[10px]" style={{ color: 'var(--gia-muted-2)' }}>
                <strong style={{ color: 'var(--gia-muted)' }}>Task:</strong> {task.prompt}
              </div>

              {/* Result */}
              {task.result && (
                <div
                  className="text-[11px] leading-relaxed rounded-lg p-2.5 max-h-48 overflow-y-auto"
                  style={{ background: 'var(--gia-bg)', border: '1px solid var(--gia-border)' }}
                >
                  <MarkdownRenderer content={task.result} />
                </div>
              )}

              {/* Error */}
              {task.error && (
                <div className="text-[10px] px-2 py-1.5 rounded-lg" style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171' }}>
                  {task.error}
                </div>
              )}

              {/* Token usage */}
              {task.tokenUsage && (
                <div className="text-[8px] font-mono" style={{ color: 'var(--gia-muted-2)' }}>
                  tokens: {task.tokenUsage.input} in / {task.tokenUsage.output} out
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Agent row (for the provider-assignment grid) ──────────────────────────
function AgentProviderRow({
  name,
  color,
  icon,
  role,
  providerOverride,
  onProviderChange,
}: {
  name: string;
  color: string;
  icon: string;
  role: string;
  providerOverride: string;
  onProviderChange: (providerId: string) => void;
}) {
  const IconComponent = resolveAgentIcon(icon);
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg" style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }}>
      <div className="w-5 h-5 rounded flex items-center justify-center shrink-0" style={{ background: `${color}15` }}>
        <OrbAvatar color={color} size={14} animate={false} icon={<IconComponent size={8} />} />
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-[10px] font-bold" style={{ color }}>{name}</span>
        <span className="text-[8px] ml-1" style={{ color: 'var(--gia-muted-2)' }}>{role}</span>
      </div>
      <ProviderSelect agentName={name} value={providerOverride} onChange={onProviderChange} compact />
    </div>
  );
}

// ── Main Dispatch Board ───────────────────────────────────────────────────
export default function AgentDispatchBoard() {
  const [prompt, setPrompt] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRefs = useRef<Map<string, AbortController>>(new Map());

  const {
    tasks, runningIds, subAgentProviders, agentProviders,
    dispatch, markRunning, setActivity, appendResult, setResult, setFailed,
    setSubAgentProvider, setAgentProvider, resolveProvider,
  } = useAgentTaskStore();
  const { providers, getActiveProviders, getBestProviderForTask } = useProviderStore();
  const customAgents = useAgentStore(s => s.agents || []);

  const activeProviders = getActiveProviders();
  const isMultiProvider = activeProviders.length > 1;

  // Auto-scroll to latest task
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [tasks.length]);

  // Combine built-in sub-agents + custom agents into the picker
  const allAgents = useMemo(() => {
    const builtIn = AGENT_ROLES.map(r => ({
      id: `sub-${r.name.toLowerCase()}`,
      name: r.name,
      role: r.role,
      color: r.color,
      icon: r.icon,
      type: 'sub' as const,
    }));
    const custom = customAgents.map(a => ({
      id: a.id,
      name: a.name,
      role: 'Custom',
      color: '#a855f7',
      icon: a.icon || 'Bot',
      type: 'custom' as const,
    }));
    return [...builtIn, ...custom];
  }, [customAgents]);

  // Toggle agent selection
  const toggleAgent = useCallback((agentId: string) => {
    setSelectedAgentIds(prev =>
      prev.includes(agentId) ? prev.filter(id => id !== agentId) : [...prev, agentId]
    );
  }, []);

  // Select all / deselect all
  const toggleAll = useCallback(() => {
    if (selectedAgentIds.length === allAgents.length) {
      setSelectedAgentIds([]);
    } else {
      setSelectedAgentIds(allAgents.map(a => a.id));
    }
  }, [selectedAgentIds.length, allAgents]);

  // Dispatch a single task to one agent
  const dispatchToAgent = useCallback(async (agentDef: typeof allAgents[number], taskPrompt: string) => {
    const taskId = dispatch({
      prompt: taskPrompt,
      agentId: agentDef.id,
      agentName: agentDef.name,
      agentRole: agentDef.role,
      agentColor: agentDef.color,
      agentIcon: agentDef.icon,
      providerId: agentDef.type === 'sub'
        ? (subAgentProviders[agentDef.name] || '')
        : (agentProviders[agentDef.name] || ''),
    });

    const controller = new AbortController();
    abortRefs.current.set(taskId, controller);

    // Resolve effective provider
    const providerId = resolveProvider(taskId);
    const providerConfig = providerId ? providers[providerId] : null;

    // Build enriched prompt
    const enrichedPrompt = `You are a sub-agent named ${agentDef.name} with the role of ${agentDef.role}.\n\nYour task:\n${taskPrompt}\n\nProvide your findings. Be thorough and direct.`;

    const systemPrompt = `You are GIA, a highly capable AI assistant. You are currently operating as the sub-agent "${agentDef.name}" (role: ${agentDef.role}). Be helpful, thorough, and direct.`;

    markRunning(taskId);
    setActivity(taskId, `Using ${providerId || 'auto'}…`);

    try {
      // Use GiaBrain with provider override
      const result = await GiaBrain.generate({
        prompt: enrichedPrompt,
        systemPrompt,
        providerId: providerId || undefined,
        signal: controller.signal,
        onStream: (chunk) => {
          appendResult(taskId, chunk);
          setActivity(taskId, 'Generating…');
        },
        onThought: (thought) => {
          setActivity(taskId, thought.slice(0, 80));
        },
      });

      if (!controller.signal.aborted) {
        setResult(taskId, result.text, result.tokenUsage ? { input: result.tokenUsage.input, output: result.tokenUsage.output } : undefined);
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') {
        useAgentTaskStore.getState().cancel(taskId);
        return;
      }
      setFailed(taskId, e instanceof Error ? e.message : 'Unknown error');
    } finally {
      abortRefs.current.delete(taskId);
    }
  }, [dispatch, markRunning, setActivity, appendResult, setResult, setFailed, resolveProvider, providers, subAgentProviders, agentProviders]);

  // Handle dispatch button / Enter
  const handleDispatch = useCallback(() => {
    const text = prompt.trim();
    if (!text || selectedAgentIds.length === 0) return;
    setPrompt('');

    // If only one agent selected, dispatch directly to it
    if (selectedAgentIds.length === 1) {
      const agent = allAgents.find(a => a.id === selectedAgentIds[0]);
      if (agent) dispatchToAgent(agent, text);
      return;
    }

    // Multiple agents — dispatch to each selected
    for (const agentId of selectedAgentIds) {
      const agent = allAgents.find(a => a.id === agentId);
      if (agent) dispatchToAgent(agent, text);
    }
  }, [prompt, selectedAgentIds, allAgents, dispatchToAgent]);

  // Keyboard shortcut
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleDispatch();
    }
  }, [handleDispatch]);

  const runningCount = runningIds.length;

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: 'var(--gia-bg)' }}>
      {/* Header */}
      <div className="px-4 pt-3 pb-2 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Sparkles size={14} style={{ color: '#a855f7' }} />
            <h2 className="text-sm font-bold" style={{ color: 'var(--gia-text)' }}>Agent Dispatch</h2>
            {runningCount > 0 && (
              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full animate-pulse"
                style={{ background: 'rgba(52,211,153,0.12)', color: '#34d399' }}>
                {runningCount} running
              </span>
            )}
          </div>
          {tasks.length > 0 && (
            <button
              onClick={() => useAgentTaskStore.getState().clearHistory()}
              className="text-[9px] px-2 py-1 rounded-lg font-medium"
              style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-muted)' }}
            >
              Clear history
            </button>
          )}
        </div>

        {/* Provider overview (when multi-provider) */}
        {isMultiProvider && (
          <div className="flex items-center gap-1.5 mb-2">
            <Cpu size={9} style={{ color: 'var(--gia-muted-2)' }} />
            <span className="text-[8px]" style={{ color: 'var(--gia-muted-2)' }}>
              {activeProviders.length} providers active:
            </span>
            {activeProviders.map(p => (
              <span key={p.id} className="text-[8px] font-mono px-1 py-0.5 rounded"
                style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-muted)' }}>
                {p.id}
              </span>
            ))}
          </div>
        )}

        {/* Agent picker toggle */}
        <button
          onClick={() => setShowAgentPicker(!showAgentPicker)}
          className="flex items-center gap-1.5 text-[9px] font-medium px-2 py-1 rounded-lg mb-2"
          style={{
            background: selectedAgentIds.length > 0 ? 'rgba(168,85,247,0.1)' : 'var(--gia-surface-2)',
            color: selectedAgentIds.length > 0 ? '#a855f7' : 'var(--gia-muted)',
            border: '1px solid var(--gia-border)',
          }}
        >
          <Zap size={9} />
          {selectedAgentIds.length === 0
            ? 'Select agents to dispatch to…'
            : `${selectedAgentIds.length} agent${selectedAgentIds.length > 1 ? 's' : ''} selected`
          }
          <ChevronDown size={9} className={`transition-transform ${showAgentPicker ? 'rotate-180' : ''}`} />
        </button>

        {/* Agent picker panel */}
        <AnimatePresence>
          {showAgentPicker && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden mb-2"
            >
              <div className="rounded-xl p-2 space-y-1 max-h-56 overflow-y-auto" style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }}>
                <div className="flex items-center justify-between px-1 pb-1">
                  <span className="text-[9px] font-semibold" style={{ color: 'var(--gia-muted-2)' }}>
                    Choose agents
                  </span>
                  <button
                    onClick={toggleAll}
                    className="text-[8px] px-1.5 py-0.5 rounded font-medium"
                    style={{ color: '#a855f7' }}
                  >
                    {selectedAgentIds.length === allAgents.length ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                {allAgents.map(agent => {
                  const selected = selectedAgentIds.includes(agent.id);
                  const IconComponent = resolveAgentIcon(agent.icon);
                  const providerOverride = agent.type === 'sub'
                    ? (subAgentProviders[agent.name] || '')
                    : (agentProviders[agent.name] || '');
                  const setProvider = agent.type === 'sub' ? setSubAgentProvider : setAgentProvider;

                  return (
                    <div key={agent.id} className="flex items-center gap-1.5">
                      <button
                        onClick={() => toggleAgent(agent.id)}
                        className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-all"
                        style={{
                          background: selected ? `${agent.color}10` : 'transparent',
                          border: `1px solid ${selected ? `${agent.color}30` : 'var(--gia-border)'}`,
                        }}
                      >
                        <div
                          className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                          style={{ background: `${agent.color}15` }}
                        >
                          <OrbAvatar color={agent.color} size={14} animate={false} icon={<IconComponent size={8} />} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-[10px] font-bold" style={{ color: agent.color }}>{agent.name}</span>
                          <span className="text-[8px] ml-1" style={{ color: 'var(--gia-muted-2)' }}>{agent.role}</span>
                        </div>
                        {selected && <CheckCircle2 size={10} style={{ color: agent.color }} />}
                      </button>
                      {/* Per-agent provider selector */}
                      {isMultiProvider && selected && (
                        <ProviderSelect
                          agentName={agent.name}
                          value={providerOverride}
                          onChange={(pid) => setProvider(agent.name, pid)}
                          compact
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Task list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 space-y-1.5 pb-3">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-3" style={{ background: 'rgba(168,85,247,0.08)' }}>
              <Sparkles size={24} style={{ color: 'rgba(168,85,247,0.5)' }} />
            </div>
            <p className="text-[11px] font-medium" style={{ color: 'var(--gia-muted)' }}>
              No dispatched tasks yet
            </p>
            <p className="text-[9px] mt-1 max-w-[220px]" style={{ color: 'var(--gia-muted-2)' }}>
              Select agents below and write a task to dispatch it. Each agent runs on its assigned provider in parallel.
            </p>
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {tasks.map(task => (
              <TaskCard key={task.id} task={task} />
            ))}
          </AnimatePresence>
        )}
      </div>

      {/* Input bar */}
      <div className="px-3 py-2.5 shrink-0 border-t" style={{ borderColor: 'var(--gia-border)', background: 'var(--gia-surface)' }}>
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              selectedAgentIds.length > 0
                ? `Dispatch to ${selectedAgentIds.length} agent${selectedAgentIds.length > 1 ? 's' : ''}…`
                : 'Select agents first, then write your task…'
            }
            rows={2}
            className="flex-1 text-[12px] py-2 px-3 rounded-xl resize-none outline-none"
            style={{
              background: 'var(--gia-bg)',
              color: 'var(--gia-text)',
              border: '1px solid var(--gia-border)',
            }}
          />
          <button
            onClick={handleDispatch}
            disabled={!prompt.trim() || selectedAgentIds.length === 0}
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-all"
            style={{
              background: prompt.trim() && selectedAgentIds.length > 0 ? '#a855f7' : 'var(--gia-surface-2)',
              color: prompt.trim() && selectedAgentIds.length > 0 ? 'white' : 'var(--gia-muted-2)',
            }}
          >
            <Send size={14} />
          </button>
        </div>
        {selectedAgentIds.length > 0 && (
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {selectedAgentIds.map(id => {
              const agent = allAgents.find(a => a.id === id);
              if (!agent) return null;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 text-[8px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{ background: `${agent.color}12`, color: agent.color, border: `1px solid ${agent.color}20` }}
                >
                  {agent.name}
                  <button onClick={() => toggleAgent(id)} className="hover:opacity-60">
                    <X size={7} />
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
