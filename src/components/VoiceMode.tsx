import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import { X, Mic, Volume2, VolumeX, ArrowUp, Square, AlertCircle, AudioLines } from 'lucide-react';
import { useGiaStore } from '../store/useGiaStore';
import { useProviderStore } from '../store/useProviderStore';
import GiaBrain from '../services/GiaBrain';
import ttsService from '../services/TTSService';
import { voiceSession, type VoiceSnapshot } from '../services/voice/VoiceSession';
import AiOrb from './ui/ai-orb';
import { logger } from '../utils/logger';

type EnginePhase = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Turn {
  id: string;
  role: 'user' | 'gia';
  text: string;
}

interface VoiceModeProps {
  onClose?: () => void;
}

function newId() {
  try { return crypto.randomUUID(); } catch { return `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
}

/** Map the VoiceSession machine onto the engine phases the UI understands. */
function phaseOf(snapshot: VoiceSnapshot | null): EnginePhase {
  if (!snapshot) return 'idle';
  switch (snapshot.phase) {
    case 'listening':
    case 'capturing':
      return 'listening';
    case 'transcribing':
    case 'thinking':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    default:
      return 'idle';
  }
}

/** The AiOrb state for the session machine — mouth and hands as one orb. */
function orbStateOf(snapshot: VoiceSnapshot | null): Parameters<typeof AiOrb>[0]['state'] {
  if (!snapshot) return 'idle';
  if (snapshot.error && snapshot.phase === 'idle') return 'error';
  switch (snapshot.phase) {
    case 'listening': return 'listening';
    case 'capturing': return 'listening';
    case 'transcribing': return 'thinking';
    case 'thinking': return snapshot.working ? 'reasoning' : 'thinking';
    case 'speaking': return 'streaming';
    default: return 'idle';
  }
}

/**
 * VoiceMode — a conversation surface, not a dictation overlay.
 *
 * The engine is `VoiceSession` (local VAD + local whisper, GiaBrain stays
 * the brain): you talk, the orb listens, she answers out loud, everything
 * lands in the active chat thread with a 🎙 badge. The older browser
 * SpeechRecognition path remains as the fallback when the local engine
 * can't run (no mic, non-English language, whisper unavailable).
 *
 * The orb is the state machine: it shows what she is doing in one way —
 * listening (waveform), thinking (orbiting work), speaking (composing
 * sash), reasoning (she's thinking AND working).
 */
export default function VoiceMode({ onClose }: VoiceModeProps) {
  const { toggleFullScreenMode, activeSkillId, voiceLanguage, skills } = useGiaStore();
  const { activeProvider, providers } = useProviderStore();
  const cfg = providers[activeProvider];
  const activeSkill = skills.find((s) => s.id === activeSkillId);

  const [engine, setEngine] = useState<'local' | 'speech' | 'failed'>('local');
  const [snapshot, setSnapshot] = useState<VoiceSnapshot | null>(null);
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

  // ── Web Speech fallback state ────────────────────────────────────────
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
  const speechListeningRef = useRef(false);
  const mutedRef = useRef(muted);
  const autoModeRef = useRef(autoMode);
  const interimRef = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSendRef = useRef<(text: string) => Promise<any>>(async () => undefined);
  mutedRef.current = muted;
  autoModeRef.current = autoMode;
  interimRef.current = interimText;

  const srSupported = useMemo(() => {
    if (typeof window === 'undefined') return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }, []);

  // ── Local engine (VoiceSession) ──────────────────────────────────────
  const localAvailable = useMemo(() => {
    return typeof navigator !== 'undefined'
      && Boolean(navigator.mediaDevices?.getUserMedia)
      && (voiceLanguage || 'en-US').toLowerCase().startsWith('en');
  }, [voiceLanguage]);

  const openLocal = useCallback(async (): Promise<boolean> => {
    if (!localAvailable) return false;
    try {
      await voiceSession.open({
        systemPromptTail: activeSkill ? `Active skill: ${activeSkill.name}.` : '',
        auto: true,
      });
      return true;
    } catch (e) {
      logger.warn('[VoiceMode] local engine unavailable:', e);
      setError(e instanceof Error ? e.message : null);
      return false;
    }
  }, [activeSkill, localAvailable]);

  // ── Web Speech fallback ──────────────────────────────────────────────
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
      speechListeningRef.current = false;
      try { recognitionRef.current.abort(); } catch { try { recognitionRef.current.stop(); } catch { /* ignore */ } }
    }
  }, []);

  const retryRestart = useCallback(() => {
    if (retryTimerRef.current) return;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      if (!mountedRef.current || recRunningRef.current || engine !== 'speech' || !autoRestartRef.current) return;
      recRunningRef.current = true;
      try { recognitionRef.current?.start(); } catch { recRunningRef.current = false; retryRestart(); }
    }, 160);
  }, [engine]);

  const commit = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) { return; }
    recSessionRef.current.committed = true;
    stopListening();
    setInterimText('');
    void handleSendRef.current(clean);
  }, [stopListening]);

  const startSpeechListening = useCallback(() => {
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
          return;
        }
        logger.warn('[VoiceMode] Speech error:', err.error);
        retryRestart();
      };

      sr.onend = () => {
        if (!mountedRef.current) return;
        recRunningRef.current = false;
        const session = recSessionRef.current;
        if (speechListeningRef.current && session.finalText && !session.committed) {
          commit(session.finalText);
          return;
        }
        if (autoRestartRef.current && engine === 'speech' && speechListeningRef.current) retryRestart();
      };

      recognitionRef.current = sr;
    }

    recognitionRef.current.lang = voiceLanguage || 'en-US';
    recSessionRef.current = { finalText: '', hasSpeech: false, committed: false };
    speechListeningRef.current = true;
    setInterimText('');
    setError(null);

    recRunningRef.current = true;
    try {
      recognitionRef.current.start();
    } catch {
      recRunningRef.current = false;
    }
  }, [commit, retryRestart, voiceLanguage, engine]);

  // ── Typed sends (both engines) ───────────────────────────────────────
  const scheduleAutoListen = useCallback(() => {
    if (autoListenTimerRef.current) clearTimeout(autoListenTimerRef.current);
    autoListenTimerRef.current = setTimeout(() => {
      autoListenTimerRef.current = null;
      if (!mountedRef.current || !autoModeRef.current) return;
      if (engine === 'local') voiceSession.startListening();
      else { autoRestartRef.current = true; startSpeechListening(); }
    }, 500);
  }, [engine, startSpeechListening]);

  const handleSend = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean || busyRef.current) return;
    busyRef.current = true;
    autoRestartRef.current = false;
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

      if (!mutedRef.current) {
        try { await ttsService.speakFinal(reply); } catch (e) { logger.warn('[VoiceMode] Speech failed:', e); }
      }
      if (!mountedRef.current || controller.signal.aborted) return;

      if (autoModeRef.current) scheduleAutoListen();
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return;
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      busyRef.current = false;
      abortRef.current = null;
    }
  }, [activeSkill, cfg?.model, scheduleAutoListen]);

  handleSendRef.current = handleSend;

  // ── Lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    if (!ttsWasEnabledRef.current) ttsService.setEnabled(true);

    if (engine === 'local' && !snapshot) {
      let cancelled = false;
      void (async () => {
        const ok = await openLocal();
        if (cancelled) { if (ok) voiceSession.close(); return; }
        if (!ok) {
          // Fall back to the browser recognizer if the platform has one;
          // otherwise stay on typed input.
          if (srSupported) setEngine('speech');
          else setEngine('failed');
        }
      })();
      return () => { cancelled = true; };
    }
    return () => {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Local engine subscription.
  useEffect(() => {
    if (engine !== 'local') return;
    const off = voiceSession.subscribe((snap) => {
      setSnapshot(snap);
      if (snap.error) setError(snap.error);
      if (snap.phase === 'capturing') setInterimText('');
    });
    voiceSession.onUserUtterance = (text) => {
      setInterimText('');
      setTurns((prev) => [...prev, { id: newId(), role: 'user', text }]);
    };
    voiceSession.onAssistantReply = (reply) => {
      setTurns((prev) => [...prev, { id: newId(), role: 'gia', text: reply }]);
    };
    return () => {
      off();
      voiceSession.onUserUtterance = null;
      voiceSession.onAssistantReply = null;
    };
  }, [engine]);

  const phase = engine === 'local' ? phaseOf(snapshot) : 'idle';

  // Cleanup on unmount: stop whichever engine ran.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      autoRestartRef.current = false;
      stopListening();
      if (autoListenTimerRef.current) clearTimeout(autoListenTimerRef.current);
      abortRef.current?.abort();
      ttsService.stop();
      voiceSession.close();
      if (!ttsWasEnabledRef.current) ttsService.setEnabled(false);
    };
  }, [stopListening]);

  // Keep the newest turn in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [turns, interimText, phase]);

  // Esc closes; Space toggles the mic when focus is not in a field.
  const primary = useCallback(() => {
    if (engine === 'local') {
      if (snapshot?.phase === 'capturing') { void voiceSession.endpointNow(); return; }
      if (snapshot?.phase === 'listening') { voiceSession.close(); setEngine('failed'); setError(null); return; }
      if (snapshot?.phase === 'thinking' || snapshot?.phase === 'transcribing') { voiceSession.interrupt(); return; }
      if (snapshot?.phase === 'speaking') { voiceSession.interrupt(); return; }
      if (snapshot?.phase === 'idle' && voiceSession.isCapturing) { voiceSession.startListening(); return; }
      // Engine fully closed (e.g. closed manually) — reopen.
      void openLocal().then((ok) => { if (ok) setEngine('local'); });
      return;
    }
    if (engine === 'speech') {
      if (recSessionRef.current.finalText || interimRef.current) {
        autoRestartRef.current = false;
        commit(recSessionRef.current.finalText || interimRef.current);
      } else if (recRunningRef.current) {
        autoRestartRef.current = false;
        stopListening();
      } else {
        autoRestartRef.current = true;
        startSpeechListening();
      }
      return;
    }
    // failed engine: focus the typed input.
    inputRef.current?.focus();
  }, [engine, snapshot?.phase, openLocal, commit, stopListening, startSpeechListening]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary]);

  function close() {
    voiceSession.close();
    stopAll();
    if (onClose) onClose();
    else toggleFullScreenMode();
  }

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
  }, [stopListening]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      if (engine === 'local') voiceSession.setOption('muted', next);
      if (next) ttsService.stop();
      return next;
    });
  }, [engine]);

  const toggleAuto = useCallback(() => {
    setAutoMode((on) => {
      const next = !on;
      if (engine === 'local') voiceSession.setOption('auto', next);
      if (!next && autoListenTimerRef.current) {
        clearTimeout(autoListenTimerRef.current);
        autoListenTimerRef.current = null;
      }
      return next;
    });
  }, [engine]);

  const capturing = engine === 'local' && snapshot?.phase === 'capturing';
  const transcribing = engine === 'local' && snapshot?.phase === 'transcribing';
  const activity = snapshot?.activity;

  const phaseLabel = engine === 'local'
    ? ({
        listening: capturing ? 'Capturing' : 'Listening',
        thinking: transcribing ? 'Transcribing' : (activity || 'Thinking'),
        speaking: 'Speaking',
        idle: voiceSession.isCapturing ? 'Tap to speak' : 'Tap to wake',
      } as const)[phase as 'listening' | 'thinking' | 'speaking' | 'idle'] ?? 'Ready'
    : srSupported ? 'Tap to speak' : 'Type to talk';

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
          {engine === 'local' && snapshot?.vad && (
            <span className="hidden sm:inline text-[9px] px-1.5 py-0.5 rounded-sm" style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-muted-2)' }} title="Local voice engine: silero VAD + on-device whisper">
              {snapshot.vad === 'silero' ? 'on-device' : 'energy vad'}
            </span>
          )}
          {activeSkill && (
            <span className="hidden sm:inline text-[9px] px-1.5 py-0.5 rounded-sm truncate max-w-[140px]" style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-muted)', border: '1px solid var(--gia-border)' }}>
              {activeSkill.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={toggleAuto}
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
            onClick={toggleMute}
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
            <div className="flex flex-col items-center justify-center text-center py-10">
              <AiOrb state="idle" decorative size="lg" className="mb-4" />
              <h2 className="gia-display text-[26px] leading-tight" style={{ color: 'var(--gia-text)' }}>
                Talk to GIA
              </h2>
              <p className="text-[11px] mt-2 max-w-sm leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
                {engine === 'failed'
                  ? 'This environment can’t run the voice engine, but you can type below and GIA will answer out loud.'
                  : 'Speak naturally. The conversation stays in this thread, so you can pick it up in chat later.'}
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
                {turn.role === 'user' && (
                  <p className="text-[9px] mt-1 text-right" style={{ color: 'var(--gia-muted-3)' }}>🎙 spoken</p>
                )}
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
                <span className="text-[11px]" style={{ color: 'var(--gia-muted)' }}>
                  {transcribing ? '…got that' : `${activity || 'Thinking'}…`}
                </span>
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
            {/* The orb IS the state machine — what she is doing, one way. */}
            <div className="flex items-center justify-center h-16">
              <AiOrb
                state={engine === 'local' ? orbStateOf(snapshot) : 'idle'}
                decorative
                size="lg"
                label={undefined}
              />
            </div>
            <motion.button
              type="button"
              onClick={primary}
              className="w-12 h-12 rounded-lg flex items-center justify-center transition-colors"
              whileTap={{ scale: 0.96 }}
              style={{
                background: phase === 'listening' || phase === 'speaking' ? 'var(--gia-accent)' : 'var(--gia-surface-2)',
                color: phase === 'listening' || phase === 'speaking' ? 'var(--gia-accent-contrast)' : 'var(--gia-text)',
                border: '1px solid var(--gia-border-2)',
              }}
              aria-label={
                phase === 'listening' ? (capturing ? 'Send what you said' : 'Stop listening')
                  : phase === 'thinking' ? 'Interrupt'
                    : phase === 'speaking' ? 'Interrupt and listen'
                      : 'Start listening'
              }
              title={phase === 'listening' ? (capturing ? 'Send (Space)' : 'Stop (Space)') : phase === 'thinking' ? 'Interrupt (Space)' : phase === 'speaking' ? 'Interrupt (Space)' : 'Speak (Space)'}
            >
              {capturing ? (
                <Square size={14} />
              ) : phase === 'thinking' || phase === 'speaking' ? (
                <Square size={15} />
              ) : (
                <Mic size={18} />
              )}
            </motion.button>
            <div className="text-center">
              <p className="text-[10px] font-medium" style={{ color: 'var(--gia-text)' }}>{phaseLabel}</p>
              <p className="text-[9px] mt-0.5" style={{ color: 'var(--gia-muted-2)' }}>
                {capturing ? 'Tap to send · pauses send automatically'
                  : phase === 'thinking' ? 'Tap to interrupt'
                    : phase === 'speaking' ? 'Say “stop” or tap to interrupt'
                      : phase === 'listening' ? 'Listening — just talk'
                        : 'Space to speak · Esc to close'}
              </p>
            </div>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); const text = draft.trim(); if (!text) return; setDraft(''); autoRestartRef.current = false; if (phase === 'listening') stopListening(); void handleSend(text); }} className="flex items-center gap-2">
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
