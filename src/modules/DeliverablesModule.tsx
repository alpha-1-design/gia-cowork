import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Package, Code2, Image as ImageIcon, GitBranch, FileText, X, ArrowUpRight,
  Search, LayoutGrid,
} from 'lucide-react';
import { useGiaStore, type Artifact } from '../store/useGiaStore';
import ArtifactRenderer from '../components/ArtifactRenderer';

/**
 * Deliverables — everything GIA has made, in one place.
 *
 * Artifacts already live on the message that produced them, which is right for
 * reading a conversation but wrong for finding a thing later. This module is
 * the index: it walks every session (including hibernated ones), flattens the
 * artifacts off the active branch, and gives them a stable, filterable home.
 *
 * Deliberately not a new storage layer. If an artifact exists in a message it
 * appears here; if the message is deleted, it leaves. One source of truth.
 */

type Kind = 'html' | 'svg' | 'mermaid' | 'markdown' | 'image' | 'text';

interface Deliverable {
  key: string;
  artifact: Artifact;
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  timestamp: number;
}

const kindOf = (type: string): Kind => {
  const t = type.toLowerCase();
  if (t.includes('html')) return 'html';
  if (t.includes('svg')) return 'svg';
  if (t.includes('mermaid')) return 'mermaid';
  if (t.includes('markdown') || t === 'md') return 'markdown';
  if (t.startsWith('image/')) return 'image';
  return 'text';
};

const KIND_META: Record<Kind, { label: string; icon: React.ReactNode }> = {
  html: { label: 'Page', icon: <Code2 size={16} /> },
  svg: { label: 'Vector', icon: <ImageIcon size={16} /> },
  mermaid: { label: 'Diagram', icon: <GitBranch size={16} /> },
  markdown: { label: 'Document', icon: <FileText size={16} /> },
  image: { label: 'Image', icon: <ImageIcon size={16} /> },
  text: { label: 'Text', icon: <FileText size={16} /> },
};

const snippetFor = (artifact: Artifact): string => {
  const kind = kindOf(artifact.type);
  if (kind === 'svg') return 'Vector graphic';
  if (kind === 'image') return 'Image output';
  const raw = kind === 'html'
    ? artifact.content.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    : artifact.content;
  return raw.replace(/\s+/g, ' ').trim().slice(0, 160) || 'Empty artifact';
};

const formatDate = (ts: number) => {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const FILTERS: { id: 'all' | Kind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'html', label: 'Pages' },
  { id: 'svg', label: 'Vectors' },
  { id: 'mermaid', label: 'Diagrams' },
  { id: 'markdown', label: 'Documents' },
  { id: 'image', label: 'Images' },
  { id: 'text', label: 'Text' },
];

const DeliverablesModule: React.FC = () => {
  const { sessions, archivedSessions, getBranchMessages, setModule, setActiveSession } = useGiaStore();
  const [filter, setFilter] = useState<'all' | Kind>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Deliverable | null>(null);

  const deliverables = useMemo(() => {
    const all = [...sessions, ...archivedSessions];
    const out: Deliverable[] = [];
    for (const session of all) {
      const messages = getBranchMessages(session.id, session.currentBranchId);
      for (const message of messages) {
        if (!message.artifacts?.length) continue;
        for (const artifact of message.artifacts) {
          out.push({
            key: `${message.id}:${artifact.identifier}`,
            artifact,
            sessionId: session.id,
            sessionTitle: session.title,
            messageId: message.id,
            timestamp: message.timestamp,
          });
        }
      }
    }
    return out.sort((a, b) => b.timestamp - a.timestamp);
  }, [sessions, archivedSessions, getBranchMessages]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return deliverables.filter((item) => {
      if (filter !== 'all' && kindOf(item.artifact.type) !== filter) return false;
      if (!q) return true;
      return (
        item.artifact.title.toLowerCase().includes(q) ||
        item.sessionTitle.toLowerCase().includes(q) ||
        item.artifact.content.toLowerCase().includes(q)
      );
    });
  }, [deliverables, filter, query]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: deliverables.length };
    for (const item of deliverables) {
      const kind = kindOf(item.artifact.type);
      map[kind] = (map[kind] ?? 0) + 1;
    }
    return map;
  }, [deliverables]);

  const openInChat = (item: Deliverable) => {
    setActiveSession(item.sessionId);
    setModule('chat');
    setSelected(null);
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--gia-bg)' }}>
      <header className="shrink-0 px-5 md:px-7 pt-6 pb-4" style={{ borderBottom: '1px solid var(--gia-border)' }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Package size={14} style={{ color: 'var(--gia-muted)' }} />
              <span className="text-[9px] font-mono uppercase tracking-[0.18em]" style={{ color: 'var(--gia-muted-2)' }}>
                Workspace index
              </span>
            </div>
            <h1 className="gia-display text-[30px] leading-none" style={{ color: 'var(--gia-text)' }}>
              Deliverables
            </h1>
            <p className="text-[11px] mt-2 max-w-lg leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
              Pages, vectors, diagrams and documents GIA has produced across your sessions.
            </p>
          </div>
          <div className="relative w-full sm:w-64">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--gia-muted-2)' }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search deliverables…"
              className="w-full h-8 pl-8 pr-3 rounded-md text-[11px] outline-none"
              style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
              aria-label="Search deliverables"
            />
          </div>
        </div>

        <div className="flex items-center gap-1.5 mt-4 overflow-x-auto [&::-webkit-scrollbar]:hidden">
          {FILTERS.map((f) => {
            const active = filter === f.id;
            const count = counts[f.id] ?? 0;
            if (f.id !== 'all' && count === 0) return null;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className="h-6 px-2 rounded-sm text-[9px] font-semibold uppercase tracking-wider transition-colors shrink-0"
                style={{
                  background: active ? 'var(--gia-surface-3)' : 'transparent',
                  border: `1px solid ${active ? 'var(--gia-border-2)' : 'var(--gia-border)'}`,
                  color: active ? 'var(--gia-text)' : 'var(--gia-muted)',
                }}
                aria-pressed={active}
              >
                {f.label}
                <span className="ml-1.5 tabular-nums" style={{ color: 'var(--gia-muted-2)' }}>{count}</span>
              </button>
            );
          })}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 md:px-7 py-5">
        {visible.length === 0 ? (
          <div className="h-full min-h-[280px] flex flex-col items-center justify-center text-center px-6">
            <div
              className="w-12 h-12 rounded-md flex items-center justify-center mb-4"
              style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}
            >
              <LayoutGrid size={18} style={{ color: 'var(--gia-muted)' }} />
            </div>
            <h2 className="gia-display text-[24px] leading-tight" style={{ color: 'var(--gia-text)' }}>
              {deliverables.length === 0 ? 'Nothing delivered yet' : 'No matches'}
            </h2>
            <p className="text-[11px] mt-2 max-w-sm leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
              {deliverables.length === 0
                ? 'When GIA writes a page, draws a diagram or produces a document in chat, it will appear here — grouped, searchable and ready to open.'
                : 'Try a different filter or clear the search.'}
            </p>
            {deliverables.length === 0 && (
              <button
                type="button"
                onClick={() => setModule('chat')}
                className="mt-4 h-7 px-3 rounded-sm text-[10px] font-medium transition-colors"
                style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
              >
                Open chat
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {visible.map((item) => {
              const kind = kindOf(item.artifact.type);
              const meta = KIND_META[kind];
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setSelected(item)}
                  className="group text-left rounded-md overflow-hidden transition-colors"
                  style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--gia-border-2)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--gia-border)'; }}
                >
                  <div
                    className="h-20 flex items-center justify-between px-3"
                    style={{ background: 'var(--gia-surface-2)', borderBottom: '1px solid var(--gia-border)' }}
                  >
                    <div className="flex items-center gap-2" style={{ color: 'var(--gia-muted)' }}>
                      {meta.icon}
                      <span className="text-[9px] font-mono uppercase tracking-[0.14em]">{meta.label}</span>
                    </div>
                    <ArrowUpRight size={13} className="opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--gia-muted)' }} />
                  </div>
                  <div className="p-3">
                    <p className="text-[12px] font-medium truncate" style={{ color: 'var(--gia-text)' }}>
                      {item.artifact.title || 'Untitled'}
                    </p>
                    <p className="text-[10px] leading-relaxed mt-1 line-clamp-2 min-h-[2.6em]" style={{ color: 'var(--gia-muted)' }}>
                      {snippetFor(item.artifact)}
                    </p>
                    <div className="flex items-center justify-between gap-2 mt-2.5">
                      <span className="text-[9px] truncate" style={{ color: 'var(--gia-muted-2)' }}>
                        {item.sessionTitle}
                      </span>
                      <span className="text-[9px] shrink-0 tabular-nums" style={{ color: 'var(--gia-muted-2)' }}>
                        {formatDate(item.timestamp)}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <AnimatePresence>
        {selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[300] flex items-center justify-center p-4 md:p-8"
            style={{ background: 'rgba(0,0,0,0.62)' }}
            onClick={() => setSelected(null)}
            role="dialog"
            aria-modal="true"
            aria-label={selected.artifact.title}
          >
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-3xl max-h-[86vh] flex flex-col rounded-lg overflow-hidden"
              style={{ background: 'var(--gia-bg)', border: '1px solid var(--gia-border-2)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--gia-border)' }}>
                <div className="min-w-0">
                  <p className="text-[9px] font-mono uppercase tracking-[0.16em]" style={{ color: 'var(--gia-muted-2)' }}>
                    {KIND_META[kindOf(selected.artifact.type)].label} · {selected.artifact.type}
                  </p>
                  <h2 className="text-[15px] font-semibold truncate mt-1" style={{ color: 'var(--gia-text)' }}>
                    {selected.artifact.title || 'Untitled'}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                  style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-muted)' }}
                  aria-label="Close preview"
                >
                  <X size={13} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                <ArtifactRenderer
                  type={selected.artifact.type}
                  content={selected.artifact.content}
                  title={selected.artifact.title}
                />
              </div>

              <div className="flex items-center justify-between gap-3 px-4 py-2.5 shrink-0" style={{ borderTop: '1px solid var(--gia-border)' }}>
                <span className="text-[9px] truncate" style={{ color: 'var(--gia-muted-2)' }}>
                  From “{selected.sessionTitle}” · {formatDate(selected.timestamp)}
                </span>
                <button
                  type="button"
                  onClick={() => openInChat(selected)}
                  className="h-7 px-2.5 rounded-sm text-[10px] font-medium shrink-0"
                  style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
                >
                  Open in chat
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default DeliverablesModule;
