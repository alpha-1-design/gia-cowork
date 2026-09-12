import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Mic, MicOff, Volume2, VolumeX, ChevronDown, Plus } from 'lucide-react';
import { useGiaStore } from '../store/useGiaStore';
import { useProviderStore } from '../store/useProviderStore';
import GiaBrain from '../services/GiaBrain';
import ttsService from '../services/TTSService';
import { jarvisOrbService } from '../services/JarvisOrbService';
import { logger } from '../utils/logger';

type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * VoiceMode — Full-screen voice conversation UI.
 *
 * Flow: idle → (tap mic) → listening → (silence) → thinking → speaking → listening → ...
 * Each turn: user speaks → GIA generates → GIA speaks via model voice → auto-listens again.
 */
interface VoiceModeProps {
  onClose?: () => void;
}

export default function VoiceMode({ onClose }: VoiceModeProps) {
  const { toggleFullScreenMode, activeSkillId } = useGiaStore();
  const { activeProvider, providers } = useProviderStore();
  const cfg = providers[activeProvider];

  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [userText, setUserText] = useState('');
  const [giaText, setGiaText] = useState('');
  const [interimText, setInterimText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [autoMode, setAutoMode] = useState(true); // auto-listen after GIA speaks
  const [muted, setMuted] = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any | null>(null);
  const recRunningRef = useRef(false);
  const recSessionRef = useRef({ finalText: '', hasSpeech: false, committed: false });
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRestartRef = useRef(true);
  const mountedRef = useRef(true);
  const lastPhaseRef = useRef<VoicePhase>('idle');
  lastPhaseRef.current = phase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSendRef = useRef<(text: string) => Promise<any>>(async () => undefined);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopListening();
      abortRef.current?.abort();
      ttsService.stop();
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, []);

  // Jarvis eyes: keep the floating orb in lockstep with the voice session —
  // listening / thinking / speaking all light it up as GIA is engaged.
  useEffect(() => {
    jarvisOrbService.setVoice(phase);
  }, [phase]);

  // ── Speech Recognition ────────────────────────────────────────────────
  // ONE microphone grab for the whole component: a single continuous
  // recognizer is created lazily on first use and held until unmount or
  // explicit stop. Turns reuse the same instance (start()/abort()), and any
  // silent auto-end just re-arms it after a 120ms nudge so the mic indicator
  // never visibly flickers off and back on. Mic only releases when you close
  // the voice overlay or toggle it off.
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
      if (!mountedRef.current || recRunningRef.current || lastPhaseRef.current !== 'listening' || !autoRestartRef.current) return;
      recRunningRef.current = true;
      try { recognitionRef.current?.start(); } catch { recRunningRef.current = false; retryRestart(); }
    }, 150);
  }, []);

  const startListening = useCallback(() => {
    if (!mountedRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setError('Speech recognition not supported in this browser');
      return;
    }

    // Build the single long-lived recognizer once.
    if (!recognitionRef.current) {
      const sr = new SR();
      sr.continuous = true;
      sr.interimResults = true;
      sr.lang = 'en-US';
      sr.maxAlternatives = 1;

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
        if (session.finalText) {
          setUserText(session.finalText);
          setInterimText('');
        }
        if (session.hasSpeech || interim) {
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = setTimeout(() => {
            if (!mountedRef.current || session.committed) return;
            const committed = session.finalText || interim;
            if (committed) {
              session.committed = true;
              stopListening();
              setUserText(committed);
              setInterimText('');
              void handleSendRef.current(committed);
            }
          }, 1800);
        }
      };

      sr.onerror = (e: any) => {
        if (!mountedRef.current) return;
        const err = e as { error?: string };
        if (err.error === 'no-speech' || err.error === 'aborted') {
          const session = recSessionRef.current;
          if (session.finalText && !session.committed) {
            session.committed = true;
            stopListening();
            setUserText(session.finalText);
            void handleSendRef.current(session.finalText);
          } else {
            retryRestart();
          }
          return;
        }
        logger.warn('[VoiceMode] Speech error:', err.error);
        if (err.error !== 'not-allowed') retryRestart();
      };

      sr.onend = () => {
        if (!mountedRef.current) return;
        recRunningRef.current = false;
        const session = recSessionRef.current;
        if (session.finalText && !session.committed && lastPhaseRef.current !== 'thinking' && lastPhaseRef.current !== 'speaking') {
          session.committed = true;
          setUserText(session.finalText);
          setInterimText('');
          void handleSendRef.current(session.finalText);
        }
        // Re-arm the mic if we're still in a listening turn — no gap, no
        // re-acquisition visible to the OS.
        if (autoRestartRef.current && lastPhaseRef.current === 'listening') retryRestart();
      };

      recognitionRef.current = sr;
    }

    recSessionRef.current = { finalText: '', hasSpeech: false, committed: false };
    setPhase('listening');
    setInterimText('');
    setError(null);

    recRunningRef.current = true;
    try {
      recognitionRef.current.start();
    } catch {
      // Already running mid-turn — that's fine, it's live.
      recRunningRef.current = false;
    }
  }, [retryRestart, stopListening]);

  // ── Send to GIA ───────────────────────────────────────────────────────
  const handleSend = useCallback(async (text: string) => {
    if (!text.trim() || phase === 'thinking') return;
    autoRestartRef.current = false;
    setPhase('thinking');
    setUserText(text);
    setGiaText('');
    setInterimText('');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await GiaBrain.generate({
        prompt: text,
        systemPrompt: `You are GIA, speaking in voice mode. The user is talking to you directly. Be conversational, concise, and natural — like a knowledgeable friend. Keep responses under 3 sentences unless the user asked for detail. No markdown, no bullet points, no headers — just natural spoken language. ${activeSkillId ? `Active skill: ${activeSkillId}` : ''}`,
        signal: controller.signal,
      });

      if (!mountedRef.current || controller.signal.aborted) return;

      const reply = res.text.trim();
      setGiaText(reply);
      setPhase('speaking');

      // Speak the response
      if (!muted) {
        await ttsService.speakFinal(reply);
      }

      // After speaking, auto-listen again if autoMode is on
      if (mountedRef.current && autoMode && !controller.signal.aborted) {
        setUserText('');
        setGiaText('');
        setPhase('idle');
        // Brief pause then start listening
        setTimeout(() => {
          if (mountedRef.current && autoMode) {
            autoRestartRef.current = true;
            startListening();
          }
        }, 600);
      } else if (mountedRef.current) {
        setPhase('idle');
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return;
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : 'Generation failed');
      setPhase('idle');
    } finally {
      abortRef.current = null;
    }
  }, [phase, muted, autoMode, activeSkillId, startListening]);

  handleSendRef.current = handleSend;

  // ── Toggle mic ────────────────────────────────────────────────────────
  const toggleMic = useCallback(() => {
    if (phase === 'listening') {
      autoRestartRef.current = false;
      stopListening();
      // If we have interim text, send it
      const text = userText || interimText;
      if (text.trim()) {
        void handleSend(text);
      } else {
        setPhase('idle');
      }
    } else if (phase === 'idle' || phase === 'speaking') {
      ttsService.stop();
      autoRestartRef.current = true;
      setUserText('');
      setGiaText('');
      setInterimText('');
      startListening();
    }
  }, [phase, userText, interimText, stopListening, startListening, handleSend]);

  // ── Keyboard shortcut ─────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      autoRestartRef.current = false;
      stopListening();
      ttsService.stop();
      abortRef.current?.abort();
      onClose?.() ?? toggleFullScreenMode();
    }
      if (e.key === ' ' && e.target === document.body) {
        e.preventDefault();
        toggleMic();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [toggleMic, stopListening, onClose, toggleFullScreenMode]);

  const phaseLabel = {
    idle: 'Tap to speak',
    listening: 'Listening…',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
  }[phase];

  const orbColor = {
    idle: 'rgba(168,85,247,0.3)',
    listening: 'rgba(52,211,153,0.5)',
    thinking: 'rgba(245,158,11,0.5)',
    speaking: 'rgba(168,85,247,0.5)',
  }[phase];

  const orbGlow = {
    idle: '0 0 40px rgba(168,85,247,0.2)',
    listening: '0 0 60px rgba(52,211,153,0.3)',
    thinking: '0 0 60px rgba(245,158,11,0.3)',
    speaking: '0 0 60px rgba(168,85,247,0.4)',
  }[phase];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="fixed inset-0 z-[300] flex flex-col"
      style={{ background: '#0a0a0f' }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 pt-4 pb-2 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: '#34d399' }} />
          <span className="text-[11px] font-semibold" style={{ color: '#a855f7' }}>
            {cfg?.model?.split('/').pop()?.slice(0, 20) || 'GIA'}
          </span>
          <ChevronDown size={10} style={{ color: 'var(--gia-muted-2)' }} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoMode(!autoMode)}
            className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
            style={{
              background: autoMode ? 'rgba(52,211,153,0.15)' : 'rgba(255,255,255,0.05)',
              border: `1px solid ${autoMode ? 'rgba(52,211,153,0.3)' : 'rgba(255,255,255,0.08)'}`,
            }}
            title={autoMode ? 'Auto-reply ON' : 'Auto-reply OFF'}
          >
            <span className="text-[8px] font-bold" style={{ color: autoMode ? '#34d399' : '#71717a' }}>
              {autoMode ? 'AUTO' : 'MANUAL'}
            </span>
          </button>
          <button
            onClick={() => { ttsService.stop(); setMuted(!muted); }}
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            {muted ? <VolumeX size={12} style={{ color: '#71717a' }} /> : <Volume2 size={12} style={{ color: 'var(--gia-muted)' }} />}
          </button>
          <button
            onClick={() => {
              autoRestartRef.current = false;
              stopListening();
              ttsService.stop();
              abortRef.current?.abort();
              onClose?.() ?? toggleFullScreenMode();
            }}
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <X size={12} style={{ color: 'var(--gia-muted)' }} />
          </button>
        </div>
      </div>

      {/* Center area — transcript / greeting */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 overflow-y-auto">
        <AnimatePresence mode="wait">
          {phase === 'idle' && !userText && !giaText && (
            <motion.div
              key="greeting"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="text-center"
            >
              <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--gia-text)' }}>
                What are you working on?
              </h2>
              <p className="text-[11px]" style={{ color: 'var(--gia-muted-2)' }}>
                Tap the microphone or press space to start
              </p>
            </motion.div>
          )}

          {(userText || interimText) && (
            <motion.div
              key="user-text"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="text-center max-w-lg"
            >
              <p className="text-lg font-medium leading-relaxed" style={{ color: 'var(--gia-text)' }}>
                {userText || interimText}
              </p>
              {interimText && !userText && (
                <div className="flex items-center justify-center gap-1 mt-2">
                  <div className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-[9px]" style={{ color: '#34d399' }}>listening</span>
                </div>
              )}
            </motion.div>
          )}

          {giaText && (
            <motion.div
              key="gia-text"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="text-center max-w-lg mt-4"
            >
              <p className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: '#a855f7' }}>GIA</p>
              <p className="text-base leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
                {giaText}
              </p>
            </motion.div>
          )}

          {error && (
            <motion.div
              key="error"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center mt-4"
            >
              <p className="text-[11px] px-3 py-1.5 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>
                {error}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom — orb + controls */}
      <div className="flex flex-col items-center pb-8 pt-4 shrink-0">
        {/* Animated orb */}
        <div className="relative mb-6">
          {/* Outer glow rings */}
          {phase !== 'idle' && (
            <>
              <motion.div
                className="absolute inset-0 rounded-full"
                animate={{
                  scale: phase === 'listening' ? [1, 1.4, 1] : phase === 'speaking' ? [1, 1.2, 1] : [1, 1.1, 1],
                  opacity: [0.3, 0.1, 0.3],
                }}
                transition={{ duration: phase === 'listening' ? 1.5 : 2, repeat: Infinity, ease: 'easeInOut' }}
                style={{ background: orbColor, filter: 'blur(20px)' }}
              />
              <motion.div
                className="absolute inset-0 rounded-full"
                animate={{
                  scale: phase === 'listening' ? [1, 1.6, 1] : [1, 1.3, 1],
                  opacity: [0.15, 0.05, 0.15],
                }}
                transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut', delay: 0.3 }}
                style={{ background: orbColor, filter: 'blur(30px)' }}
              />
            </>
          )}

          {/* Core orb */}
          <motion.div
            className="w-20 h-20 rounded-full flex items-center justify-center cursor-pointer relative z-10"
            animate={{
              scale: phase === 'listening' ? [1, 1.05, 1] : phase === 'speaking' ? [1, 1.08, 1] : 1,
            }}
            transition={{ duration: phase === 'idle' ? 0 : 1.2, repeat: Infinity, ease: 'easeInOut' }}
            style={{
              background: `radial-gradient(circle at 40% 40%, ${orbColor}, rgba(168,85,247,0.15))`,
              boxShadow: orbGlow,
              border: `1px solid ${phase === 'idle' ? 'rgba(168,85,247,0.2)' : phase === 'listening' ? 'rgba(52,211,153,0.3)' : phase === 'thinking' ? 'rgba(245,158,11,0.3)' : 'rgba(168,85,247,0.3)'}`,
            }}
            onClick={toggleMic}
          >
            {/* Audio wave bars when listening or speaking */}
            {(phase === 'listening' || phase === 'speaking') && (
              <div className="flex items-center gap-[3px]">
                {[0, 1, 2, 3, 4].map(i => (
                  <motion.div
                    key={i}
                    className="w-[3px] rounded-full"
                    animate={{
                      height: phase === 'listening'
                        ? [8, 20 + Math.random() * 12, 8]
                        : [6, 14 + Math.random() * 8, 6],
                    }}
                    transition={{
                      duration: 0.4 + Math.random() * 0.3,
                      repeat: Infinity,
                      ease: 'easeInOut',
                      delay: i * 0.08,
                    }}
                    style={{
                      background: phase === 'listening' ? '#34d399' : '#a855f7',
                      minHeight: 4,
                    }}
                  />
                ))}
              </div>
            )}

            {/* Thinking spinner */}
            {phase === 'thinking' && (
              <motion.div
                className="w-6 h-6 rounded-full border-2 border-t-transparent"
                animate={{ rotate: 360 }}
                transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                style={{ borderColor: 'rgba(245,158,11,0.5)', borderTopColor: 'transparent' }}
              />
            )}

            {/* Idle mic icon */}
            {phase === 'idle' && (
              <Mic size={24} style={{ color: '#a855f7' }} />
            )}
          </motion.div>
        </div>

        {/* Phase label */}
        <motion.p
          key={phase}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-[10px] font-medium mb-4"
          style={{ color: 'var(--gia-muted-2)' }}
        >
          {phaseLabel}
        </motion.p>

        {/* Bottom bar — matches Qwen style */}
        <div className="flex items-center gap-2 w-full max-w-md px-4">
          <button
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <Plus size={16} style={{ color: 'var(--gia-muted)' }} />
          </button>
          <div
            className="flex-1 flex items-center gap-2 px-4 py-2.5 rounded-full"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <span className="flex-1 text-[12px]" style={{ color: 'var(--gia-muted-2)' }}>
              {phase === 'idle' ? 'How can I help you today?' : phaseLabel}
            </span>
            <button onClick={toggleMic} className="shrink-0">
              {phase === 'listening' ? (
                <MicOff size={16} style={{ color: '#f87171' }} />
              ) : (
                <Mic size={16} style={{ color: 'var(--gia-muted)' }} />
              )}
            </button>
          </div>
          {/* Orb button in the bar (like Qwen's purple circle) */}
          <motion.button
            onClick={toggleMic}
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
            animate={phase === 'listening' ? { scale: [1, 1.1, 1] } : {}}
            transition={{ duration: 1, repeat: Infinity }}
            style={{
              background: phase === 'listening'
                ? 'linear-gradient(135deg, #34d399, #10b981)'
                : phase === 'thinking'
                ? 'linear-gradient(135deg, #f59e0b, #d97706)'
                : phase === 'speaking'
                ? 'linear-gradient(135deg, #a855f7, #7c3aed)'
                : 'linear-gradient(135deg, rgba(168,85,247,0.3), rgba(139,92,246,0.2))',
              boxShadow: phase === 'listening'
                ? '0 0 20px rgba(52,211,153,0.3)'
                : phase === 'speaking'
                ? '0 0 20px rgba(168,85,247,0.3)'
                : 'none',
            }}
          >
            {phase === 'listening' ? (
              <div className="flex items-center gap-[2px]">
                {[0, 1, 2].map(i => (
                  <motion.div
                    key={i}
                    className="w-[2px] rounded-full bg-white"
                    animate={{ height: [4, 12, 4] }}
                    transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.1 }}
                  />
                ))}
              </div>
            ) : phase === 'thinking' ? (
              <motion.div
                className="w-4 h-4 rounded-full border-2 border-white border-t-transparent"
                animate={{ rotate: 360 }}
                transition={{ duration: 0.7, repeat: Infinity, ease: 'linear' }}
              />
            ) : (
              <Mic size={14} style={{ color: phase === 'speaking' ? 'white' : '#a855f7' }} />
            )}
          </motion.button>
        </div>

        {/* Keyboard hint */}
        <p className="text-[8px] mt-3" style={{ color: 'rgba(255,255,255,0.15)' }}>
          space to toggle · esc to close
        </p>
      </div>
    </motion.div>
  );
}
