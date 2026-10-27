import React from 'react';
import { createPortal } from 'react-dom';
import {
  Bot, Plus, History, Trash2,
  Paperclip, X, Download, Globe, Image as ImageIcon, Camera, Terminal,
  Brain, ChevronDown, Sparkles, Code2,
  BookOpen, Zap, Undo2, Search, Headphones, GitBranch,
  Eye, Loader2, Upload, LayoutTemplate, Languages, Hammer, RotateCcw, Archive, Radar, SlidersHorizontal, Wrench,
  Maximize2, ChevronRight, Settings as SettingsIcon,
  PlugZap, Plug, KeyRound, MessagesSquare, PanelRight, Files as FilesIcon, MoreHorizontal, PenLine,
} from 'lucide-react';
import WorkspaceDock from '../components/WorkspaceDock';
import BuildStudio from '../components/BuildStudio';
import { MODES, getModePromptName, MODE_EDGE_GLOW } from '../services/system/modePrompts';
import SessionSwitcher from '../components/SessionSwitcher';
import AgentActivityStrip from '../components/AgentActivityStrip';
import QueuedMessages from '../components/QueuedMessages';
import UpdateBanner from '../components/UpdateBanner';
import { motion, AnimatePresence } from 'motion/react';
import { useGiaStore } from '../store/useGiaStore';
import { useProtocolStore } from '../store/useProtocolStore';
import { useSearchActivity } from '../store/useSearchActivity';
import { useChatState } from '../hooks/useChatState';
import { useProactiveMessage } from '../hooks/useProactiveMessage';
import GiaIcon from '../components/GiaIcon';
import giaTools from '../services/GiaTools';
import SandboxEnvService from '../services/SandboxEnvService';
import MessageList from '../components/MessageList';
import ComposerToolsSheet from '../components/ComposerToolsSheet';
import AmbientInput from '../components/AmbientInput';
import SkillPicker from '../components/SkillPicker';
import BuildPreviewSheet from '../components/BuildPreviewSheet';
import { KnowledgePanel } from '../components/KnowledgePanel';
import FileManager from '../components/FileManager';
import ToolTray from '../components/ToolTray';
import { ClarificationBottomSheet } from '../components/chat/ClarificationBottomSheet';
import ModelSwitcherSheet from '../components/chat/ModelSwitcherSheet';
import ToolsCatalogSheet from '../components/chat/ToolsCatalogSheet';
import { GiaBotRoster, botPortrait, agentName } from '../components/GiaBots';
import Council from '../components/Council';
import AgentPrompts from '../components/AgentPrompts';
import ProviderIcon from '../components/ProviderIcon';
import { BranchView } from '../components/chat/BranchView';
import { SummaryBanner } from '../components/chat/SummaryBanner';
import AgentMentionPicker from '../components/AgentMentionPicker';
import { useProviderStore } from '../store/useProviderStore';
import AgentSwarmDashboard from '../components/AgentSwarmDashboard';
import { TemplateSelector } from '../components/TemplateSelector';
import { LiveFileEditor } from '../components/LiveFileEditor';
import VoiceMode from '../components/VoiceMode';
import CameraCaptureModal from '../components/CameraCaptureModal';
import { isNativePlatform } from '../utils/helpers';

const QUICK_STARTS = [
  { icon: Code2, label: 'Code Help', prompt: 'Explain and fix this code:', category: 'code' },
  { icon: Paperclip, label: 'Analyze a File', prompt: 'Attach a file — summarize or analyze it:', category: 'work' },
  { icon: Sparkles, label: 'Summarize URL', prompt: 'Summarize this URL: https://', category: 'tools' },
  { icon: Hammer, label: 'Build an App', prompt: 'Build a web app that…', category: 'build' },
  { icon: Zap, label: 'Plan a Project', prompt: 'Help me plan a project — goal:', category: 'productivity' },
  { icon: PenLine, label: 'Write a Draft', prompt: 'Write a draft of…', category: 'writing' },
];

const focusComposer = () => {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-gia-composer]');
    el?.focus();
  });
};

const LOCALHOST_RE = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|(10\.\d{1,3}\.\d{1,3}\.\d{1,3})|(192\.168\.\d{1,3}\.\d{1,3})|(172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}))(:\d+)?(\/[^\s<]*)?/i;
const extractLocalhostUrl = (text: string): string | null => {
  const m = text?.match(LOCALHOST_RE);
  return m ? m[0] : null;
};

const MODE_HINTS: Record<string, string> = {
  code: 'Full access',
  plan: 'Propose only',
  ask: 'Answer only',
  build: 'Master builder',
  exam: 'Tutor',
  analyst: 'Evidence',
};

interface ChatModuleProps {
  /** Force Build Mode on — used by the dedicated Build module wrapper. */
  build?: boolean;
}

const ChatModule: React.FC<ChatModuleProps> = ({ build: forceBuild }) => {
  const {
    input, setInput, loading, streamingMsgId, streamingMsgIds, voiceEnabled,
    showHistory, setShowHistory, historySearch, setHistorySearch, attachments,
    processingFiles, processingFileName,
    showScrollBtn, undoMsg, showSkillPicker,
    expandedMsgs, setExpandedMsgs, showThoughts, setShowThoughts,
    liveThoughts, liveSegments, showKnowledge, setShowKnowledge,
    isDragging, showFileManager, setShowFileManager, showTools,
    inputContainerHeight,
    scrollRef, inputContainerRef, fileRef, imgRef,
    responseTimesRef, clarAnswer, setClarAnswer,
    activeSessionId, setActiveSession, sessions,
    createSession, deleteSession,
    addNotification,
    webSearch, deepSearch, extThinking, handsOff,
    localVision, localTranslate,
    activeSkillId, setSkill,
    skills, thinkingPhase, currentTool,
    messages, activeSession, providerConnected, providerLabel,
    activeModel,
    toggleFeature, handleStop, handleUndoDelete,
    handleInputChange, handleSend, sendText, handleClarificationAnswer,
    handleDeleteWithUndo, handleContinue, handleFork, handleRetry, handleRewrite, handleEditResend,
    handlePaste, handleDragEnter, handleDragLeave,
    handleDragOver, handleDrop, handleFile, removeAttachment, addFiles,
    copyMessage, scrollToBottom, handleScroll, exportChat,
    setShowSkillPicker, setShowTools,
    showBranchView, setShowBranchView,
    clarification, setClarification,
    showAgentMention, agentMentionQuery, handleAgentMentionSelect,
    liveFileEdit, setLiveFileEdit,
  } = useChatState();

  const buildModeStore = useGiaStore((s) => s.buildMode);
  const buildMode = forceBuild ?? buildModeStore;
  const setBuildMode = useGiaStore((s) => s.setBuildMode);
  const buildPreviewUrl = useGiaStore((s) => s.buildPreviewUrl);
  const setBuildPreview = useGiaStore((s) => s.setBuildPreview);
  const sandboxEnvReady = useGiaStore((s) => s.sandboxEnvReady);
  const archivedSessions = useGiaStore((s) => s.archivedSessions);
  const restoreSession = useGiaStore((s) => s.restoreSession);
  const userProfile = useGiaStore((s) => s.userProfile);
  const activeProvider = useProviderStore((s) => s.activeProvider);

  const toolItems: { key: 'webSearch' | 'deepSearch' | 'extThinking' | 'handsOff' | 'listen' | 'vision' | 'translate'; label: string; icon: React.ComponentType<{ size?: number }>; active: boolean; color: string }[] = [
    { key: 'webSearch', label: 'Web Search', icon: Globe, active: webSearch, color: 'var(--gia-text)' },
    { key: 'deepSearch', label: 'DeepSearch', icon: Radar, active: deepSearch, color: 'var(--gia-text)' },
    { key: 'extThinking', label: 'Think', icon: Brain, active: extThinking, color: 'var(--gia-text)' },
    { key: 'handsOff', label: 'Hands-off', icon: Zap, active: handsOff, color: 'var(--gia-text)' },
    { key: 'listen', label: 'Voice Mode', icon: Headphones, active: voiceEnabled, color: 'var(--gia-text)' },
    { key: 'vision', label: 'Vision', icon: Eye, active: localVision, color: 'var(--gia-text)' },
    { key: 'translate', label: 'Translate', icon: Languages, active: localTranslate, color: 'var(--gia-text)' },
  ];
  const activeToolCount = toolItems.filter(t => t.active).length;
  const activeSkill = skills.find(s => s.id === activeSkillId);

  // Tappable follow-up suggestion chips → send the text like a normal message.
  const handleSuggestionClick = React.useCallback((text: string) => {
    if (!text.trim() || loading) return;
    sendText(text.trim());
  }, [sendText, loading]);

  React.useEffect(() => {
    if (!buildMode) return;
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && !last.error) {
      const url = extractLocalhostUrl(last.content);
      if (url && url !== buildPreviewUrl) setBuildPreview(url);
    }
  }, [buildMode, messages, buildPreviewUrl, setBuildPreview]);

  // Refresh on-device sandbox readiness when entering Build Mode so the
  // "set up" nudge is accurate.
  React.useEffect(() => {
    if (buildMode && SandboxEnvService.isAvailable()) {
      SandboxEnvService.status().catch(() => {});
    }
  }, [buildMode]);

  const showModelSwitcher = useGiaStore((s) => s.showModelSwitcher);
  const [showToolsCatalog, setShowToolsCatalog] = React.useState(false);
  const setShowModelSwitcher = useGiaStore((s) => s.setShowModelSwitcher);
  const [showTemplateSelector, setShowTemplateSelector] = React.useState(false);
  const [showCamera, setShowCamera] = React.useState(false);
  const [showPreviewSheet, setShowPreviewSheet] = React.useState(false);
  const [showBuildStudio, setShowBuildStudio] = React.useState(false);
  const currentModeName = ((useGiaStore(s => s.sharedData) as { currentMode?: string } | undefined)?.currentMode) ?? 'code';
  const [showVoiceMode, setShowVoiceMode] = React.useState(false);
  const [showModeMenu, setShowModeMenu] = React.useState(false);
  const [runElapsed, setRunElapsed] = React.useState(0);
  // Terminal + files docked beside the chat (desktop workflow).
  // Persisted, not local state. The panel is a workspace preference — losing it
// on every reload meant the toggle felt broken rather than remembered.
const sidePanelOpen = useGiaStore(s => s.sidePanelOpen);
const setSidePanelOpen = useGiaStore(s => s.setSidePanelOpen);
const [dockOpen, setDockOpen] = React.useState(false);
  const [showMoreMenu, setShowMoreMenu] = React.useState(false);
  const [showCouncil, setShowCouncil] = React.useState(false);
  const [showPrompts, setShowPrompts] = React.useState(false);
  // Voice is its own full-screen surface. It used to toggle the app-wide
  // fullscreen flag on the way in and out, which left the shell in the wrong
  // state whenever the two disagreed (and made the close button toggle it a
  // second time). Opening the overlay is enough.
  const openVoice = React.useCallback(() => { setShowVoiceMode(true); }, []);

  // Ctrl/Cmd+B — the same shortcut VS Code and most editors use for the side
  // panel, so it lands where the user's hand already is.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'b') return;
      const el = document.activeElement;
      const tag = (el?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (el as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      const next = !useGiaStore.getState().sidePanelOpen;
      useGiaStore.getState().setSidePanelOpen(next);
      setDockOpen(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const closeVoice = React.useCallback(() => { setShowVoiceMode(false); }, []);

  // The header shows a live run clock while a turn is generating. A spinner
  // says "something is happening"; a clock and a phase say what and for how
  // long, which is the difference between waiting and wondering.
  React.useEffect(() => {
    if (!loading) { setRunElapsed(0); return; }
    const started = Date.now();
    const id = setInterval(() => setRunElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [loading]);

  const handleCameraCapture = React.useCallback((dataUrl: string, name: string) => {
    const [head, b64] = dataUrl.split(',');
    const mime = head.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    addFiles([new File([buf], name, { type: mime })], true);
  }, [addFiles]);

  useProactiveMessage();

  // A blank chat is already a new chat. Plus must not stack another empty one,
  // and leftover blanks should not sit in the list.
  React.useEffect(() => {
    const s = useGiaStore.getState();
    const next = s.sessions.filter(sess =>
      sess.messages.length > 0
      || sess.id === s.activeSessionId
      || (sess.title && sess.title !== 'New Chat' && sess.title !== 'New chat'),
    );
    if (next.length !== s.sessions.length) useGiaStore.setState({ sessions: next });
  }, []);

  const startFreshChat = () => {
    const s = useGiaStore.getState();
    const active = s.sessions.find(x => x.id === s.activeSessionId);
    if (active && active.messages.length === 0) return;
    createSession();
  };

  if (showHistory) {
    return (
    <div className="flex flex-col h-full relative" style={{ background: 'var(--gia-bg)' }}>
        <div className="flex items-center justify-between px-4 py-4 shrink-0" style={{ borderBottom: '1px solid var(--gia-border)' }}>
          <button onClick={() => setShowHistory(false)} className="text-sm flex items-center gap-1" style={{ color: 'var(--gia-muted)' }}>
            ← Back
          </button>
          <span className="text-sm font-semibold" style={{ color: 'var(--gia-text)' }}>Chats</span>
          <button onClick={() => { startFreshChat(); setShowHistory(false); }} className="w-8 h-8 rounded-md flex items-center justify-center" style={{ background: 'var(--gia-accent)', color: 'var(--gia-accent-contrast)' }} aria-label="New chat" title="New chat">
            <Plus size={15} />
          </button>
        </div>
        <div className="px-4 pt-3 shrink-0">
          <div className="relative">
            <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--gia-muted-2)' }} />
            <input
              className="gia-input"
              style={{ paddingLeft: '30px', fontSize: '12px' }}
              value={historySearch}
              onChange={e => setHistorySearch(e.target.value)}
              placeholder="Search chats..."
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {(() => {
            const filtered = sessions.filter(s => {
              const emptyBlank = s.messages.length === 0 && (s.title === 'New Chat' || s.title === 'New chat');
              if (emptyBlank && s.id !== activeSessionId) return false;
              if (!historySearch) return true;
              if (s.title?.toLowerCase().includes(historySearch.toLowerCase())) return true;
              return s.messages.some(m => m.message?.content?.toLowerCase().includes(historySearch.toLowerCase()));
            });
            return (
              <>
                {filtered.map((sess) => {
                  const matchCount = historySearch ? sess.messages.filter(m => m.message?.content?.toLowerCase().includes(historySearch.toLowerCase())).length : 0;
                  return (
                    <div key={sess.id} className="gia-card p-3 flex items-center gap-3 cursor-pointer transition-all tap-feedback" style={sess.id === activeSessionId ? { borderColor: 'var(--gia-border-2)', background: 'var(--gia-surface-2)' } : {}} onClick={() => { setActiveSession(sess.id); setShowHistory(false); }}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate" style={{ color: 'var(--gia-text)' }}>{sess.title}</p>
                        <p className="text-[10px] mt-0.5" style={{ color: 'var(--gia-muted)' }}>{sess.messages.length} msgs · {new Date(sess.updatedAt).toLocaleDateString()}{matchCount > 0 ? ` · ${matchCount} match${matchCount > 1 ? 'es' : ''}` : ''}</p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteSession(sess.id); }}
                        className="p-1.5 rounded-lg transition-colors"
                        style={{ color: 'var(--gia-muted-2)' }}
                        aria-label={`Delete ${sess.title}`}
                        title="Delete chat"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  );
                })}
                {filtered.length === 0 && (
                  <p className="text-xs text-center py-8" style={{ color: 'var(--gia-muted-2)' }}>No chats found{historySearch ? ` for "${historySearch}"` : ''}</p>
                )}
              </>
            );
          })()}

          {archivedSessions.length > 0 && (
            <div className="pt-2 mt-2" style={{ borderTop: '1px solid var(--gia-border)' }}>
              <p className="text-[10px] font-semibold uppercase tracking-wide px-1 pb-2 flex items-center gap-1.5" style={{ color: 'var(--gia-muted-2)' }}>
                <Archive size={11} /> Archived ({archivedSessions.length})
              </p>
              {archivedSessions.filter(s => !historySearch || s.title?.toLowerCase().includes(historySearch.toLowerCase())).map((sess) => (
                <div key={sess.id} className="gia-card p-3 flex items-center gap-3" style={{ opacity: 0.85 }}>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: 'var(--gia-text)' }}>{sess.title}</p>
                    <p className="text-[10px] mt-0.5" style={{ color: 'var(--gia-muted)' }}>{sess.messages.length} msgs · {new Date(sess.updatedAt).toLocaleDateString()}</p>
                  </div>
                  <button
                    onClick={() => restoreSession(sess.id)}
                    className="p-1.5 rounded-lg transition-colors"
                    style={{ color: 'var(--gia-muted-2)' }}
                    aria-label={`Restore ${sess.title}`}
                    title="Restore this archived chat"
                  >
                    <RotateCcw size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full relative gia-mode-edges"
      data-mode={currentModeName}
      data-testid="chat-module-root"
      style={{
        background: 'var(--gia-bg)',
        // The module's own edge picks up the active mode. Plan mode is the one
        // that needs it most: it is the mode where being wrong is quietest —
        // GIA looks exactly as productive as usual while touching nothing —
        // so the boundary has to carry the state, not just the prompt.
        boxShadow: MODE_EDGE_GLOW[currentModeName as keyof typeof MODE_EDGE_GLOW] ?? 'none',
        transition: 'box-shadow 320ms ease',
      }}
    >
    <div className="flex flex-col flex-1 min-w-0 relative">
      {/* Processing bar */}
      {loading && (
        <div className="absolute top-0 left-0 right-0 h-0.5 z-30 overflow-hidden" style={{ background: 'var(--gia-border)' }}>
          <div className="h-full w-full" style={{
            background: 'var(--gia-text)',
            opacity: 0.75,
            width: '100%',
            height: '100%',
          }} />
        </div>
      )}
      <div className="flex items-center justify-between px-3 h-12 shrink-0 gap-2" style={{ borderBottom: '1px solid var(--gia-border)' }}>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <button onClick={() => setShowHistory(true)} className="shrink-0" title="Chat history" aria-label="Chat history">
            <img
              src={botPortrait(activeSkillId || 'core-general')}
              alt=""
              className="w-8 h-8 rounded-full object-cover"
            />
          </button>
          <div className="min-w-0 text-left hidden sm:block">
            <p className="text-[13px] font-medium leading-none truncate" style={{ color: 'var(--gia-text)' }}>
              {agentName(activeSkillId)}
            </p>
            <p className="text-[11px] mt-1 truncate" style={{ color: 'var(--gia-muted)' }}>{activeSession?.title ?? 'New chat'}</p>
          </div>
          {activeSession && activeSession.branches && Object.keys(activeSession.branches).length > 0 && (
            <button onClick={() => setShowBranchView(true)} className="p-1 rounded-md transition-colors tap-feedback shrink-0" style={{ color: 'var(--gia-text)' }} aria-label="Branches" title="Branches">
              <GitBranch size={12} />
            </button>
          )}

          {/* Cockpit: mode, active skill and live run state live in the header
              so the chat surface answers "what is GIA doing, in what mode, as
              which agent?" without opening a sheet. */}
          {loading && (
            <span
              className="hidden sm:flex items-center gap-1.5 h-5 px-1.5 rounded-sm shrink-0"
              style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}
              title={`${thinkingPhase} · ${currentTool || 'working'}`}
            >
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--gia-text)' }} />
              <span className="text-[9px] font-mono uppercase tracking-wider" style={{ color: 'var(--gia-text)' }}>
                {thinkingPhase === 'idle' ? 'working' : thinkingPhase}
              </span>
              {runElapsed > 0 && (
                <span className="text-[9px] font-mono tabular-nums" style={{ color: 'var(--gia-muted-2)' }}>{runElapsed}s</span>
              )}
            </span>
          )}

          <div className="relative shrink-0 hidden md:block">
            <button
              type="button"
              onClick={() => setShowModeMenu((open) => !open)}
              className="flex items-center gap-1 h-5 px-1.5 rounded-sm text-[9px] font-semibold uppercase tracking-wider transition-colors"
              style={{
                background: showModeMenu ? 'var(--gia-surface-3)' : 'var(--gia-surface-2)',
                border: '1px solid var(--gia-border)',
                color: 'var(--gia-text)',
              }}
              aria-haspopup="menu"
              aria-expanded={showModeMenu}
              title={`Mode: ${getModePromptName(currentModeName)}`}
            >
              {currentModeName}
              <ChevronDown size={9} style={{ color: 'var(--gia-muted-2)' }} />
            </button>
            {showModeMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowModeMenu(false)} />
                <div
                  className="absolute left-0 top-7 z-50 w-48 rounded-md py-1 shadow-xl"
                  style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }}
                  role="menu"
                >
                  {MODES.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="menuitemradio"
                      aria-checked={currentModeName === m}
                      onClick={() => {
                        useGiaStore.getState().updateSharedData({ currentMode: m });
                        setBuildMode(m === 'build');
                        setShowModeMenu(false);
                      }}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors hover:bg-[var(--gia-overlay)]"
                      style={{ color: currentModeName === m ? 'var(--gia-text)' : 'var(--gia-muted)' }}
                    >
                      <span className="capitalize">{m}</span>
                      <span className="text-[9px] truncate max-w-[100px]" style={{ color: 'var(--gia-muted-2)' }}>{MODE_HINTS[m] ?? ''}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {activeSkill && (
            <button
              type="button"
              onClick={() => setShowSkillPicker(true)}
              className="hidden xl:flex items-center gap-1 h-5 px-1.5 rounded-sm shrink-0 transition-colors"
              style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-muted)' }}
              title={`Active skill: ${activeSkill.name} — click to switch`}
            >
              <Sparkles size={9} />
              <span className="text-[9px] max-w-[100px] truncate">{activeSkill.name}</span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {voiceEnabled && (
            <div className="hidden sm:flex items-center gap-1 px-2 py-1 rounded-md shrink-0" style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}>
              <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--gia-text)' }} />
              <span className="text-[8px] font-medium" style={{ color: 'var(--gia-muted)' }}>LIVE</span>
            </div>
          )}
          <button
            onClick={() => setShowModelSwitcher(true)}
            className="gia-pill flex items-center gap-1.5 shrink-0 max-w-[180px] tap-feedback transition-all"
            style={{
              background: 'var(--gia-surface-2)',
              color: 'var(--gia-text)',
              border: '1px solid var(--gia-border)',
            }}
            title="Switch model & provider"
          >
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: providerConnected ? 'var(--gia-text)' : 'var(--gia-muted-2)' }} />
            <ProviderIcon provider={activeProvider} size={18} bare />
            <span className="hidden sm:inline truncate max-w-[70px]">{providerLabel}</span>
            {activeModel && providerConnected && (
              <span className="text-[7px] opacity-50 truncate max-w-[54px] hidden lg:inline">{activeModel.split('/').pop()}</span>
            )}
            <ChevronDown size={11} className="shrink-0 opacity-70" />
          </button>
          <button
            onClick={() => { setShowPrompts(v => !v); setShowCouncil(false); }}
            className="h-7 px-2 sm:px-2.5 rounded-sm text-[11px] flex items-center gap-1"
            style={{
              border: '1px solid var(--gia-border)',
              color: showPrompts ? 'var(--gia-accent-contrast)' : 'var(--gia-text)',
              background: showPrompts ? 'var(--gia-accent)' : 'transparent',
            }}
            aria-pressed={showPrompts}
            aria-label="Agent prompts"
            title="Agent prompts"
          >
            <PenLine size={11} className="sm:hidden" />
            <span className="hidden sm:inline">Prompts</span>
          </button>
          <button
            onClick={() => { setShowCouncil(v => !v); setShowPrompts(false); }}
            className="h-7 px-2 sm:px-2.5 rounded-sm text-[11px] flex items-center gap-1"
            style={{
              border: '1px solid var(--gia-border)',
              color: showCouncil ? 'var(--gia-accent-contrast)' : 'var(--gia-text)',
              background: showCouncil ? 'var(--gia-accent)' : 'transparent',
            }}
            aria-pressed={showCouncil}
            aria-label="Council"
            title="Council"
          >
            <MessagesSquare size={11} className="sm:hidden" />
            <span className="hidden sm:inline">Council</span>
          </button>
          <button onClick={startFreshChat} className="p-1.5 rounded-md" style={{ color: 'var(--gia-muted)' }} aria-label="New chat" title="New chat"><Plus size={15} /></button>
          <div className="relative">
            <button
              onClick={() => setShowMoreMenu(o => !o)}
              className="p-1.5 rounded-md tap-feedback transition-colors"
              style={{ color: showMoreMenu ? 'var(--gia-text)' : 'var(--gia-muted)', background: showMoreMenu ? 'var(--gia-surface-2)' : 'transparent' }}
              aria-label="More actions"
              title="More"
            >
              <MoreHorizontal size={15} />
            </button>
            {showMoreMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} />
                <div
                  className="absolute right-0 top-9 z-50 w-52 rounded-md py-1 shadow-xl"
                  style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }}
                >
                  {[
                    { icon: <PanelRight size={13} />, label: 'Workspace panel', onClick: () => { setDockOpen(o => !o); setSidePanelOpen(!sidePanelOpen); setShowMoreMenu(false); } },
                    { icon: <Upload size={13} />, label: 'Files', onClick: () => { setShowFileManager(true); setShowMoreMenu(false); } },
                    { icon: <Brain size={13} />, label: 'Knowledge', onClick: () => { setShowKnowledge(true); setShowMoreMenu(false); } },
                    { icon: <Download size={13} />, label: 'Export chat', onClick: () => { exportChat(); setShowMoreMenu(false); } },
                    { icon: <Eye size={13} />, label: 'Toggle thoughts', onClick: () => { setShowThoughts(v => v.size > 0 ? new Set() : new Set(['all'])); setShowMoreMenu(false); } },
                    { icon: <History size={13} />, label: 'Chat history', onClick: () => { setShowHistory(true); setShowMoreMenu(false); } },
                    { icon: <Paperclip size={13} />, label: 'Attach a file', onClick: () => { fileRef.current?.click(); setShowMoreMenu(false); } },
                    { icon: <ImageIcon size={13} />, label: 'Photo', onClick: () => { imgRef.current?.click(); setShowMoreMenu(false); } },
                    { icon: <Sparkles size={13} />, label: 'Build studio', onClick: () => { setShowBuildStudio(true); setShowMoreMenu(false); } },
                    { icon: <Hammer size={13} />, label: buildMode ? 'Leave build' : 'Build an app', onClick: () => {
                      if (!forceBuild) {
                        const next = !buildModeStore;
                        setBuildMode(next);
                        useGiaStore.getState().updateSharedData({ currentMode: next ? 'build' : 'code' });
                      }
                      setShowMoreMenu(false);
                    } },
                  ].map(item => (
                    <button
                      key={item.label}
                      onClick={item.onClick}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-[12px]"
                      style={{ color: 'var(--gia-text)' }}
                    >
                      <span style={{ color: 'var(--gia-muted)' }}>{item.icon}</span>
                      {item.label}
                    </button>
                  ))}
                  <div
                    className="flex flex-wrap gap-1 px-3 py-2"
                    role="group"
                    aria-label="GIA mode"
                    data-testid="mode-picker"
                  >
                    {MODES.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          useGiaStore.getState().updateSharedData({ currentMode: m });
                          setBuildMode(m === 'build');
                          setShowMoreMenu(false);
                        }}
                        data-testid={`mode-${m}`}
                        aria-pressed={currentModeName === m}
                        className="px-2 py-1 rounded-lg text-[10px] font-medium"
                        style={{
                          background: currentModeName === m ? 'var(--gia-accent-dim)' : 'transparent',
                          color: currentModeName === m ? 'var(--gia-accent)' : 'var(--gia-muted)',
                          border: `1px solid ${currentModeName === m ? 'var(--gia-accent-glow)' : 'var(--gia-border)'}`,
                        }}
                        title={getModePromptName(m)}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {showPrompts && (
        <div className="absolute inset-0 top-12 z-20" style={{ background: 'var(--gia-bg)' }}>
          <AgentPrompts />
        </div>
      )}
      {showCouncil && !showPrompts && (
        <div className="absolute inset-0 top-12 z-20" style={{ background: 'var(--gia-bg)' }}>
          <Council initialPrompt={input} />
        </div>
      )}

      <div ref={scrollRef} onScroll={handleScroll} onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDragOver={handleDragOver} onDrop={handleDrop} className="flex-1 overflow-y-auto pt-4 relative z-0" style={{ paddingBottom: `${inputContainerHeight + 120}px` }}>
        {messages.length === 0 && buildMode && (
          <div className="flex flex-col items-center justify-center h-full gap-5 text-center pt-12 sm:pt-16 pb-24 sm:pb-40 animate-fade-in">
            <div className="w-16 h-16 rounded-lg flex items-center justify-center" style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border-2)' }}>
              <Hammer size={30} style={{ color: 'var(--gia-text)' }} />
            </div>
            <div>
              <p className="gia-display text-[28px] sm:text-[32px] leading-tight" style={{ color: 'var(--gia-text)' }}>Build Mode</p>
              <p className="text-xs mt-1 max-w-[260px] leading-relaxed" style={{ color: 'var(--gia-muted)' }}>Describe the app you want to build. GIA scaffolds it, runs a dev server, and a Preview button appears when it's live — tap it to see your app.</p>
            </div>
            <div className="grid grid-cols-1 gap-2 w-full max-w-xs mt-1">
              {[
                { label: 'To-do app', prompt: 'Build a simple to-do app with add, complete, and delete.' },
                { label: 'Quiz game', prompt: 'Build a quiz game with multiple-choice questions and a live score.' },
                { label: 'Landing page', prompt: 'Build a landing page for a fictional product with hero, features, and CTA.' },
              ].map((ex) => (
                <button key={ex.label} onClick={() => setInput(ex.prompt)} className="flex items-center gap-3 px-4 py-3 rounded-md text-left transition-colors tap-feedback" style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}>
                  <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--gia-surface-3)', border: '1px solid var(--gia-border)' }}><Hammer size={13} style={{ color: 'var(--gia-text)' }} /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold" style={{ color: 'var(--gia-text)' }}>{ex.label}</p>
                    <p className="text-[10px] truncate mt-0.5" style={{ color: 'var(--gia-muted)' }}>{ex.prompt}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.length === 0 && !buildMode && (
          <div className="relative flex flex-col items-center justify-center h-full gap-5 text-center px-6 pt-10 sm:pt-14 pb-24 sm:pb-40 animate-fade-in overflow-hidden gia-workspace-grid">
            <div className="relative">
              <div className="w-16 h-16 rounded-lg flex items-center justify-center"
                style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border-2)' }}>
                <GiaIcon size={28} animate={false} color="var(--gia-text)" />
              </div>
            </div>
            <div className="relative space-y-1.5">
              <p className="gia-display text-[28px] sm:text-[32px] leading-tight" style={{ color: 'var(--gia-text)' }}>
                {userProfile.name ? `Hey ${userProfile.name}` : 'Welcome to GIA'}
              </p>
              <p className="text-xs max-w-md leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
                Pick who you are talking to. Each bot keeps its own chat.
              </p>
            </div>
            {!providerConnected && (
              <div className="grid grid-cols-1 gap-2 w-full max-w-xs mt-1">
                <button onClick={() => setShowModelSwitcher(true)}
                  className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-md text-xs font-semibold transition-opacity tap-feedback hover:opacity-90"
                  style={{ background: 'var(--gia-accent)', color: 'var(--gia-accent-contrast)' }}>
                  <PlugZap size={15} /> Connect an AI Provider
                </button>
                <button onClick={() => { useProviderStore.getState().setProviderKey('local-llm', ''); }}
                  className="flex items-center justify-center gap-2 px-4 py-2 rounded-md text-[10px] transition-colors tap-feedback"
                  style={{ border: '1px dashed var(--gia-border-2)', color: 'var(--gia-muted)' }}>
                  <Zap size={12} color="var(--gia-muted)" /> Try Local AI — works offline, no keys
                </button>
                <div className="flex items-center justify-center gap-2 text-[9px] mt-0.5" style={{ color: 'var(--gia-muted-2)' }}>
                  <span className="flex items-center gap-1"><Plug size={10} color="var(--gia-muted-2)" />Provider</span>
                  <span className="opacity-40">→</span>
                  <span className="flex items-center gap-1"><KeyRound size={10} color="var(--gia-muted-2)" />Your key</span>
                  <span className="opacity-40">→</span>
                  <span className="flex items-center gap-1"><MessagesSquare size={10} color="var(--gia-muted-2)" />Chat</span>
                </div>
              </div>
            )}
            {providerConnected && (
              <>
                <p className="text-[11px] w-full max-w-2xl text-left" style={{ color: 'var(--gia-muted)' }}>Quick starts</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-2xl mt-1">
                  {QUICK_STARTS.map((qs, i) => (
                    <motion.button
                      key={qs.label}
                      onClick={() => { setInput(qs.prompt); focusComposer(); }}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.05, duration: 0.2 }}
                      whileHover={{ y: -1 }}
                      whileTap={{ scale: 0.99 }}
                      className="flex items-center gap-3 px-4 py-3.5 rounded-md text-left transition-colors shrink-0"
                      style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}
                    >
                      <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0" style={{ background: 'var(--gia-surface-3)', border: '1px solid var(--gia-border)' }}><qs.icon size={15} style={{ color: 'var(--gia-text)' }} /></div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold" style={{ color: 'var(--gia-text)' }}>{qs.label}</p>
                        <p className="text-[10px] truncate mt-0.5" style={{ color: 'var(--gia-muted)' }}>{qs.prompt}</p>
                      </div>
                    </motion.button>
                  ))}
                </div>
              </>
            )}
            <GiaBotRoster />
          </div>
        )}

        <div className="w-full px-1.5 space-y-2 sm:space-y-3">
        {activeSession && activeSession.currentBranchId && (
          <div className="mb-2">
            <SummaryBanner sessionId={activeSession.id} branchId={activeSession.currentBranchId} />
          </div>
        )}

        {sessions.length > 1 && (
          <div className="flex items-center gap-2 mb-1">
            <SessionSwitcher />
          </div>
        )}

        <AgentActivityStrip />
        <QueuedMessages />
        <UpdateBanner />

        <AgentSwarmDashboard />

        <MessageList
          messages={messages}
          loading={loading}
          streamingMsgId={streamingMsgId}
          streamingMsgIds={streamingMsgIds}
          expandedMsgs={expandedMsgs}
          setExpandedMsgs={setExpandedMsgs}
          showThoughts={showThoughts}
          setShowThoughts={setShowThoughts}
          liveThoughts={liveThoughts}
          liveSegments={liveSegments}
          thinkingPhase={thinkingPhase}
          currentTool={currentTool}
          responseTimesRef={responseTimesRef}
          onCopyMessage={copyMessage}
          onEdit={handleEditResend}
          onDeleteWithUndo={handleDeleteWithUndo}
          onContinue={handleContinue}
          onFork={handleFork}
          onRetry={handleRetry}
          onEditResend={handleEditResend}
          onRewrite={handleRewrite}
          onSuggestionClick={handleSuggestionClick}
          clarification={clarification}
          onClarificationFormAnswer={handleClarificationAnswer}
        />

        {/* Inline tool execution cards — show recent tools inline in the chat flow */}
        <RecentToolExecutions loading={loading} />

        {/* Build mode — live preview rendered inline as part of the response */}
        {buildMode && buildPreviewUrl && !showPreviewSheet && (
          <BuildInlinePreview url={buildPreviewUrl} onOpenFull={() => setShowPreviewSheet(true)} />
        )}

        {clarification && !clarification.fields && (
          <ClarificationBottomSheet
            clarification={clarification}
            clarAnswer={clarAnswer}
            setClarAnswer={setClarAnswer}
            handleClarificationAnswer={handleClarificationAnswer}
            loading={loading}
            onDismiss={() => setClarification(null)}
          />
        )}
        {createPortal(<ModelSwitcherSheet open={showModelSwitcher} onClose={() => setShowModelSwitcher(false)} />, document.body)}
        {createPortal(<ToolsCatalogSheet
          open={showToolsCatalog}
          onClose={() => setShowToolsCatalog(false)}
          onUse={(id, description) => {
            setShowToolsCatalog(false);
            setInput(`Use the ${id} tool${description ? ` (${description.split('.')[0].trim().toLowerCase()})` : ''} to `);
          }}
        />, document.body)}

        <AnimatePresence>
          {liveFileEdit && (
            <LiveFileEditor
              edit={liveFileEdit}
              onClose={() => setLiveFileEdit(null)}
            />
          )}
        </AnimatePresence>
        </div>
        {isDragging && (
          <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none" style={{ background: 'var(--gia-surface-2)' }}>
            <div className="flex flex-col items-center gap-2 px-6 py-4 rounded-md" style={{ background: 'var(--gia-surface)', border: '2px dashed var(--gia-border-2)' }}>
              <Paperclip size={20} style={{ color: 'var(--gia-text)' }} />
              <p className="text-xs font-medium" style={{ color: 'var(--gia-text)' }}>Drop files here</p>
            </div>
          </div>
        )}
      </div>

      <AnimatePresence>
        {showScrollBtn && (
          <motion.button initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} onClick={scrollToBottom} className="absolute right-4 bottom-32 w-8 h-8 rounded-full flex items-center justify-center shadow-lg z-10" style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}>
            <ChevronDown size={14} style={{ color: 'var(--gia-muted)' }} />
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {undoMsg && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="absolute left-4 right-4 bottom-28 z-20"
          >
            <div className="flex items-center gap-3 px-4 py-3 rounded-md shadow-2xl"
              style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border-2)' }}>
              <Trash2 size={13} style={{ color: '#f87171' }} />
              <span className="text-xs flex-1" style={{ color: 'var(--gia-text)' }}>Message deleted</span>
              <button onClick={handleUndoDelete}
                className="text-xs font-semibold flex items-center gap-1 px-3 py-1.5 rounded-md transition-colors"
                style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-text)', border: '1px solid var(--gia-border)' }}>
                <Undo2 size={11} /> Undo
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

        <div ref={inputContainerRef} onPaste={handlePaste} className="px-3 pb-4 pt-2 absolute bottom-3 left-3 right-3 z-10 rounded-xl border shadow-lg transition-all duration-300" style={{ background: 'var(--gia-surface)', borderColor: 'var(--gia-border)' }}>
        {showAgentMention && (
          <AgentMentionPicker
            query={agentMentionQuery}
            onSelect={handleAgentMentionSelect}
          />
        )}
        <input ref={fileRef} type="file" className="hidden" multiple onChange={e => handleFile(e)} accept=".txt,.md,.pdf,.csv,.json,.js,.ts,.tsx,.py,.html,.css,.xml,.yaml,.yml,.log,.env" />
        <input ref={imgRef} type="file" className="hidden" multiple accept="image/*" onChange={e => handleFile(e, true)} />

        {processingFiles && (
          <div className="flex items-center gap-2 mb-2.5 px-1">
            <Loader2 size={12} className="animate-spin shrink-0" style={{ color: 'var(--gia-muted)' }} />
            <span className="text-[10px] truncate" style={{ color: 'var(--gia-muted)' }}>
              Processing {processingFileName}...
            </span>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2.5">
            {attachments.map((att, idx) => (
              <div key={idx} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px]" style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}>
                {att.preview ? (
                  <div className="relative w-8 h-8 rounded-md overflow-hidden shrink-0">
                    <img src={att.preview} alt={att.name} className="w-full h-full object-cover" />
                  </div>
                ) : (
                  <Paperclip size={10} className="shrink-0" style={{ color: 'var(--gia-muted)' }} />
                )}
                <span className="truncate max-w-[100px]" style={{ color: 'var(--gia-text)' }}>{att.name}</span>
                <button
                  onClick={() => removeAttachment(idx)}
                  className="ml-0.5 transition-colors"
                  style={{ color: 'var(--gia-muted-2)' }}
                  aria-label={`Remove ${att.name}`}
                  title="Remove attachment"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1.5 mb-2.5">
          <button type="button"
            onClick={() => setShowTools(true)}
            className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors tap-feedback"
            style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)', color: 'var(--gia-muted)' }}
            aria-label="Tools"
            title="Tools"
          >
            <SlidersHorizontal size={14} />
          </button>

          {buildMode && sandboxEnvReady === false && (
            <button type="button" onClick={() => useGiaStore.getState().setModule('settings')} className="flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-md self-start transition-colors tap-feedback" style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-text)', border: '1px solid var(--gia-border)' }}>
              <Terminal size={11} />
              Set up sandbox to preview apps
            </button>
          )}
          {activeToolCount > 0 && (
            <span className="text-[10px] shrink-0 px-2 py-1 rounded-sm" style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-muted)', border: '1px solid var(--gia-border)' }}>
              {activeToolCount} active
            </span>
          )}
          {activeSkill && (
            <button
              onClick={() => setShowSkillPicker(true)}
              title={`Active skill: ${activeSkill.name}`}
              className="flex items-center gap-1 text-[10px] shrink-0 px-2 py-1 rounded-sm tap-feedback transition-colors"
              style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-text)', border: '1px solid var(--gia-border)' }}
            >
              <Sparkles size={10} />
              <span className="font-semibold max-w-[80px] truncate">{activeSkill.name}</span>
            </button>
          )}
        </div>

        <AmbientInput value={input} onChange={handleInputChange} onSubmit={handleSend} onStop={loading ? handleStop : undefined} isLoading={loading} onVoiceToggle={openVoice} isVoiceListening={voiceEnabled} placeholder={buildMode ? 'Describe the app. She scaffolds, runs it, and shows a preview.' : webSearch ? 'Ask. She searches, then answers with the source.' : handsOff ? 'She acts. Risky steps still stop for your yes.' : 'Tell her the outcome. She picks the tools.'} prefix={buildMode ? <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-sm font-medium shrink-0 mr-1" style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-text)', border: '1px solid var(--gia-border)' }}><Hammer size={10} />Build</span> : undefined} />
      </div>

      <AnimatePresence>
        {showSkillPicker && (
          <SkillPicker 
            skills={skills}
            activeSkillId={activeSkillId || 'core-general'}
            onSelect={(skillId) => {
              setSkill(skillId);
              setShowSkillPicker(false);
              setInput('');
              addNotification(`Skill active: ${skills.find((s: { id: string; name: string }) => s.id === skillId)?.name}`);
            }}
            onClose={() => setShowSkillPicker(false)}
          />
        )}
      </AnimatePresence>
      <BuildPreviewSheet url={buildPreviewUrl} open={showPreviewSheet} onClose={() => setShowPreviewSheet(false)} />
      <AnimatePresence>
        {showBuildStudio && (
          <BuildStudio
            onClose={() => setShowBuildStudio(false)}
            onStart={(brief) => {
              // Entering BUILD is part of the brief, not a separate toggle: the
              // studio already chose the model, theme and skill, so the request
              // should arrive with the mode already set.
              setBuildMode(true);
              useGiaStore.getState().updateSharedData({ currentMode: 'build' });
              sendText(brief);
            }}
          />
        )}
      </AnimatePresence>
      {showKnowledge && <KnowledgePanel onClose={() => setShowKnowledge(false)} />}
      {showFileManager && <FileManager onClose={() => setShowFileManager(false)} />}
      {showBranchView && activeSession && (
        <BranchView
          session={activeSession}
          messages={messages}
          onClose={() => setShowBranchView(false)}
        />
      )}
      <TemplateSelector
        isOpen={showTemplateSelector}
        onClose={() => setShowTemplateSelector(false)}
      />
      <CameraCaptureModal
        open={showCamera}
        onClose={() => setShowCamera(false)}
        onCapture={(dataUrl, name) => { setShowCamera(false); handleCameraCapture(dataUrl, name); }}
      />
      <AnimatePresence>
        {showVoiceMode && (
          <VoiceMode onClose={closeVoice} />
        )}
      </AnimatePresence>
    </div>

      {/* Workspace dock — terminal + files beside the conversation, so you
          watch GIA work without the two views fighting for the screen. */}
      {dockOpen && (
        <WorkspaceDock
          onClose={() => { setDockOpen(false); setSidePanelOpen(false); }}
          onExpandPreview={() => setShowPreviewSheet(true)}
        />
      )}
    </div>
  );
};

export default ChatModule;

const SearchActivityButton: React.FC = () => {
  const { queryCount, sources, panelOpen, setPanelOpen } = useSearchActivity();
  const total = queryCount + sources.length;
  if (total === 0) return null;
  return (
    <button
      onClick={() => setPanelOpen(!panelOpen)}
      className="p-1.5 rounded-lg tap-feedback shrink-0 relative"
      style={{ color: panelOpen ? 'var(--gia-text)' : 'var(--gia-muted)' }}
      aria-label={`Search activity (${total})`}
      aria-pressed={panelOpen}
      title={`Search Activity (${total})`}
    >
      <Globe size={13} />
      <span
        className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full"
        style={{ background: 'var(--gia-text)' }}
      />
    </button>
  );
};

const BuildInlinePreview: React.FC<{ url: string; onOpenFull: () => void }> = ({ url, onOpenFull }) => {
  const [refreshKey, setRefreshKey] = React.useState(0);
  return (
    <div className="mx-1 rounded-xl overflow-hidden" style={{ border: '1px solid var(--gia-border)', background: 'var(--gia-surface)' }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--gia-border)' }}>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--gia-success, #22c55e)' }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider shrink-0" style={{ color: 'var(--gia-text)' }}>Live preview</span>
        <span className="text-[10px] truncate flex-1 min-w-0" style={{ color: 'var(--gia-muted)' }}>{url}</span>
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          className="p-1.5 rounded-lg transition-colors hover:bg-white/10 active:bg-white/15 shrink-0"
          style={{ color: 'var(--gia-muted-2)' }}
          aria-label="Refresh preview"
          title="Refresh preview"
        >
          <RotateCcw size={12} />
        </button>
        <button
          onClick={onOpenFull}
          className="p-1.5 rounded-lg transition-colors hover:bg-white/10 active:bg-white/15 shrink-0"
          style={{ color: 'var(--gia-text)' }}
          aria-label="Open full preview"
          title="Open full preview"
        >
          <Maximize2 size={12} />
        </button>
      </div>
      <iframe
        key={refreshKey}
        src={url}
        title="GIA build preview"
        className="w-full"
        style={{ height: 240, border: 'none', background: '#fff', display: 'block' }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock"
      />
    </div>
  );
};

const RecentToolExecutions: React.FC<{ loading: boolean }> = ({ loading }) => {
  const consoleProtocols = useProtocolStore(s => s.consoleProtocols);

  if (consoleProtocols.length === 0) return null;

  const active = consoleProtocols.filter(p => p.state === 'executing' || p.state === 'proposed');
  const done = consoleProtocols.filter(p => p.state === 'completed' || p.state === 'failed' || p.state === 'rejected').slice(-6);

  if (done.length === 0 && active.length === 0) return null;

  const activeTray = loading && active.length > 0 ? <ToolTray protocols={active} /> : null;
  const doneTray = !loading && done.length > 0 ? <ToolTray protocols={done} /> : null;

  if (!activeTray && !doneTray) return null;

  return (
    <div className="space-y-2 px-1">
      {activeTray}
      {doneTray}
    </div>
  );
};
