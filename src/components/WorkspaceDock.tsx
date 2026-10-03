import React, { useState, useRef, useCallback, useSyncExternalStore } from 'react';
import { browserSession } from '../services/browser/BrowserSession';
import { useGiaStore } from '../store/useGiaStore';
import { Terminal as TerminalIcon, Files, Globe, Monitor, X, PanelRightClose } from 'lucide-react';
import TerminalPanel from './TerminalPanel';
import FilesPanel from './FilesPanel';
import BrowserPanel from './BrowserPanel';
import { PreviewPanel } from './PreviewPanel';

type DockTab = 'terminal' | 'files' | 'browser' | 'preview';

const MIN_WIDTH = 280;
const MAX_WIDTH = 900;

interface WorkspaceDockProps {
  onClose: () => void;
  initialTab?: DockTab;
  /** Open the large preview sheet instead of docking the preview. */
  onExpandPreview?: () => void;
}

/**
 * Workspace dock — terminal and files beside the conversation.
 *
 * This is the primary desktop layout: you watch GIA work in the chat while
 * the command output and the file diffs stay visible next to it, instead of
 * the two fighting over the same screen as fullscreen overlays. The
 * fullscreen terminal is still reachable from the dock's expand affordance
 * for long-running sessions.
 */
const WorkspaceDock: React.FC<WorkspaceDockProps> = ({ onClose, initialTab = 'terminal', onExpandPreview }) => {
  const [tab, setTab] = useState<DockTab>(initialTab);
  const [width, setWidth] = useState(460);
  const [expanded, setExpanded] = useState(false);
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    e.preventDefault();
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return;
    // Dock is on the right, so width grows as the pointer moves left.
    const next = window.innerWidth - e.clientX;
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
  }, []);

  const endDrag = useCallback(() => {
    dragging.current = false;
  }, []);

  React.useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  return (
    <>
      {/* Resize handle */}
      {!expanded && (
        <div
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          className="w-1 cursor-col-resize shrink-0 select-none transition-colors group"
          style={{ background: 'var(--gia-border)' }}
          title="Drag to resize"
        >
          <div className="w-full h-full opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ background: 'linear-gradient(180deg, transparent, #a855f7, transparent)' }} />
        </div>
      )}

      <div
        className="shrink-0 flex flex-col min-w-0"
        style={{
          width: expanded ? '100%' : width,
          transition: dragging.current ? 'none' : 'width 0.15s ease',
          background: 'var(--gia-surface)',
          borderLeft: '1px solid var(--gia-border)',
        }}
      >
        {/* Tabs */}
        <div className="flex items-center gap-1 px-2 py-1.5 shrink-0" style={{ borderBottom: '1px solid var(--gia-border)' }}>
          <TabButton active={tab === 'terminal'} onClick={() => setTab('terminal')} icon={<TerminalIcon size={12} />} label="Terminal" color="#34d399" />
          <TabButton active={tab === 'files'} onClick={() => setTab('files')} icon={<Files size={12} />} label="Files" color="#3b82f6" />
          <BrowserTabButton active={tab === 'browser'} onClick={() => setTab('browser')} />
          <PreviewTabButton active={tab === 'preview'} onClick={() => setTab('preview')} />
          <div className="flex-1" />
          <button
            onClick={() => setExpanded(e => !e)}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--gia-muted)' }}
            title={expanded ? 'Dock to the side' : 'Expand'}
          >
            <PanelRightClose size={13} style={{ transform: expanded ? 'rotate(180deg)' : 'none' }} />
          </button>
          <button onClick={onClose} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--gia-muted)' }} title="Close panel">
            <X size={13} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0">
          {tab === 'terminal' && <TerminalPanel embedded onClose={onClose} />}
          {tab === 'browser' && <BrowserPanel />}
          {tab === 'preview' && <PreviewPanel onExpand={onExpandPreview} />}
          {tab === 'files' && (
            <FilesPanel onRunCommand={cmd => {
              // Hand the command to the terminal so git commands run where
              // output is visible, rather than being swallowed here.
              setTab('terminal');
              window.dispatchEvent(new CustomEvent('gia:run-terminal-command', { detail: cmd }));
            }} />
          )}
        </div>
      </div>
    </>
  );
};

/**
 * The browser tab shows how many pages the agent has open, and lights up when
 * there is something to look at. An empty browser is noise in the tab strip;
 * a browser with four live tabs is the single most useful thing to be able to
 * glance at, so it earns its place only when it has content.
 */
const BrowserTabButton: React.FC<{ active: boolean; onClick: () => void }> = ({ active, onClick }) => {
  const count = useSyncExternalStore(
    browserSession.subscribe,
    browserSession.listSnapshot,
    browserSession.listSnapshot,
  ).length;

  return (
    <button
      onClick={onClick}
      data-testid="dock-browser-tab"
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
      style={{
        background: active || count > 0 ? (active ? 'rgba(20,184,166,0.18)' : 'rgba(20,184,166,0.07)') : 'transparent',
        color: active || count > 0 ? '#14b8a6' : 'var(--gia-muted)',
        border: `1px solid ${active ? 'rgba(20,184,166,0.33)' : 'transparent'}`,
      }}
      title={count > 0 ? `${count} page${count === 1 ? '' : 's'} the agent has open` : 'GIA is not browsing right now'}
    >
      <Globe size={12} />
      Browser
      {count > 0 && (
        <span
          className="px-1 rounded text-[9px] font-bold"
          style={{ background: 'rgba(20,184,166,0.22)', color: '#14b8a6' }}
        >
          {count}
        </span>
      )}
    </button>
  );
};

/**
 * The preview tab only exists while something is actually being served.
 *
 * Same reasoning as the browser tab: an empty preview is a tab that leads
 * nowhere, so it earns its place only when there is a URL behind it.
 */
const PreviewTabButton: React.FC<{ active: boolean; onClick: () => void }> = ({ active, onClick }) => {
  const url = useGiaStore(s => s.buildPreviewUrl);
  if (!url) return null;

  return (
    <button
      onClick={onClick}
      data-testid="dock-preview-tab"
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
      style={{
        background: active ? 'rgba(34,197,94,0.18)' : 'rgba(34,197,94,0.07)',
        color: '#22c55e',
        border: `1px solid ${active ? 'rgba(34,197,94,0.33)' : 'transparent'}`,
      }}
      title="The running app, beside the terminal instead of over it"
    >
      <Monitor size={12} />
      Preview
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#22c55e' }} />
    </button>
  );
};

const TabButton: React.FC<{
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string; color: string;
}> = ({ active, onClick, icon, label, color }) => (
  <button
    onClick={onClick}
    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
    style={{
      background: active ? `${color}1f` : 'transparent',
      color: active ? color : 'var(--gia-muted)',
      border: `1px solid ${active ? `${color}33` : 'transparent'}`,
    }}
  >
    {icon}
    {label}
  </button>
);

export default WorkspaceDock;