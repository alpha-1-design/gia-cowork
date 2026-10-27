import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, RotateCcw, Paperclip, Brain, ChevronDown, ChevronRight, Lock, Cloud, Globe, ThumbsUp, ThumbsDown } from 'lucide-react';
import { ReasoningChain } from './ReasoningChain';
import { WorkLog } from './WorkLog';
import { SegmentedReasoning } from './SegmentedReasoning';
import TaskProgress from './TaskProgress';
import GiaIcon from './GiaIcon';
import OrbAvatar from './OrbAvatar';
import { useGiaStore } from '../store/useGiaStore';
import MarkdownRenderer from './MarkdownRenderer';
import ArtifactsPanel from './ArtifactsPanel';
import MessageActionSheet, { RewriteBar } from './MessageActionSheet';
import MessageContextMenu from './MessageContextMenu';
import MessageFullScreen from './MessageFullScreen';
import { ChatSkeleton } from './feedback';
import { UserAvatar } from './avatars/UserAvatar';
import { resolveAgentColor, resolveAgentIcon } from '../utils/agentIcons';
import ToolTray from './ToolTray';
import InlineToolCalls from './InlineToolCalls';
import ProtocolApprovalCard from './ProtocolCard';
import { useProtocolStore } from '../store/useProtocolStore';
import InlineClarificationForm from './chat/InlineClarificationForm';
import type { Message, ThinkingPhase, Clarification } from '../store/useGiaStore';

const AgentBadge: React.FC<{ agentName?: string; agentIcon?: string; agentTask?: string }> = ({ agentName, agentTask }) => {
  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[9px] font-semibold uppercase tracking-wider" style={{ background: 'var(--gia-surface-3)', color: 'var(--gia-text)', border: '1px solid var(--gia-border)' }}>
      <OrbAvatar color="var(--gia-text)" size={10} animate={false} glow={false} />
      {agentName || 'Agent'}
      {agentTask && (
        <span className="ml-0.5 text-[7px] opacity-60 font-normal normal-case max-w-[120px] truncate">{agentTask}</span>
      )}
    </span>
  );
};

interface MessageListProps {
  onSuggestionClick?: (text: string) => void;
  messages: Message[];
  loading: boolean;
  streamingMsgId: string | null;
  streamingMsgIds?: Set<string>;
  expandedMsgs: Set<string>;
  setExpandedMsgs: React.Dispatch<React.SetStateAction<Set<string>>>;
  showThoughts: Set<string>;
  setShowThoughts: React.Dispatch<React.SetStateAction<Set<string>>>;
  liveThoughts: Record<string, string>;
  liveSegments?: Record<string, import('../store/useGiaStore').MessageSegment[]>;
  thinkingPhase: ThinkingPhase;
  currentTool: string | null;
  responseTimesRef: React.MutableRefObject<Record<string, number>>;
  onCopyMessage: (id: string, content: string) => void;
  onEdit: (id: string) => void;
  onDeleteWithUndo: (id: string) => void;
  onContinue: (id: string) => void;
  onFork: (id: string) => void;
  onRetry: (id: string) => Promise<void>;
  onEditResend: (msgId: string) => void;
  onRewrite: (id: string, instruction: string) => void;
  clarification?: Clarification | null;
  onClarificationFormAnswer?: (answer: string) => void;
}

const formatTimeAgo = (ts: number) => {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const LONG_MSG_CHARS = 3000;

const SourcesBlock: React.FC<{ sources: Array<string | { url: string; title?: string }> }> = ({ sources }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-[10px] font-semibold tap-feedback transition-colors hover:opacity-80"
        style={{ color: 'var(--gia-muted-2)' }}
      >
        <Globe size={11} />
        <span>Searched {sources.length} source{sources.length !== 1 ? 's' : ''}</span>
        <ChevronDown size={12} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
      </button>
      {open && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-1.5">
          {sources.map((src, si) => {
            const url = typeof src === 'string' ? src : (src as { url: string; title?: string }).url || '';
            const title = typeof src === 'string' ? url : (src as { url: string; title?: string }).title || `Source ${si + 1}`;
            const domain = (() => { try { return new URL(url).hostname.replace('www.', ''); } catch { return url; } })();
            return (
              <motion.a
                key={si}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                initial={{ opacity: 0, y: 12, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 24, mass: 0.8, delay: si * 0.08 }}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-[10px] transition-colors hover:bg-[var(--gia-surface-3)]"
                style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}
              >
                <span className="w-5 h-5 rounded-sm flex items-center justify-center text-[8px] font-bold shrink-0"
                  style={{ background: 'var(--gia-surface-3)', color: 'var(--gia-text)' }}>
                  {si + 1}
                </span>
                <img src={`https://www.google.com/s2/favicons?domain=${domain}&sz=16`} alt="" className="w-3.5 h-3.5 rounded-sm shrink-0" loading="lazy" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-medium" style={{ color: 'var(--gia-text)' }}>{title}</span>
                  <span className="block text-[7px] truncate" style={{ color: 'var(--gia-muted)' }}>{domain}</span>
                </div>
              </motion.a>
            );
          })}
        </div>
      )}
    </div>
  );
};

function useShowTokenUsage(): boolean {
  const [show, setShow] = useState(() => localStorage.getItem('gia-show-token-usage') === 'true');
  useEffect(() => {
    const handler = () => setShow(localStorage.getItem('gia-show-token-usage') === 'true');
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);
  return show;
}

const MessageList: React.FC<MessageListProps> = ({
  messages, loading, streamingMsgId, streamingMsgIds,
  expandedMsgs, setExpandedMsgs,
  showThoughts, setShowThoughts,
  liveThoughts, liveSegments = {}, thinkingPhase, currentTool,
  responseTimesRef,
  onCopyMessage, onEdit, onDeleteWithUndo, onContinue,
  onFork, onRetry, onEditResend, onRewrite,
  onSuggestionClick,
  clarification, onClarificationFormAnswer,
}) => {
  const extThinking = useGiaStore(s => s.extThinking);
  const userProfile = useGiaStore(s => s.userProfile);
  const showTokenUsage = useShowTokenUsage();
  const [sheetMsgId, setSheetMsgId] = useState<string | null>(null);
  const [fullScreenMsgId, setFullScreenMsgId] = useState<string | null>(null);
  const reactions = useGiaStore(s => s.reactions);
  const consoleProtocols = useProtocolStore(s => s.consoleProtocols);

  // `all` is a real global flag, not a message id. Per-message toggles expand
  // it into the explicit set first, so one message can still be closed while
  // the rest stay open.
  const isThoughtsOpen = (id: string) => showThoughts.has('all') || showThoughts.has(id);
  const toggleThoughts = (id: string) => setShowThoughts(prev => {
    const next = new Set(prev);
    if (next.has('all')) {
      next.delete('all');
      for (const m of messages) next.add(m.id);
    }
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <>
      {loading && messages.length === 0 && (
        <ChatSkeleton count={3} />
      )}
      {messages.map((msg) => (
        <motion.div key={msg.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className={`flex gap-2 sm:gap-3 md:gap-3.5 group ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
          <div className="w-7 h-7 rounded-md shrink-0 flex items-center justify-center mt-0.5" style={msg.agentId ? { background: 'var(--gia-surface-3)', border: '1px solid var(--gia-border)' } : msg.role === 'user' ? { background: 'transparent', border: 'none' } : { background: msg.error ? 'rgba(239,68,68,0.12)' : 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}>
            {msg.agentId ? <OrbAvatar color="var(--gia-text)" size={18} animate={false} icon={React.createElement(resolveAgentIcon(msg.agentIcon || 'Bot'))} /> : msg.role === 'user' ? <UserAvatar avatarId={userProfile.avatarId} name={userProfile.name} size={26} /> : msg.error ? <AlertCircle size={13} style={{ color: '#f87171' }} /> : msg.thinking ? extThinking ? <GiaIcon size={13} animate color="var(--gia-text)" /> : <div className="flex gap-0.5">{[0,1,2].map(d => <div key={d} className="thinking-dot" style={{ animationDelay: `${d * 0.16}s` }} />)}</div> : <GiaIcon size={14} animate={false} color="var(--gia-muted)" />}
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            {msg.attachments?.some(a => a.preview) && (
              <div className={`flex flex-wrap gap-2 mb-1 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.attachments.filter(a => a.preview).map((a, ai) => (
                  <img key={ai} src={a.preview} alt={a.name} className="w-24 h-24 rounded-xl object-cover" style={{ border: '1px solid var(--gia-border)' }} />
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 mb-0.5 ml-1">
              <span className="text-[9px] font-medium uppercase tracking-wider" style={{ color: msg.agentId ? 'var(--gia-text)' : msg.role === 'user' ? 'var(--gia-text)' : 'var(--gia-muted)' }}>
                {msg.agentId ? msg.agentName : msg.role === 'user' ? 'You' : 'GIA'}
              </span>
              <span className="text-[8px]" style={{ color: 'var(--gia-muted-2)' }} title={new Date(msg.timestamp).toLocaleString()}>
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <>
              <MessageContextMenu
                messageId={msg.id}
                content={typeof msg.content === 'string' ? msg.content : ''}
                isUser={msg.role === 'user'}
                canFork={!!msg.content && !msg.thinking}
                onCopy={onCopyMessage}
                onEdit={msg.role === 'user' ? onEdit : undefined}
                onRetry={msg.role === 'assistant' ? onRetry : undefined}
                onDelete={onDeleteWithUndo}
                onFork={onFork}
                onContinue={msg.role === 'assistant' ? onContinue : undefined}
              >
              <div
                className={`p-3 sm:p-4 md:p-5 relative cursor-pointer ${msg.role === 'user' ? 'bg-[var(--gia-surface-2)] border border-[var(--gia-border)]' : msg.error ? 'bg-rose-950/20 border border-rose-800/30' : streamingMsgId === msg.id || streamingMsgIds?.has(msg.id) ? 'streaming-message' : ''}`}
                style={{
                  borderRadius: msg.role === 'user' ? '12px 12px 4px 12px' : '4px 12px 12px 12px',
                }}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('a, button')) return;
                  setSheetMsgId(prev => (prev === msg.id ? null : msg.id));
                }}
              >
                {msg.thinking && !((streamingMsgId === msg.id || streamingMsgIds?.has(msg.id)) && msg.content) ? (
                  <div>
                    <WorkLog
                      thoughts={liveThoughts[msg.id] || msg.thoughts || ''}
                      isLive={!!liveThoughts[msg.id]}
                      isExpanded={isThoughtsOpen(msg.id)}
                      onToggle={() => toggleThoughts(msg.id)}
                      currentTool={currentTool}
                      thinkingPhase={thinkingPhase}
                      startTime={msg.timestamp}
                    />
                  </div>
                ) : msg.error ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-sm leading-relaxed" style={{ color: '#f87171' }}>{msg.content}</p>
                    <div className="flex items-center gap-2">
                      <button onClick={() => onRetry(msg.id)} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-semibold w-fit" style={{ background: 'rgba(239,68,68,0.15)', color: '#fca5a5' }}>
                        <RotateCcw size={10} /> Retry
                      </button>
                      <button onClick={() => onEditResend(msg.id)} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] w-fit" style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>
                        <RotateCcw size={10} /> Edit & Resend
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {msg.role === 'assistant' && (
                      <div className="flex items-center gap-1.5 mb-1.5 ml-0.5">
                        {msg.agentId ? (
                          <AgentBadge agentName={msg.agentName} agentIcon={msg.agentIcon} agentTask={msg.agentTask} />
                        ) : (
                          <span className="text-[9px] font-medium uppercase tracking-wider" style={{ color: 'var(--gia-muted-2)' }}>
                            {msg.model ? `via ${msg.model}` : 'GIA'}
                          </span>
                        )}
                        <span className="text-[8px]" style={{ color: 'var(--gia-muted-2)' }} title={new Date(msg.timestamp).toLocaleString()}>
                          {formatTimeAgo(msg.timestamp)}
                        </span>
                        {msg.thinking ? (
                          <span className="text-[8px] px-1.5 py-0.5 rounded-sm phase-badge" style={{ background: 'var(--gia-surface-3)', color: 'var(--gia-muted)' }}>
                            Thinking…
                          </span>
                        ) : streamingMsgId === msg.id || streamingMsgIds?.has(msg.id) ? (
                          <span className="text-[8px] px-1.5 py-0.5 rounded-sm phase-badge" style={{ background: 'var(--gia-surface-3)', color: 'var(--gia-text)' }}>
                            Generating…
                          </span>
                        ) : responseTimesRef.current[msg.id] ? (
                          <span className="text-[8px] px-1.5 py-0.5 rounded-sm" style={{ background: 'var(--gia-surface-3)', color: 'var(--gia-muted)' }}>
                            {(responseTimesRef.current[msg.id] / 1000).toFixed(1)}s
                          </span>
                        ) : null}
                        {showTokenUsage && msg.tokenUsage && !msg.thinking && (
                          <span className="text-[8px] px-1.5 py-0.5 rounded-sm" style={{ background: 'var(--gia-surface-3)', color: 'var(--gia-muted)' }}>
                            {msg.tokenUsage.total} tok
                          </span>
                        )}
                      </div>
                    )}
                    {msg.thinking && (streamingMsgId === msg.id || streamingMsgIds?.has(msg.id)) && msg.content && (
                      <div className="mb-2">
                        <WorkLog
                          thoughts={liveThoughts[msg.id] || msg.thoughts || ''}
                          isLive={!!liveThoughts[msg.id]}
                          isExpanded={isThoughtsOpen(msg.id)}
                          onToggle={() => toggleThoughts(msg.id)}
                          currentTool={currentTool}
                          thinkingPhase={thinkingPhase}
                          startTime={msg.timestamp}
                        />
                      </div>
                    )}
                    {(() => {
                      const segs = liveSegments[msg.id] || msg.segments;
                      if (segs && segs.length > 0) {
                        // New path: render the real think -> tool -> think
                        // sequence as discrete blocks, always visible (not
                        // hidden behind a single toggle) since each step
                        // is already collapsed on its own.
                        return <SegmentedReasoning segments={segs} isLive={!!liveSegments[msg.id]} />;
                      }
                      // Fallback for messages generated before this existed
                      // (or any path that doesn't populate segments) --
                      // same single collapsible blob as before.
                      return (liveThoughts[msg.id] || msg.thoughts) ? (
                      <div className="mb-3 rounded-md overflow-hidden transition-all duration-300" style={{
                        border: '1px solid var(--gia-border)',
                        background: 'var(--gia-surface-2)',
                      }}>
                        <button
                          onClick={() => toggleThoughts(msg.id)}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:opacity-80 transition-opacity"
                          style={{ color: 'var(--gia-text)' }}
                        >
                          <Brain size={12} />
                          <span className="text-[11px] font-medium flex-1">
                            {isThoughtsOpen(msg.id) ? 'Hide' : 'Show'} reasoning ({(liveThoughts[msg.id] || msg.thoughts || '').split(' ').length} words)
                          </span>
                          {isThoughtsOpen(msg.id) ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        </button>
                        <ReasoningChain
                          messageId={msg.id}
                          thoughts={liveThoughts[msg.id] || msg.thoughts || ''}
                          isLive={!!liveThoughts[msg.id]}
                          isExpanded={isThoughtsOpen(msg.id)}
                          onToggle={() => toggleThoughts(msg.id)}
                        />
                      </div>
                      ) : null;
                    })()}
                    {msg.content.length > LONG_MSG_CHARS && !expandedMsgs.has(msg.id) ? (
                      <>
                        <MarkdownRenderer content={msg.content.slice(0, LONG_MSG_CHARS)} sources={msg.sources} />
                        <button onClick={() => setExpandedMsgs(prev => new Set(prev).add(msg.id))} className="mt-2 text-[11px] font-medium flex items-center gap-1 px-3 py-1.5 rounded-md transition-colors" style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-text)', border: '1px solid var(--gia-border)' }}>
                          Show more ({Math.ceil((msg.content.length - LONG_MSG_CHARS) / 1000)}k+ chars)
                        </button>
                      </>
                    ) : (
                      <div className="token-reveal">
                        <MarkdownRenderer content={msg.content} sources={msg.sources} />
                        {(streamingMsgId === msg.id || streamingMsgIds?.has(msg.id)) && msg.content && loading && (
                          extThinking
                            ? <GiaIcon size={13} animate color="var(--gia-text)" className="ml-1" speed={1.3} />
                            : <span className="stream-cursor ml-0.5">▋</span>
                        )}
                        {expandedMsgs.has(msg.id) && (
                          <button onClick={() => setExpandedMsgs(prev => { const n = new Set(prev); n.delete(msg.id); return n; })} className="mt-2 text-[11px] font-medium flex items-center gap-1 px-3 py-1.5 rounded-md transition-colors" style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-text)', border: '1px solid var(--gia-border)' }}>
                            Show less
                          </button>
                        )}
                      </div>
                    )}
                    {msg.role === 'assistant' && !msg.thinking && !msg.error && (
                      <div className="mt-1.5 text-[9px] text-right tracking-wider select-none flex items-center justify-end gap-1.5" style={{ color: 'var(--gia-muted-3)' }}>
                        <span className="opacity-40">— </span>
                        <span style={{ color: 'var(--gia-muted-3)' }}>✦</span>
                        <span className="font-medium ml-0.5" style={{ color: 'var(--gia-muted-3)' }}>{msg.agentId ? msg.agentName : 'GIA'}</span>
                        {msg.source === 'on-device' && (
                          <span className="inline-flex items-center gap-0.5 ml-1 px-1.5 py-0.5 rounded-sm" style={{ background: 'var(--gia-surface-3)', color: 'var(--gia-muted)' }}>
                            <Lock size={9} /> on-device
                          </span>
                        )}
                        {msg.source === 'cloud' && (
                          <span className="inline-flex items-center gap-0.5 ml-1 px-1.5 py-0.5 rounded-sm" style={{ background: 'var(--gia-surface-3)', color: 'var(--gia-muted)' }}>
                            <Cloud size={9} /> cloud
                          </span>
                        )}
                      </div>
                    )}
                    {msg.role === 'assistant' && reactions[msg.id] && (
                      <div className="mt-1 flex items-center gap-1" style={{ color: reactions[msg.id].value === 'up' ? '#22c55e' : '#f87171' }}>
                        {reactions[msg.id].value === 'up' ? <ThumbsUp size={12} /> : <ThumbsDown size={12} />}
                        <span className="text-[9px] tracking-wider select-none">{reactions[msg.id].value === 'up' ? 'Liked' : 'Disliked'}</span>
                      </div>
                    )}
                    {msg.artifacts && msg.artifacts.length > 0 && (
                      <ArtifactsPanel artifacts={msg.artifacts} />
                    )}
                    {msg.role === 'assistant' && clarification?.fields && clarification.fields.length > 0 && clarification.assistantMsgId === msg.id && (
                      <InlineClarificationForm
                        question={clarification.question}
                        fields={clarification.fields}
                        loading={loading}
                        onSubmit={(answer) => onClarificationFormAnswer?.(answer)}
                      />
                    )}
                    {msg.role === 'assistant' && consoleProtocols.filter(p => p.messageId === msg.id && p.state === 'proposed').length > 0 && (
                      <div className="mt-3">
                        <p className="text-[9px] font-semibold uppercase tracking-wider px-1 mb-1" style={{ color: 'var(--gia-muted)' }}>
                          Waiting for your approval
                        </p>
                        {consoleProtocols
                          .filter(p => p.messageId === msg.id && p.state === 'proposed')
                          .sort((a, b) => a.createdAt - b.createdAt)
                          .map(p => (
                            <ProtocolApprovalCard key={p.id} protocol={p} />
                          ))}
                      </div>
                    )}
                    {msg.role === 'assistant' && consoleProtocols.filter(p => p.messageId === msg.id).length > 0 && (
                      <>
                        <InlineToolCalls
                          protocols={consoleProtocols
                            .filter(p => p.messageId === msg.id)
                            .sort((a, b) => a.createdAt - b.createdAt)}
                        />
                        <ToolTray
                          protocols={consoleProtocols
                            .filter(p => p.messageId === msg.id)
                            .sort((a, b) => a.createdAt - b.createdAt)}
                        />
                      </>
                    )}
                    {msg.sources && msg.sources.length > 0 && (
                      <SourcesBlock sources={msg.sources} />
                    )}
                    {msg.attachments?.filter(a => !a.preview).map(att => (
                      <div key={att.name} className="mt-2 flex items-center gap-1.5 text-[10px] px-2 py-1.5 rounded-lg" style={{ background: 'var(--gia-surface-2)' }}>
                        <Paperclip size={10} /> {att.name}
                      </div>
                    ))}
                  </>
                )}
                {msg.tasks && msg.tasks.length > 0 && (
                  <TaskProgress tasks={msg.tasks} agentColor={msg.agentId ? resolveAgentColor(msg.agentIcon || 'Bot') : undefined} />
                )}
              </div>
              </MessageContextMenu>
              {msg.role === 'assistant' && msg.wasTruncated && (
                <button
                  onClick={() => onContinue(msg.id)}
                  className="flex items-center gap-1.5 text-[10px] font-semibold px-3 py-1.5 rounded-md transition-colors tap-feedback"
                  style={{
                    background: 'var(--gia-surface-2)',
                    color: 'var(--gia-text)',
                    border: '1px solid var(--gia-border)',
                  }}
                >
                  <ChevronRight size={11} />
                  Response truncated — tap to continue
                </button>
              )}
              {msg.role === 'assistant' && !msg.wasTruncated && msg.suggestions && msg.suggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {msg.suggestions.map(s => (
                    <button
                      key={s}
                      onClick={() => onSuggestionClick?.(s)}
                      className="text-[10px] px-3 py-1.5 rounded-md transition-colors tap-feedback"
                      style={{
                        background: 'var(--gia-surface-2)',
                        color: 'var(--gia-muted)',
                        border: '1px solid var(--gia-border)',
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {sheetMsgId === msg.id && (
                <>
                  <MessageActionSheet
                    msg={msg}
                    onClose={() => setSheetMsgId(null)}
                    onCopy={onCopyMessage}
                    onRetry={onRetry}
                    onEdit={onEdit}
                    onContinue={onContinue}
                    onFork={onFork}
                    onDelete={onDeleteWithUndo}
                    onRewrite={onRewrite}
                    onExpand={(id) => { setSheetMsgId(null); setFullScreenMsgId(id); }}
                    reaction={reactions[msg.id]?.value}
                    onReact={(value) => { const m = messages.find(x => x.id === msg.id); useGiaStore.getState().setReaction(msg.id, value, m ? m.content.slice(0, 200) : ''); }}
                    nextAssistantId={(() => { const i = messages.findIndex(m => m.id === msg.id); const n = messages[i + 1]; return n && n.role === 'assistant' ? n.id : undefined; })()}
                  />
                  {msg.role === 'assistant' && (
                    <RewriteBar msgId={msg.id} onRewrite={onRewrite} onClose={() => setSheetMsgId(null)} onFork={onFork} onDelete={onDeleteWithUndo} />
                  )}
                </>
              )}
            </>
          </div>
        </motion.div>
      ))}
      <MessageFullScreen
        msg={fullScreenMsgId ? (messages.find(m => m.id === fullScreenMsgId) ?? null) : null}
        reaction={fullScreenMsgId ? reactions[fullScreenMsgId]?.value : undefined}
        onClose={() => setFullScreenMsgId(null)}
        onCopy={onCopyMessage}
        onRegenerate={onRetry}
        onReact={(value) => { if (fullScreenMsgId) { const m = messages.find(x => x.id === fullScreenMsgId); useGiaStore.getState().setReaction(fullScreenMsgId, value, m ? m.content.slice(0, 200) : ''); } }}
      />
    </>
  );
};

export default MessageList;
