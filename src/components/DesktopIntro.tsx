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
  ChevronDown,
} from 'lucide-react';
import { useGiaStore } from '../store/useGiaStore';

interface DesktopIntroProps {
  onEnter: () => void;
  onSkip: () => void;
}

const CAPABILITIES = [
  {
    icon: PlugZap,
    tint: '#06b6d4',
    title: 'Any provider, or none',
    desc: 'Cloud models or on-device — plug in with one key.',
  },
  {
    icon: Mic,
    tint: '#a855f7',
    title: 'Voice & vision, local',
    desc: 'Whisper, Kokoro TTS and computer vision run on this machine.',
  },
  {
    icon: Cpu,
    tint: '#ec4899',
    title: 'Offline intelligence',
    desc: 'Transformers.js models that work with no signal at all.',
  },
  {
    icon: Terminal,
    tint: '#06b6d4',
    title: 'The OS is an API',
    desc: 'Terminal, files, browser, screenshots, sandbox — 120+ tools.',
  },
  {
    icon: Wifi,
    tint: '#a855f7',
    title: 'Phone ↔ laptop mesh',
    desc: 'Pairs your devices and shares the brain between them.',
  },
  {
    icon: ShieldCheck,
    tint: '#ec4899',
    title: 'Private by design',
    desc: 'Local-first and self-hostable. Your data stays yours.',
  },
];

export default function DesktopIntro({ onEnter, onSkip }: DesktopIntroProps) {
  const reduceMotion = useGiaStore((s) => s.reduceMotion);
  const [stage, setStage] = useState<'hero' | 'capabilities'>('hero');
  const dur = reduceMotion ? 0 : 0.6;

  useEffect(() => {
    if (reduceMotion) {
      setStage('capabilities');
      return;
    }
    const t = setTimeout(() => setStage('capabilities'), 2000);
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

  const blobs = [
    { c: 'rgba(6,182,212,0.22)', s: 700, x: -340, y: -260, d: 18 },
    { c: 'rgba(139,92,246,0.18)', s: 640, x: 300, y: -320, d: 23 },
    { c: 'rgba(236,72,153,0.12)', s: 560, x: 60, y: 300, d: 27 },
  ];

  return (
    <div className="fixed inset-0 z-[210] w-full h-[100dvh] bg-black overflow-y-auto">
      {/* ── Aurora backdrop ─────────────────────────────────── */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden>
        {blobs.map((b, i) => (
          <motion.div
            key={i}
            className="absolute rounded-full"
            style={{ width: b.s, height: b.s, background: `radial-gradient(circle at 40% 40%, ${b.c}, transparent 60%)`, filter: 'blur(72px)' }}
            initial={{ x: b.x, y: b.y, opacity: 0.55, scale: 1 }}
            animate={reduceMotion ? {} : { x: [b.x, b.x + 60, b.x - 40, b.x], y: [b.y, b.y - 50, b.y + 40, b.y], opacity: [0.55, 0.75, 0.5, 0.55], scale: [1, 1.08, 0.96, 1] }}
            transition={{ duration: b.d, repeat: Infinity, ease: 'easeInOut' }}
          />
        ))}
        <motion.div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(ellipse 70% 55% at 50% 42%, transparent 0%, rgba(0,0,0,0.55) 78%, #000 100%)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: dur }}
        />
      </div>

      <div className="relative min-h-full flex flex-col items-center justify-center px-6 py-12 gap-8">
        {/* ── Hero beat ─────────────────────────────────────── */}
        <div className="flex flex-col items-center text-center">
          <motion.div
            initial={{ scale: 0.75, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: dur, ease: 'easeOut' }}
            className="relative mb-6"
          >
            <motion.div
              className="w-20 h-20 rounded-3xl flex items-center justify-center"
              style={{
                background: 'linear-gradient(135deg, rgba(6,182,212,0.28), rgba(139,92,246,0.28) 55%, rgba(236,72,153,0.22))',
                border: '1px solid rgba(139,92,246,0.35)',
              }}
              animate={reduceMotion ? {} : {
                boxShadow: [
                  '0 0 24px rgba(6,182,212,0.22), 0 0 60px rgba(139,92,246,0.14), 0 0 90px rgba(236,72,153,0.05)',
                  '0 0 34px rgba(6,182,212,0.34), 0 0 76px rgba(139,92,246,0.22), 0 0 110px rgba(236,72,153,0.09)',
                  '0 0 24px rgba(6,182,212,0.22), 0 0 60px rgba(139,92,246,0.14), 0 0 90px rgba(236,72,153,0.05)',
                ],
              }}
              transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
            >
              <span className="text-3xl font-bold aurora-text leading-none select-none" aria-hidden>G</span>
            </motion.div>
          </motion.div>

          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduceMotion ? 0 : 0.15, duration: dur }}
            className="text-[11px] font-semibold tracking-[0.42em] text-zinc-400 uppercase mb-3"
          >
            Welcome to
          </motion.p>

          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduceMotion ? 0 : 0.25, duration: dur, ease: 'easeOut' }}
            className="text-6xl md:text-7xl font-extrabold tracking-tight aurora-text leading-none"
          >
            GIA Desktop
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduceMotion ? 0 : 0.45, duration: dur }}
            className="mt-4 text-lg md:text-xl text-zinc-200"
          >
            A whole new experience.
          </motion.p>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: reduceMotion ? 0 : 0.7, duration: dur }}
            className="mt-2 max-w-md text-sm text-zinc-500"
          >
            One assistant with the whole machine at its command — chat, voice,
            tools and your connected devices, together.
          </motion.p>
        </div>

        {/* ── Capability grid ───────────────────────────────── */}
        <AnimatePresence>
          {stage === 'capabilities' && (
            <motion.div
              key="caps"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: dur, ease: 'easeOut' }}
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 w-full max-w-3xl"
            >
              {CAPABILITIES.map((cap, i) => (
                <motion.div
                  key={cap.title}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: reduceMotion ? 0 : i * 0.08, duration: dur }}
                  className="group rounded-2xl bg-white/[0.03] border border-white/10 hover:border-white/20 hover:bg-white/[0.05] transition-colors p-4"
                >
                  <div className="flex items-center gap-3 mb-1.5">
                    <span
                      className="flex items-center justify-center w-9 h-9 rounded-xl"
                      style={{ background: `${cap.tint}1f`, color: cap.tint }}
                    >
                      <cap.icon size={17} strokeWidth={2.2} />
                    </span>
                    <span className="font-semibold text-sm text-zinc-100">{cap.title}</span>
                  </div>
                  <p className="text-xs text-zinc-500 pl-12">{cap.desc}</p>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {stage === 'hero' && !reduceMotion && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, y: [0, 6, 0] }}
            transition={{ delay: 1.1, duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
            className="text-zinc-600"
            aria-hidden
          >
            <ChevronDown size={18} />
          </motion.div>
        )}

        {/* ── Actions ───────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: reduceMotion ? 0 : 0.6, duration: dur }}
          className="flex flex-col items-center gap-3 mt-2"
        >
          <button
            onClick={handleEnter}
            className="group flex items-center gap-2.5 px-8 py-3.5 rounded-xl font-semibold text-sm text-white transition-transform hover:scale-[1.02] active:scale-[0.98]"
            style={{
              background: 'linear-gradient(120deg, rgba(6,182,212,0.9), rgba(139,92,246,0.85) 55%, rgba(236,72,153,0.75))',
              boxShadow: '0 8px 30px rgba(139,92,246,0.28)',
            }}
          >
            Enter GIA
            <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
          </button>
          <button
            onClick={handleSkip}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Skip — I'll explore on my own
          </button>
          <span className="text-[10px] text-zinc-700">One-time welcome · Esc to skip</span>
        </motion.div>
      </div>
    </div>
  );
}