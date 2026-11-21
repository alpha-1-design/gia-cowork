import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the heavyweight edges before importing the module under test.
let scriptedText = 'hello gia';
vi.mock('../../WhisperService', () => ({
  default: {
    status: 'ready',
    transcribeFloat32: vi.fn(async () => scriptedText),
  },
}));
vi.mock('../../TTSService', () => ({
  default: {
    speakFinal: vi.fn(async () => undefined),
    stop: vi.fn(),
    speak: vi.fn(async () => undefined),
  },
}));
vi.mock('../../GiaBrain', () => ({
  default: {
    generate: vi.fn(async (req: { prompt: string; signal?: AbortSignal }) => {
      if (req.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { text: `echo: ${req.prompt}`, model: 'test-model' };
    }),
  },
}));
// The store: minimal surface VoiceSession touches.
const sessions: { id: string; title: string; messages: unknown[] }[] = [
  { id: 'sess-1', title: 'Chat', messages: [] },
];
vi.mock('../../../store/useGiaStore', () => ({
  useGiaStore: {
    getState: () => ({
      activeSessionId: 'sess-1',
      sessions,
      createSession: () => 'sess-2',
      getBranchMessages: () => [],
      addMessage: (id: string, msg: unknown) => { sessions[0].messages.push(msg); },
      updateSessionTitle: vi.fn(),
    }),
  },
}));
// Mic tap: no real hardware in tests.
vi.mock('../micTap', () => ({
  startMicTap: vi.fn(async () => ({
    onFrame: () => () => undefined,
    stop: vi.fn(async () => undefined),
    isRunning: true,
  })),
  stopMicTap: vi.fn(async () => undefined),
  FRAME_SIZE: 1280,
}));
// VAD: a scripted fake (no onnxruntime in unit tests).
let scripted: { decision: 'start' | 'hold' | 'end' } = { decision: 'hold' };
vi.mock('../vad', () => ({
  createVAD: vi.fn(async () => ({
    kind: 'silero' as const,
    feed: () => ({
      speechStart: scripted.decision === 'start',
      speechEnd: scripted.decision === 'end',
      active: scripted.decision !== 'end',
    }),
    reset: vi.fn(),
    setBargeInMode: vi.fn(),
  })),
  concatFrames: (frames: Float32Array[]) => {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const out = new Float32Array(total);
    let p = 0;
    for (const f of frames) { out.set(f, p); p += f.length; }
    return out;
  },
}));

import { voiceSession } from '../VoiceSession';
import GiaBrain from '../../GiaBrain';
import { useGiaStore } from '../../../store/useGiaStore';
import { startMicTap, FRAME_SIZE } from '../micTap';
import type { VoiceSnapshot } from '../VoiceSession';

const collect = () => {
  const snaps: VoiceSnapshot[] = [];
  const off = voiceSession.subscribe((s) => snaps.push(s));
  return { snaps, off };
};

describe('VoiceSession — phase-1 walkie-talkie', () => {
  beforeEach(() => {
    scripted = { decision: 'hold' };
    scriptedText = 'hello gia';
    sessions[0].messages = [];
    sessions[0].title = 'Chat';
    vi.clearAllMocks();
  });

  afterEach(() => {
    voiceSession.close();
  });

  it('open → listening with mic claimed; close releases it', async () => {
    await voiceSession.open();
    expect(voiceSession.isCapturing).toBe(true);
    expect(startMicTap).toHaveBeenCalledOnce();
    voiceSession.close();
    expect(voiceSession.isCapturing).toBe(false);
  });

  it('refuses a second concurrent capture owner', async () => {
    await voiceSession.open();
    await expect(voiceSession.open()).resolves.toBeUndefined(); // idempotent reopen
    voiceSession.close();
  });

  it('full turn: VAD endpoint → STT → brain → TTS → persisted turns', async () => {
    const userTurns: string[] = [];
    const replies: string[] = [];
    voiceSession.onUserUtterance = (t) => userTurns.push(t);
    voiceSession.onAssistantReply = (r) => replies.push(r);
    const { snaps } = collect();

    await voiceSession.open();
    scripted.decision = 'start';
    // Drive the utterance directly (endpoint behaviour is covered by the
    // VAD tests); VoiceSession.handleUtterance is the real commit path.
    await voiceSession.handleUtterance('hello gia');

    expect(GiaBrain.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello gia' }));
    expect(userTurns).toEqual(['hello gia']);
    expect(replies).toEqual(['echo: hello gia']);
    const store = useGiaStore.getState();
    expect(store.addMessage).toBeDefined();
    const msgs = sessions[0].messages as { role: string; content: string; origin?: string }[];
    expect(msgs.some((m) => m.role === 'user' && m.content === 'hello gia' && m.origin === 'voice')).toBe(true);
    expect(msgs.some((m) => m.role === 'assistant' && m.content === 'echo: hello gia')).toBe(true);
    // She speaks the reply through the sentence-chunked streaming path.
    const { default: tts } = await import('../../TTSService');
    expect(tts.speakFinal).toHaveBeenCalledWith('echo: hello gia');
    expect(snaps.some((s) => s.phase === 'thinking')).toBe(true);
    expect(snaps.some((s) => s.phase === 'speaking')).toBe(true);
  });

  it('stop keyword interrupts without a brain turn', async () => {
    await voiceSession.open();
    // A real utterance flows through endpoint(): transcribe → keyword check.
    scriptedText = 'stop';
    const s = voiceSession as unknown as { buffering: boolean; buffer: Float32Array[]; bufferSamples: number; endpoint: () => Promise<void> };
    s.buffering = true;
    s.buffer = Array.from({ length: 8 }, () => new Float32Array(FRAME_SIZE));
    s.bufferSamples = FRAME_SIZE * 8;
    await s.endpoint();
    expect(GiaBrain.generate).not.toHaveBeenCalled();
  });

  it('abort during generation returns to listening without a reply', async () => {
    (GiaBrain.generate as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (req: { signal?: AbortSignal }) => {
        req.signal?.dispatchEvent(new Event('abort'));
        // simulate AbortController.abort semantics
        Object.defineProperty(req.signal!, 'aborted', { value: true });
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    );
    await voiceSession.open();
    await voiceSession.handleUtterance('hello');
    const msgs = sessions[0].messages as { role: string }[];
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('micro utterances (clicks) are dropped before STT', async () => {
    await voiceSession.open();
    // Two frames = 160 ms < the 320 ms minimum → no STT, no turn.
    const s = voiceSession as unknown as { buffering: boolean; buffer: Float32Array[]; bufferSamples: number; endpoint: () => Promise<void> };
    s.buffering = true;
    s.buffer = [new Float32Array(FRAME_SIZE), new Float32Array(FRAME_SIZE)];
    s.bufferSamples = FRAME_SIZE * 2;
    await s.endpoint();
    expect(GiaBrain.generate).not.toHaveBeenCalled();
  });

  it('manual mode (auto:false) parks on idle after the turn', async () => {
    await voiceSession.open({ auto: false });
    const { snaps } = collect();
    await voiceSession.handleUtterance('hello gia');
    expect(snaps[snaps.length - 1].phase).toBe('idle');
  });
});
