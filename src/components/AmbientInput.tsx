import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Send, Loader2, Square, Mic, MicOff } from 'lucide-react';
import { SlashCommandMenu, isCommandNameActive } from './SlashCommandMenu';
import { getCommandSuggestions, getCommandByName, type CommandSpec } from '../services/SlashCommands';


interface AmbientInputProps {
  value: string;
  onChange: (val: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  onVoiceToggle?: () => void;
  isVoiceListening?: boolean;
  isVoiceRefining?: boolean;
  placeholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
  multiline?: boolean;
  autoFocus?: boolean;
  prefix?: React.ReactNode;
}

const AmbientInput: React.FC<AmbientInputProps> = ({
  value, onChange, onSubmit, onStop,
  onVoiceToggle, isVoiceListening, isVoiceRefining,
  placeholder = 'Message GIA…',
  disabled = false,
  isLoading = false,
  multiline = false,
  prefix,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Slash-command autocomplete. The menu is open only while the composer
  // holds a bare command name, so `/note my thing` does not get a popup
  // fighting the text the user is typing.
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const commandMenuOpen = isCommandNameActive(value) && !commandDismissed;
  const commandMatches = useMemo(
    () => (commandMenuOpen ? getCommandSuggestions(value.trimStart()) : []),
    [commandMenuOpen, value],
  );
  const commandActive = commandMenuOpen && commandMatches.length > 0;
  // When the text is already an exact command (the user typed `/help`, not a
  // prefix of it), Enter should run it rather than complete it — otherwise
  // completing a command you already finished by typing is an extra keypress
  // that looks like the app ignored you.
  const commandIsExact = commandMenuOpen && getCommandByName(value.trimStart()) !== undefined;

  const selectCommand = useCallback((c: CommandSpec) => {
    // Keep the space: a command with no argument can be sent straight away,
    // and one that takes arguments needs the cursor already in place.
    onChange(`/${c.name} `);
    setCommandIndex(0);
    setCommandDismissed(false);
  }, [onChange]);

  // Auto-resize textarea
  useEffect(() => {
    if (multiline && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [value, multiline]);

  const justPastedRef = useRef(false);

  const handlePasteCapture = () => {
    justPastedRef.current = true;
    // Some Android WebView keyboards emit a synthetic Enter keydown while
    // committing pasted multi-line text. Give that a moment to land before
    // trusting Enter again, so a paste can never masquerade as "send".
    setTimeout(() => { justPastedRef.current = false; }, 150);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (justPastedRef.current) return;

    // While a command name is being typed the arrow keys drive the menu
    // instead of moving a text cursor that has nothing to move.
    if (commandActive) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCommandIndex(i => (i + 1) % commandMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCommandIndex(i => (i - 1 + commandMatches.length) % commandMatches.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        selectCommand(commandMatches[commandIndex]);
        return;
      }
      if (e.key === 'Escape') {
        // Escape dismisses the menu without clearing what was typed — the
        // user may want to keep the text and just get the popup out of the way.
        e.preventDefault();
        e.stopPropagation();
        setCommandDismissed(true);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !commandIsExact) {
        e.preventDefault();
        selectCommand(commandMatches[commandIndex]);
        return;
      }
    }

    const isCmdEnter = e.key === 'Enter' && (e.metaKey || e.ctrlKey);
    const isPlainEnter = e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey;
    if (isPlainEnter || isCmdEnter) {
      e.preventDefault();
      if (!value.trim() || isLoading || disabled) return;
      onSubmit();
    }
  };

  const sharedInputProps = {
    'data-gia-composer': '',
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(e.target.value);
      setCommandIndex(0);
      setCommandDismissed(false);
    },
    onKeyDown: handleKeyDown,
    onPasteCapture: handlePasteCapture,
    placeholder,
    disabled: disabled || isLoading,
    autoComplete: 'on',
    autoCorrect: 'on',
    autoCapitalize: 'sentences' as const,
    spellCheck: true,
    inputMode: 'text' as const,
    style: {
      background: 'var(--gia-surface-2)',
      border: '1px solid var(--gia-border)',
      color: 'var(--gia-text)',
      borderRadius: '12px',
      transition: 'border-color 0.2s ease',
      caretColor: 'var(--gia-text)',
    },
  };

  const sendDisabled = !isLoading && (!value.trim() || disabled);
  const sendLabel = isLoading ? 'Stop generating' : 'Send message';

  return (
    <div className="relative w-full">
      <div className="relative flex items-end gap-2">
        <SlashCommandMenu
          input={value}
          activeIndex={commandIndex}
          onHover={setCommandIndex}
          onSelect={selectCommand}
          footer="↑↓ to navigate · Tab to complete · Enter to run"
        />
        {prefix && (
          <div className="absolute left-3 bottom-2.5 z-10 flex items-center">
            {prefix}
          </div>
        )}
        {multiline ? (
          <textarea
            ref={textareaRef}
            {...sharedInputProps}
            rows={1}
            className="flex-1 py-3 pl-11 pr-12 text-sm outline-none placeholder:opacity-40 resize-none"
            style={{
              ...sharedInputProps.style,
              minHeight: '48px',
              maxHeight: '120px',
              overflow: 'auto',
              overflowWrap: 'break-word',
              paddingLeft: prefix ? '60px' : undefined,
            }}
          />
        ) : (
          <input
            ref={inputRef}
            {...sharedInputProps}
            type="text"
            className="flex-1 py-3.5 pl-11 pr-14 text-sm outline-none placeholder:opacity-40"
            style={{ paddingLeft: prefix ? '60px' : undefined }}
          />
        )}

        {/* Mic button — delegates to parent voice control */}
        {onVoiceToggle && (
          <button
            type="button"
            onClick={onVoiceToggle}
            className="absolute left-1.5 bottom-1.5 w-9 h-9 rounded-md flex items-center justify-center transition-colors"
            style={{ color: isVoiceListening ? '#f87171' : 'var(--gia-muted)' }}
            aria-label={isVoiceListening ? 'Stop voice input' : 'Start voice input'}
            title={isVoiceListening ? 'Stop voice input' : 'Start voice input'}
          >
            {isVoiceListening ? <Mic size={17} className="animate-pulse" /> : <MicOff size={17} />}
          </button>
        )}

        {/* Refinement Indicator */}
        {isVoiceRefining && (
          <div className="absolute left-12 top-1 flex items-center gap-1.5 animate-pulse">
            <Loader2 size={10} className="animate-spin" style={{ color: 'var(--gia-muted)' }} />
            <span className="text-[8px] font-medium" style={{ color: 'var(--gia-muted)' }}>Polishing...</span>
          </div>
        )}

        {/* Send / Stop button */}
        <button
          type="button"
          onClick={isLoading && onStop ? onStop : onSubmit}
          disabled={sendDisabled}
          className="absolute right-2 bottom-2 w-9 h-9 rounded-md flex items-center justify-center transition-all disabled:opacity-30"
          style={{
            background: isLoading
              ? 'rgba(239, 68, 68, 0.8)'
              : value.trim()
              ? 'var(--gia-accent)'
              : 'var(--gia-surface-3)',
            color: isLoading
              ? '#ffffff'
              : value.trim()
              ? 'var(--gia-accent-contrast)'
              : 'var(--gia-muted)',
            transform: value.trim() || isLoading ? 'scale(1)' : 'scale(0.85)',
          }}
          aria-label={sendLabel}
          title={sendLabel}
        >
          {isLoading
            ? onStop
              ? <Square size={12} className="fill-current" />
              : <Loader2 size={14} className="animate-spin" />
            : <Send size={13} style={{ transform: 'translateX(1px)' }} />}
        </button>
      </div>
    </div>
  );
};

export default AmbientInput;
