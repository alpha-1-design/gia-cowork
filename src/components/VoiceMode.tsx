import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import { X, Mic, Volume2, VolumeX, ArrowUp, Square, AlertCircle, AudioLines } from 'lucide-react';
import { useGiaStore } from '../store/useGiaStore';
import { useProviderStore } from '../store/useProviderStore';
import GiaBrain from '../services/GiaBrain';
import ttsService from '../services/TTSService';
import { logger } from '../utils/logger';

type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Turn {
  id: string;
  role: 'user' | 'gia';
  text: string;
}

interface VoiceModeProps {
  onClose?: () => void;
}

const WAVE = [12, 22, 16, 26, 14];

function newId() {
  try { return crypto.randomUUID(); } catch { return `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
}

/**
 * VoiceMode — a conversation surface, not a dictation overlay.
 *
 * It uses the same session and agent as chat: the last turns are loaded as
 * context, and each spoken exchange is written back into the thread. That is
 * the difference between "voice input" and actually talking to the workspace
 * you already have open.
 */
export default function VoiceMode({ onClose }: VoiceModeProps) {
  const { toggleFullScreenMode, activeSkillId, voiceLanguage, skills } = useGiaStore();
  const { activeProvider, providers } = useProviderStore();
  const cfg = providers[activeProvider];
  const activeSkill = skills.find((s) => s.id === activeSkillId);

  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [turns, setTurns] = useState<Turn[]>(() => {
    const s = useGiaStore.getState();
    if (!s.activeSessionId) return [];
    const session = s.sessions.find((entry) => entry.id === s.activeSessionId);
    if (!session) return [];
    return s.getBranchMessages(session.id, session.currentBranchId)
      .filter((m) => !m.error && m.content.trim())
      .slice(-8)
      .map((m) => ({ id: m.id, role: m.role === 'user' ? 'user' : 'gia', text: m.content }));
  });
  const [interimText, setInterimText] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [autoMode, setAutoMode] = useState(true);
  const [muted, setMuted] = useState(false);
  // Opening voice mode is an explicit request to hear GIA. If speech output
  // was off in Settings, turn it on for this surface and put it back on close.
  const ttsWasEnabledRef = useRef(ttsService.isEnabled());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any | null>(null);
  const recRunningRef = useRef(false);
  const recSessionRef = useRef({ finalText: '', hasSpeech: false, committed: false });
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoListenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoRestartRef = useRef(true);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const phaseRef = useRef<VoicePhase>('idle');
  const mutedRef = useRef(muted);
  const autoModeRef = useRef(autoMode);
  const interimRef = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSendRef = useRef<(text: string) => Promise<any>>(async () => undefined);
  phaseRef.current = phase;
  mutedRef.current = muted;
  autoModeRef.current = autoMode;
  interimRef.current = interimText;

  const srSupported = useMemo(() => {
    if (typeof window === 'undefined') return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }, []);

  // ── Recognition ──────────────────────────────────────────────────────
  const stopListening = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (recognitionRef.current && recRunningRef.current) {
      recRunningRef.current = false;
      try { recognitionRef.current.abort(); } catch { try { recognitionRef.current.stop(); } catch { /* ignore */ } }
    }
  }, []);

  const retryRestart = useCallback(() => {
    if (retryTimerRef.current) return;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      if (!mountedRef.current || recRunningRef.current || phaseRef.current !== 'listening' || !autoRestartRef.current) return;
      recRunningRef.current = true;
      try { recognitionRef.current?.start(); } catch { recRunningRef.current = false; retryRestart(); }
    }, 160);
  }, []);

  const commit = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) { setPhase('idle'); return; }
    recSessionRef.current.committed = true;
    stopListening();
    setInterimText('');
    void handleSendRef.current(clean);
  }, [stopListening]);

  const startListening = useCallback(() => {
    if (!mountedRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setError('Speech recognition is not available in this environment. Type below instead.');
      inputRef.current?.focus();
      return;
    }

    if (!recognitionRef.current) {
      const sr = new SR();
      sr.continuous = true;
      sr.interimResults = true;
      sr.maxAlternatives = 1;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sr.onresult = (event: any) => {
        if (!mountedRef.current) return;
        const session = recSessionRef.current;
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0]?.transcript ?? '';
          if (result.isFinal) {
            session.finalText += (session.finalText ? ' ' : '') + text;
            session.hasSpeech = true;
          } else {
            interim += (interim ? ' ' : '') + text;
          }
        }
        if (interim) setInterimText(interim);
        if (session.hasSpeech || interim) {
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = setTimeout(() => {
            if (!mountedRef.current || session.committed) return;
            commit(session.finalText || interimRef.current);
          }, 1600);
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sr.onerror = (e: any) => {
        if (!mountedRef.current) return;
        const err = e as { error?: string };
        if (err.error === 'no-speech' || err.error === 'aborted') {
          const session = recSessionRef.current;
          if (session.finalText && !session.committed) commit(session.finalText);
          else retryRestart();
          return;
        }
        if (err.error === 'not-allowed' || err.error === 'service-not-allowed') {
          autoRestartRef.current = false;
          setError('Microphone permission was denied. Type below, or allow the mic in your system settings.');
          setPhase('idle');
          return;
        }
        logger.warn('[VoiceMode] Speech error:', err.error);
        retryRestart();
      };

      sr.onend = () => {
        if (!mountedRef.current) return;
        recRunningRef.current = false;
        const session = recSessionRef.current;
        if (session.finalText && !session.committed && phaseRef.current === 'listening') {
          commit(session.finalText);
          return;
        }
        if (autoRestartRef.current && phaseRef.current === 'listening') retryRestart();
      };

      recognitionRef.current = sr;
    }

    recognitionRef.current.lang = voiceLanguage || 'en-US';
    recSessionRef.current = { finalText: '', hasSpeech: false, committed: false };
    setPhase('listening');
    setInterimText('');
    setError(null);

    recRunningRef.current = true;
    try {
      recognitionRef.current.start();
    } catch {
      recRunningRef.current = false;
    }
  }, [commit, retryRestart, voiceLanguage]);

  // ── Generation ───────────────────────────────────────────────────────
  const scheduleAutoListen = useCallback(() => {
    if (autoListenTimerRef.current) clearTimeout(autoListenTimerRef.current);
    autoListenTimerRef.current = setTimeout(() => {
      autoListenTimerRef.current = null;
      if (!mountedRef.current || !autoModeRef.current) return;
      autoRestartRef.current = true;
      startListening();
    }, 500);
  }, [startListening]);

  const handleSend = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean || busyRef.current) return;
    busyRef.current = true;
    autoRestartRef.current = false;
    setPhase('thinking');
    setError(null);
    setInterimText('');

    const store = useGiaStore.getState();
    const sessionId = store.activeSessionId ?? store.createSession();
    const session = useGiaStore.getState().sessions.find((entry) => entry.id === sessionId);
    const history = session
      ? store.getBranchMessages(session.id, session.currentBranchId)
          .filter((m) => !m.error && m.content.trim())
          .slice(-12)
          .map((m) => ({ role: m.role, content: m.content }))
      : [];

    store.addMessage(sessionId, {
      id: newId(),
      role: 'user',
      content: clean,
      timestamp: Date.now(),
    });
    if (session && session.title === 'New Chat') {
      store.updateSessionTitle(sessionId, clean.slice(0, 42));
    }
    setTurns((prev) => [...prev, { id: newId(), role: 'user', text: clean }]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await GiaBrain.generate({
        prompt: clean,
        history,
        systemPrompt: `You are GIA, speaking in voice mode. The user is talking to you directly. Be conversational, concise, and natural — like a knowledgeable friend. Keep responses under 3 sentences unless the user asked for detail. No markdown, no bullet points, no headers — just natural spoken language. ${activeSkill ? `Active skill: ${activeSkill.name}.` : ''}`,
        signal: controller.signal,
      });

      if (!mountedRef.current || controller.signal.aborted) return;

      const reply = res.text.trim() || 'I did not get a response. Try that again.';
      store.addMessage(sessionId, {
        id: newId(),
        role: 'assistant',
        content: reply,
        timestamp: Date.now(),
        model: res.model || cfg?.model,
      });
      setTurns((prev) => [...prev, { id: newId(), role: 'gia', text: reply }]);
      setPhase('speaking');

      if (!mutedRef.current) {
        try { await ttsService.speakFinal(reply); } catch (e) { logger.warn('[VoiceMode] Speech failed:', e); }
      }
      if (!mountedRef.current || controller.signal.aborted) return;

      if (autoModeRef.current) scheduleAutoListen();
      else setPhase('idle');
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return;
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : 'Generation failed');
      setPhase('idle');
    } finally {
      busyRef.current = false;
      abortRef.current = null;
    }
  }, [activeSkill, cfg?.model, scheduleAutoListen]);

  handleSendRef.current = handleSend;

  const stopAll = useCallback(() => {
    autoRestartRef.current = false;
    stopListening();
    if (autoListenTimerRef.current) {
      clearTimeout(autoListenTimerRef.current);
      autoListenTimerRef.current = null;
    }
    ttsService.stop();
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    setInterimText('');
    setPhase('idle');
  }, [stopListening]);

  const close = useCallback(() => {
    stopAll();
    if (onClose) onClose();
    else toggleFullScreenMode();
  }, [onClose, stopAll, toggleFullScreenMode]);

  // ── Primary control ──────────────────────────────────────────────────
  const primary = useCallback(() => {
    if (phase === 'listening') {
      autoRestartRef.current = false;
      const text = recSessionRef.current.finalText || interimRef.current;
      if (text.trim()) commit(text);
      else { stopListening(); setPhase('idle'); }
      return;
    }
    if (phase === 'thinking') { stopAll(); return; }
    if (phase === 'speaking') {
      ttsService.stop();
      autoRestartRef.current = true;
      startListening();
      return;
    }
    if (!srSupported) {
      setError('Speech recognition is not available in this environment. Type below instead.');
      inputRef.current?.focus();
      return;
    }
    autoRestartRef.current = true;
    startListening();
  }, [phase, commit, stopAll, stopListening, startListening, srSupported]);

  // ── Lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    if (!ttsWasEnabledRef.current) ttsService.setEnabled(true);
    return () => {
      mountedRef.current = false;
      autoRestartRef.current = false;
      stopListening();
      if (autoListenTimerRef.current) clearTimeout(autoListenTimerRef.current);
      abortRef.current?.abort();
      ttsService.stop();
      if (!ttsWasEnabledRef.current) ttsService.setEnabled(false);
    };
  }, [stopListening]);

  // Keep the newest turn in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [turns, interimText, phase]);

  // Esc closes; Space toggles the mic when focus is not in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.code !== 'Space' || e.repeat) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      e.preventDefault();
      primary();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, primary]);

  const submitDraft = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    autoRestartRef.current = false;
    if (phase === 'listening') stopListening();
    void handleSend(text);
  }, [draft, phase, stopListening, handleSend]);

  const phaseLabel = {
    idle: srSupported ? 'Tap to speak' : 'Type to talk',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking',
  }[phase];

  const modelLabel = cfg?.model?.split('/').pop() || 'GIA';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[300] flex flex-col"
      style={{ background: 'var(--gia-bg)' }}
      data-testid="voice-mode"
    >
      <header
        className="flex items-center justify-between gap-3 px-4 h-12 shrink-0"
        style={{ borderBottom: '1px solid var(--gia-border)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <AudioLines size={14} style={{ color: 'var(--gia-muted)' }} />
          <span className="text-[12px] font-semibold" style={{ color: 'var(--gia-text)' }}>Voice</span>
          <span className="text-[10px] truncate" style={{ color: 'var(--gia-muted-2)' }}>· {modelLabel}</span>
          {activeSkill && (
            <span className="hidden sm:inline text-[9px] px-1.5 py-0.5 rounded-sm truncate max-w-[140px]" style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-muted)', border: '1px solid var(--gia-border)' }}>
              {activeSkill.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              setAutoMode((on) => {
                if (on && autoListenTimerRef.current) {
                  clearTimeout(autoListenTimerRef.current);
                  autoListenTimerRef.current = null;
                }
                return !on;
              });
            }}
            aria-pressed={autoMode}
            className="h-7 px-2 rounded-md text-[9px] font-semibold tracking-wide transition-colors"
            style={{
              background: autoMode ? 'var(--gia-surface-3)' : 'transparent',
              color: autoMode ? 'var(--gia-text)' : 'var(--gia-muted-2)',
              border: `1px solid ${autoMode ? 'var(--gia-border-2)' : 'var(--gia-border)'}`,
            }}
            title={autoMode ? 'Auto-listen after GIA speaks' : 'Manual turn-taking'}
          >
            AUTO
          </button>
          <button
            type="button"
            onClick={() => { ttsService.stop(); setMuted((m) => !m); }}
            className="w-7 h-7 rounded-md flex items-center justify-center transition-colors"
            style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: muted ? 'var(--gia-muted-2)' : 'var(--gia-text)' }}
            aria-label={muted ? 'Unmute voice output' : 'Mute voice output'}
            title={muted ? 'Unmute voice output' : 'Mute voice output'}
          >
            {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
          </button>
          <button
            type="button"
            onClick={close}
            className="w-7 h-7 rounded-md flex items-center justify-center transition-colors"
            style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-muted)' }}
            aria-label="Close voice mode"
            title="Close voice mode (Esc)"
          >
            <X size={12} />
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-2xl mx-auto space-y-5">
          {turns.length === 0 && !interimText && (
            <div className="flex flex-col items-center justify-center text-center py-16">
              <div className="w-12 h-12 rounded-lg flex items-center justify-center mb-4" style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}>
                <AudioLines size={20} style={{ color: 'var(--gia-muted)' }} />
              </div>
              <h2 className="gia-display text-[26px] leading-tight" style={{ color: 'var(--gia-text)' }}>
                Talk to GIA
              </h2>
              <p className="text-[11px] mt-2 max-w-sm leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
                {srSupported
                  ? 'Speak naturally. The conversation stays in this thread, so you can pick it up in chat later.'
                  : 'This environment has no speech recognition, but you can type below and GIA will answer out loud.'}
              </p>
            </div>
          )}

          {turns.map((turn) => (
            <div key={turn.id} className={turn.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={turn.role === 'user' ? 'max-w-[85%]' : 'max-w-[90%]'}>
                {turn.role === 'gia' && (
                  <p className="text-[9px] font-mono uppercase tracking-[0.14em] mb-1.5" style={{ color: 'var(--gia-muted-2)' }}>GIA</p>
                )}
                <div
                  className="px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap"
                  style={turn.role === 'user'
                    ? { background: 'var(--gia-surface-3)', color: 'var(--gia-text)', border: '1px solid var(--gia-border)', borderRadius: 'var(--gia-radius-lg)' }
                    : { color: 'var(--gia-text)' }}
                >
                  {turn.text}
                </div>
              </div>
            </div>
          ))}

          {interimText && (
            <div className="flex justify-end">
              <div className="max-w-[85%] px-3.5 py-2.5 text-[13px] leading-relaxed" style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-muted)', border: '1px dashed var(--gia-border-2)', borderRadius: 'var(--gia-radius-lg)' }}>
                {interimText}
                <span className="inline-block w-1 h-3 ml-1 align-middle animate-pulse" style={{ background: 'var(--gia-text)' }} />
              </div>
            </div>
          )}

          {phase === 'thinking' && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 px-1 py-1">
                <motion.span
                  className="w-1.5 h-1.5 rounded-full"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
                  style={{ background: 'var(--gia-text)' }}
                />
                <span className="text-[11px]" style={{ color: 'var(--gia-muted)' }}>Thinking…</span>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md" style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}>
              <AlertCircle size={13} className="shrink-0 mt-0.5" style={{ color: 'var(--gia-muted)' }} />
              <p className="text-[11px] leading-relaxed" style={{ color: 'var(--gia-muted)' }}>{error}</p>
            </div>
          )}
        </div>
      </div>

      <footer className="shrink-0 px-4 pb-5 pt-3" style={{ borderTop: '1px solid var(--gia-border)' }}>
        <div className="max-w-2xl mx-auto">
          <div className="flex flex-col items-center gap-2 mb-4">
            <motion.button
              type="button"
              onClick={primary}
              className="w-14 h-14 rounded-lg flex items-center justify-center transition-colors"
              whileTap={{ scale: 0.96 }}
              style={{
                background: phase === 'listening' || phase === 'speaking' ? 'var(--gia-accent)' : 'var(--gia-surface-2)',
                color: phase === 'listening' || phase === 'speaking' ? 'var(--gia-accent-contrast)' : 'var(--gia-text)',
                border: '1px solid var(--gia-border-2)',
              }}
              aria-label={
                phase === 'listening' ? 'Send what you said'
                  : phase === 'thinking' ? 'Stop generating'
                    : phase === 'speaking' ? 'Interrupt and listen'
                      : 'Start listening'
              }
              title={phase === 'listening' ? 'Send (Space)' : phase === 'thinking' ? 'Stop' : phase === 'speaking' ? 'Interrupt' : 'Speak (Space)'}
            >
              {phase === 'listening' || phase === 'speaking' ? (
                <div className="flex items-center gap-[3px]">
                  {WAVE.map((height, i) => (
                    <motion.span
                      key={i}
                      className="w-[3px] rounded-full"
                      animate={{ height: [6, height, 6] }}
                      transition={{ duration: 0.6 + i * 0.06, repeat: Infinity, ease: 'easeInOut', delay: i * 0.07 }}
                      style={{ background: 'currentColor', minHeight: 4 }}
                    />
                  ))}
                </div>
              ) : phase === 'thinking' ? (
                <Square size={16} />
              ) : (
                <Mic size={20} />
              )}
            </motion.button>
            <div className="text-center">
              <p className="text-[10px] font-medium" style={{ color: 'var(--gia-text)' }}>{phaseLabel}</p>
              <p className="text-[9px] mt-0.5" style={{ color: 'var(--gia-muted-2)' }}>
                {phase === 'listening' ? 'Tap again to send · pauses send automatically'
                  : phase === 'thinking' ? 'Tap to stop'
                    : phase === 'speaking' ? 'Tap to interrupt'
                      : 'Space to speak · Esc to close'}
              </p>
            </div>
          </div>

          <form onSubmit={submitDraft} className="flex items-center gap-2">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type instead…"
              className="flex-1 h-9 px-3 rounded-md text-[12px] outline-none"
              style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-text)', border: '1px solid var(--gia-border)' }}
              aria-label="Type a message instead of speaking"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              className="w-9 h-9 rounded-md flex items-center justify-center transition-opacity disabled:opacity-30"
              style={{ background: 'var(--gia-accent)', color: 'var(--gia-accent-contrast)' }}
              aria-label="Send typed message"
              title="Send"
            >
              <ArrowUp size={15} />
            </button>
          </form>
        </div>
      </footer>
    </motion.div>
  );
}
