import React, { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  MessageSquare, Cpu, Sparkles, Boxes, StickyNote, Settings, HelpCircle,
  Terminal, User, Zap, type LucideIcon,
} from 'lucide-react';
import type { CommandCategory } from '../services/SlashCommands';
import type { UnifiedComposerEntry } from '../services/UnifiedComposer';

/**
 * The unified composer menu (user mandate: ONE layer on "/").
 *
 * This used to be a slash-command-only autocomplete, while a SkillPicker
 * modal ALSO opened on exactly "/" and agents lived only behind "@" — one
 * intent, three surfaces. It now renders the merged entry list from
 * UnifiedComposer (personas → commands → skills, one filter, one keyboard
 * index) inline above the composer. The @-mention picker stays for "@",
 * which owns the richer task-draft flow.
 */

const CATEGORY_ICON: Record<CommandCategory, LucideIcon> = {
  'Chat & Sessions': MessageSquare,
  'Models & Providers': Cpu,
  'Capabilities': Sparkles,
  'Skills & Agents': Boxes,
  'MCP & Plugins': Terminal,
  'Notes, Memory & Tasks': StickyNote,
  'System': Settings,
  'Help': HelpCircle,
};

const GROUP_ICON: Record<string, LucideIcon> = {
  'Personas': User,
  'Skills': Zap,
};

const KIND_BADGE: Record<UnifiedComposerEntry['kind'], string> = {
  persona: '@',
  command: '/',
  skill: 'skill',
};

export function isCommandNameActive(input: string): boolean {
  const t = input.trimStart();
  if (!t.startsWith('/')) return false;
  return !t.includes(' ');
}

interface SlashCommandMenuProps {
  /** The merged entry list, computed by the composer (it owns keyboard nav). */
  entries: UnifiedComposerEntry[];
  /** Whether the menu should be open at all (bare command name being typed). */
  open: boolean;
  /** Index of the highlighted row, owned by the composer so keyboard and mouse agree. */
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (entry: UnifiedComposerEntry) => void;
  /** Hint text for the footer. */
  footer?: React.ReactNode;
}

export function SlashCommandMenu({ entries, open, activeIndex, onHover, onSelect, footer }: SlashCommandMenuProps) {
  // Reset the highlight when the result set changes underneath it, or the
  // Enter key would run whichever entry happens to sit at that index.
  useEffect(() => {
    if (activeIndex >= entries.length) onHover(0);
  }, [entries.length, activeIndex, onHover]);

  // Grouped for rendering, but the keyboard index is CONTINUOUS across
  // groups — arrowing down walks personas into commands into skills without
  // the section headers stealing a stop.
  const groups: { title: string; items: { entry: UnifiedComposerEntry; index: number }[] }[] = [];
  entries.forEach((entry, index) => {
    const last = groups[groups.length - 1];
    if (last && last.title === entry.group) last.items.push({ entry, index });
    else groups.push({ title: entry.group, items: [{ entry, index }] });
  });

  return (
    <AnimatePresence>
      {open && entries.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.98 }}
          transition={{ duration: 0.14, ease: 'easeOut' }}
          className="absolute bottom-full left-0 right-0 mb-2 z-50 overflow-hidden rounded-2xl backdrop-blur-xl max-h-[300px] overflow-y-auto"
          style={{
            background: 'rgba(15,15,22,0.94)',
            border: '1px solid rgba(168,85,247,0.22)',
            boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          }}
        >
          {groups.map((g) => {
            const GroupIcon = GROUP_ICON[g.title];
            return (
              <div key={g.title}>
                <div
                  className="flex items-center gap-1.5 px-3.5 pt-2 pb-1 text-[9px] uppercase tracking-[0.14em] font-semibold sticky top-0"
                  style={{ background: 'rgba(15,15,22,0.96)', color: 'var(--gia-muted-2)' }}
                >
                  {GroupIcon ? <GroupIcon size={10} /> : null}
                  {g.title}
                </div>
                {g.items.map(({ entry, index }) => {
                  const Icon = entry.kind === 'command'
                    ? (CATEGORY_ICON[entry.command!.category as CommandCategory] ?? Terminal)
                    : entry.kind === 'persona' ? User : Zap;
                  const selected = index === activeIndex;
                  return (
                    <button
                      key={`${entry.kind}:${entry.name}`}
                      type="button"
                      // mousedown fires before the input loses focus, so the
                      // composer keeps its cursor and value while we swap it.
                      onMouseDown={e => { e.preventDefault(); onSelect(entry); }}
                      onMouseEnter={() => onHover(index)}
                      className="w-full flex items-start gap-3 px-3.5 py-2.5 text-left transition-colors"
                      style={{ background: selected ? 'rgba(168,85,247,0.14)' : 'transparent' }}
                    >
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                        style={{
                          background: selected ? 'rgba(168,85,247,0.2)' : 'var(--gia-overlay-2)',
                        }}
                      >
                        <Icon size={13} style={{ color: selected ? '#a855f7' : 'var(--gia-muted)' }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="text-[13px] font-semibold" style={{ color: 'var(--gia-text)' }}>
                            {entry.kind === 'command' ? entry.name : entry.name}
                          </span>
                          <span
                            className="text-[8px] px-1 py-0.5 rounded font-bold uppercase tracking-wider"
                            style={{ background: 'var(--gia-overlay-2)', color: 'var(--gia-muted)' }}
                          >
                            {KIND_BADGE[entry.kind]}
                          </span>
                          {entry.kind === 'command' && entry.command?.usage && (
                            <code className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--gia-overlay-2)', color: 'var(--gia-muted)' }}>
                              {entry.command.usage.replace(/^\//, '')}
                            </code>
                          )}
                        </div>
                        <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--gia-muted)' }}>
                          {entry.description}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {footer && (
            <div
              className="px-3.5 py-2 text-[10px] border-t"
              style={{ borderColor: 'var(--gia-overlay-2)', color: 'var(--gia-muted)' }}
            >
              {footer}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
