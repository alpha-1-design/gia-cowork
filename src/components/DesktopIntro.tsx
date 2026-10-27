import { useEffect, useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  PlugZap,
  Mic,
  Cpu,
  Terminal,
  Wifi,
  ShieldCheck,
  ArrowRight,
} from 'lucide-react';
import { useGiaStore } from '../store/useGiaStore';

interface DesktopIntroProps {
  onEnter: () => void;
  onSkip: () => void;
}

const CAPABILITIES = [
  {
    icon: PlugZap,
    title: 'Any provider, or none',
    desc: 'Cloud models or on-device — plug in with one key.',
  },
  {
    icon: Mic,
    title: 'Voice & vision, local',
    desc: 'Whisper, Kokoro TTS and computer vision run on this machine.',
  },
  {
    icon: Cpu,
    title: 'Offline intelligence',
    desc: 'Transformers.js models that work with no signal at all.',
  },
  {
    icon: Terminal,
    title: 'The OS is an API',
    desc: 'Terminal, files, browser, screenshots, sandbox — 120+ tools.',
  },
  {
    icon: Wifi,
    title: 'Phone ↔ laptop mesh',
    desc: 'Pairs your devices and shares the brain between them.',
  },
  {
    icon: ShieldCheck,
    title: 'Private by design',
    desc: 'Local-first and self-hostable. Your data stays yours.',
  },
];

/**
 * First-run welcome.
 *
 * This is deliberately plain: a black surface, one neutral mark, a short
 * statement of what the desktop app is, and one primary action. The previous
 * version used an animated aurora, gradient text and a rainbow capability grid,
 * which made the product look like a demo reel rather than a tool.
 */
export default function DesktopIntro({ onEnter, onSkip }: DesktopIntroProps) {
  const reduceMotion = useGiaStore((s) => s.reduceMotion);
  const [stage, setStage] = useState<'hero' | 'capabilities'>('hero');
  const dur = reduceMotion ? 0 : 0.45;

  useEffect(() => {
    if (reduceMotion) {
      setStage('capabilities');
      return;
    }
    const t = setTimeout(() => setStage('capabilities'), 1600);
    return () => clearTimeout(t);
  }, [reduceMotion]);

  const handleEnter = useCallback(() => {
    localStorage.setItem('gia-desktop-intro-seen', 'true');
    onEnter();
  }, [onEnter]);

  const handleSkip = useCallback(() => {
    localStorage.setItem('gia-desktop-intro-seen', 'true');
    onSkip();
  }, [onSkip]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleSkip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSkip]);

  return (
    <div className="fixed inset-0 z-[210] w-full h-[100dvh] overflow-y-auto" style={{ background: 'var(--gia-bg)' }}>
      <div className="relative min-h-full flex flex-col items-center justify-center px-6 py-12 gap-8">
        <div className="flex flex-col items-center text-center">
          <motion.div
            initial={{ scale: 0.94, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: dur, ease: 'easeOut' }}
            className="mb-6 flex h-16 w-16 items-center justify-center rounded-lg"
            style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border-2)' }}
          >
            <span className="text-2xl font-bold leading-none select-none" aria-hidden>G</span>
          </motion.div>

          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduceMotion ? 0 : 0.1, duration: dur }}
            className="mb-3 text-[11px] font-semibold uppercase tracking-[0.42em]"
            style={{ color: 'var(--gia-muted-2)' }}
          >
            Welcome to
          </motion.p>

          <motion.h1
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduceMotion ? 0 : 0.16, duration: dur, ease: 'easeOut' }}
            className="gia-display text-6xl md:text-7xl leading-none"
            style={{ color: 'var(--gia-text)' }}
          >
            GIA Desktop
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduceMotion ? 0 : 0.24, duration: dur }}
            className="mt-4 gia-display italic text-xl md:text-2xl"
            style={{ color: 'var(--gia-text)' }}
          >
            A whole new experience.
          </motion.p>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: reduceMotion ? 0 : 0.34, duration: dur }}
            className="mt-2 max-w-md text-sm leading-relaxed"
            style={{ color: 'var(--gia-muted)' }}
          >
            One assistant with the whole machine at its command — chat, voice,
            tools and your connected devices, together.
          </motion.p>
        </div>

        <AnimatePresence>
          {stage === 'capabilities' && (
            <motion.div
              key="caps"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: dur, ease: 'easeOut' }}
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 w-full max-w-3xl"
            >
              {CAPABILITIES.map((cap, i) => (
                <motion.div
                  key={cap.title}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: reduceMotion ? 0 : i * 0.05, duration: dur }}
                  className="rounded-lg p-4 transition-colors"
                  style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }}
                >
                  <div className="flex items-center gap-3 mb-1.5">
                    <span
                      className="flex items-center justify-center w-9 h-9 rounded-md shrink-0"
                      style={{ background: 'var(--gia-surface-3)', color: 'var(--gia-text)', border: '1px solid var(--gia-border)' }}
                    >
                      <cap.icon size={16} strokeWidth={2} />
                    </span>
                    <span className="font-semibold text-sm" style={{ color: 'var(--gia-text)' }}>{cap.title}</span>
                  </div>
                  <p className="text-xs leading-relaxed pl-12" style={{ color: 'var(--gia-muted)' }}>{cap.desc}</p>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: reduceMotion ? 0 : 0.3, duration: dur }}
          className="flex flex-col items-center gap-3 mt-2"
        >
          <button
            onClick={handleEnter}
            className="group flex items-center gap-2.5 px-7 py-3 rounded-md font-semibold text-sm transition-opacity hover:opacity-90 active:opacity-80"
            style={{ background: 'var(--gia-accent)', color: 'var(--gia-accent-contrast)' }}
          >
            Enter GIA
            <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
          </button>
          <button
            onClick={handleSkip}
            className="text-xs transition-colors"
            style={{ color: 'var(--gia-muted)' }}
          >
            Skip — I'll explore on my own
          </button>
          <span className="text-[10px]" style={{ color: 'var(--gia-muted-2)' }}>One-time welcome · Esc to skip</span>
        </motion.div>
      </div>
    </div>
  );
}
