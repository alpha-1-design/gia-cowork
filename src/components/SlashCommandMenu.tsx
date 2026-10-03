import React, { useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  MessageSquare, Cpu, Sparkles, Boxes, StickyNote, Settings, HelpCircle,
  Terminal, type LucideIcon,
} from 'lucide-react';
import { getCommandSuggestions, type CommandSpec, type CommandCategory } from '../services/SlashCommands';

/**
 * Slash command autocomplete.
 *
 * The command surface grew to ~50 commands, which is past the point where
 * anyone remembers them. This makes discovery a property of typing `/` rather
 * than of having read `/help` once.
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

interface SlashCommandMenuProps {
  /** Full composer text, including the leading slash. */
  input: string;
  /** Index of the highlighted row, owned by the composer so keyboard and mouse agree. */
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (command: CommandSpec) => void;
  /** Commands that would apply if run right now, for the footer hint. */
  footer?: React.ReactNode;
}

/**
 * The menu only owns itself while the composer is typing a *command name*.
 * Once the user types a space the arguments are free text — showing a
 * dropdown over `/note ` would be noise, not help.
 */
export function isCommandNameActive(input: string): boolean {
  const t = input.trimStart();
  if (!t.startsWith('/')) return false;
  return !t.includes(' ');
}

export function SlashCommandMenu({ input, activeIndex, onHover, onSelect, footer }: SlashCommandMenuProps) {
  const active = isCommandNameActive(input);

  const matches = useMemo(
    () => (active ? getCommandSuggestions(input.trimStart()) : []),
    [input, active],
  );

  // Reset the highlight when the result set changes underneath it, or the
  // Enter key would run whichever command happens to sit at that index.
  useEffect(() => {
    if (activeIndex >= matches.length) onHover(0);
  }, [matches.length, activeIndex, onHover]);

  return (
    <AnimatePresence>
      {active && matches.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.98 }}
          transition={{ duration: 0.14, ease: 'easeOut' }}
          className="absolute bottom-full left-0 right-0 mb-2 z-50 overflow-hidden rounded-2xl backdrop-blur-xl max-h-[280px] overflow-y-auto"
          style={{
            background: 'rgba(15,15,22,0.94)',
            border: '1px solid rgba(168,85,247,0.22)',
            boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          }}
        >
          {matches.map((c, i) => {
            const Icon = CATEGORY_ICON[c.category] ?? Terminal;
            const selected = i === activeIndex;
            return (
              <button
                key={c.name}
                type="button"
                // mousedown fires before the input loses focus, so the
                // composer keeps its cursor and value while we swap it.
                onMouseDown={e => { e.preventDefault(); onSelect(c); }}
                onMouseEnter={() => onHover(i)}
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
                      /{c.name}
                    </span>
                    {c.usage && (
                      <code className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--gia-overlay-2)', color: 'var(--gia-muted)' }}>
                        {c.usage.replace(/^\//, '')}
                      </code>
                    )}
                    {c.aliases?.length ? (
                      <span className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>
                        {c.aliases.map(a => `/${a}`).join(' ')}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--gia-muted)' }}>
                    {c.description}
                  </p>
                </div>
              </button>
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