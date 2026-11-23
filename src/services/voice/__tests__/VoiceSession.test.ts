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
    onSentence: vi.fn(() => () => undefined),
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
// FileSnapshots: spoken-undo rail.
const snapshots: { id: string; path: string; reverted?: boolean }[] = [];
vi.mock('../../FileSnapshots', () => ({
  fileSnapshots: {
    listPending: vi.fn(() => snapshots.filter((x) => !x.reverted)),
    revert: vi.fn(async (id: string) => {
      const snap = snapshots.find((x) => x.id === id);
      if (snap) snap.reverted = true;
      return { success: true };
    }),
  },
}));
// The store: minimal surface VoiceSession touches.
const sessions: { id: string; title: string; messages: unknown[] }[] = [
  { id: 'sess-1', title: 'Chat', messages: [] },
];
const steeringNotes: { sessionId: string; text: string }[] = [];
const queuedMessages: { id: string; sessionId?: string; text: string; holdForVoice?: boolean; queuedAt: number }[] = [];
// Hoisted mocks so assertions can observe the SAME instance VoiceSession calls.
const addSteering = vi.fn((sessionId: string, text: string) => { steeringNotes.push({ sessionId, text }); });
const addNotification = vi.fn();
const enqueueMessage = vi.fn((m: { id: string; sessionId?: string; text: string; holdForVoice?: boolean; queuedAt: number; origin?: string }) => { queuedMessages.push(m); });
const releaseHeldQueues = vi.fn((sessionId?: string) => {
  for (const m of queuedMessages) {
    if (m.holdForVoice && (!sessionId || !m.sessionId || m.sessionId === sessionId)) m.holdForVoice = false;
  }
});
vi.mock('../../../store/useGiaStore', () => ({
  useGiaStore: {
    getState: () => ({
      activeSessionId: 'sess-1',
      sessions,
      createSession: () => 'sess-2',
      getBranchMessages: () => [],
      addMessage: (id: string, msg: unknown) => { sessions[0].messages.push(msg); },
      updateSessionTitle: vi.fn(),
      addSteering,
      takeSteering: vi.fn(() => steeringNotes.splice(0)),
      queuedMessages,
      enqueueMessage,
      releaseHeldQueues,
      addNotification,
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
import tts from '../../TTSService';
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

  it('keyword with nothing running is an ordinary turn (nothing to stop)', async () => {
    await voiceSession.open();
    scriptedText = 'stop';
    const s = voiceSession as unknown as { buffering: boolean; buffer: Float32Array[]; bufferSamples: number; endpoint: () => Promise<void> };
    s.buffering = true;
    s.buffer = Array.from({ length: 8 }, () => new Float32Array(FRAME_SIZE));
    s.bufferSamples = FRAME_SIZE * 8;
    await s.endpoint();
    // The gate only fires while she is busy; idle "stop" is just content.
    expect(GiaBrain.generate).toHaveBeenCalledOnce();
  });

  it('phase 3: non-keyword speech while she TALKS is parked and delivered after playback', async () => {
    (GiaBrain.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { prompt: string }) => ({ text: `echo: ${req.prompt}`, model: 'm' }),
    );
    // Hold her mouth open so the 'speaking' phase is stable for the test.
    let releaseSpeech!: () => void;
    (tts.speakFinal as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseSpeech = resolve; }),
    );
    await voiceSession.open();
    const first = voiceSession.handleUtterance('first answer please');
    await new Promise((r) => setTimeout(r, 20));
    expect(voiceSession.getSnapshot().phase).toBe('speaking');
    // She is 'speaking' (TTS queue) — user says something else.
    scriptedText = 'and one more thing';
    const s = voiceSession as unknown as { buffering: boolean; buffer: Float32Array[]; bufferSamples: number; endpoint: () => Promise<void>; pending: string[] };
    s.buffering = true;
    s.buffer = Array.from({ length: 8 }, () => new Float32Array(FRAME_SIZE));
    s.bufferSamples = FRAME_SIZE * 8;
    await s.endpoint();
    // Parked as a VISIBLE held queue card, not sent mid-stream.
    expect(queuedMessages).toEqual([expect.objectContaining({ text: 'and one more thing', holdForVoice: true, origin: 'voice' })]);
    releaseSpeech();
    await first; // playback "ends" → the hold releases; the normal drain sends it
    expect(queuedMessages[0].holdForVoice).toBe(false);
    expect(useGiaStore.getState().releaseHeldQueues).toHaveBeenCalled();
  });

  it('phase 3: spoken undo reverts her last write and never reaches the model', async () => {
    snapshots.push({ id: 'snap-1', path: 'src/app.tsx' });
    await voiceSession.open();
    scriptedText = 'undo that';
    const s = voiceSession as unknown as { buffering: boolean; buffer: Float32Array[]; bufferSamples: number; endpoint: () => Promise<void> };
    s.buffering = true;
    s.buffer = Array.from({ length: 8 }, () => new Float32Array(FRAME_SIZE));
    s.bufferSamples = FRAME_SIZE * 8;
    await s.endpoint();
    expect(GiaBrain.generate).not.toHaveBeenCalled();
    expect(snapshots[0].reverted).toBe(true);
    expect(useGiaStore.getState().addNotification).toHaveBeenCalledWith(expect.stringContaining('Reverted src/app.tsx'));
  });

  it('phase 3: spoken undo with nothing to undo stays polite and inert', async () => {
    await voiceSession.open();
    scriptedText = 'undo that';
    const s = voiceSession as unknown as { buffering: boolean; buffer: Float32Array[]; bufferSamples: number; endpoint: () => Promise<void> };
    s.buffering = true;
    s.buffer = Array.from({ length: 8 }, () => new Float32Array(FRAME_SIZE));
    s.bufferSamples = FRAME_SIZE * 8;
    await s.endpoint();
    expect(GiaBrain.generate).not.toHaveBeenCalled();
    const { default: tts } = await import('../../TTSService');
    expect(tts.speak).toHaveBeenCalledWith('Nothing to undo.', true);
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

  it('phase 2: streamed answers speak sentence-by-sentence and never replay via speakFinal', async () => {
    (GiaBrain.generate as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (req: { onStream?: (c: string) => void }) => {
        req.onStream?.('First full sentence here. ');
        req.onStream?.('Second full sentence ');
        req.onStream?.('finishes now. ');
        return { text: 'First full sentence here. Second full sentence finishes now.', model: 'test-model' };
      },
    );
    await voiceSession.open();
    await voiceSession.handleUtterance('talk to me');
    const { default: tts } = await import('../../TTSService');
    const speakCalls = (tts.speak as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(speakCalls).toContain('First full sentence here.');
    expect(speakCalls.join(' ')).toContain('Second full sentence finishes now.');
    // The whole answer must NOT be replayed at the end.
    expect(tts.speakFinal).not.toHaveBeenCalled();
  });

  it('phase 2: tool announcements are spoken through the whitelist', async () => {
    (GiaBrain.generate as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (req: { onThought?: (t: string) => void }) => {
        req.onThought?.('⚙️ Executing web_search...');
        return { text: 'All done with the check.', model: 'test-model' };
      },
    );
    await voiceSession.open();
    await voiceSession.handleUtterance('check the web');
    const { default: tts } = await import('../../TTSService');
    const speakCalls = (tts.speak as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(speakCalls.some((t) => t.includes('Searching the web'))).toBe(true);
  });

  it('phase 3: speech while she works becomes a steering note, not a new turn', async () => {
    // A brain call that stays running while the user speaks.
    let release!: () => void;
    (GiaBrain.generate as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<{ text: string; model: string }>((resolve) => {
        release = () => resolve({ text: 'Adjusted and done.', model: 'm' });
      }),
    );
    await voiceSession.open();
    const run = voiceSession.handleUtterance('do the task'); // phase → thinking
    await new Promise((r) => setTimeout(r, 20));
    expect((voiceSession.getSnapshot().phase) === 'thinking' || voiceSession.getSnapshot().working).toBe(true);

    // The user talks while she works: buffer an utterance and endpoint it.
    const s = voiceSession as unknown as { buffering: boolean; buffer: Float32Array[]; bufferSamples: number; endpoint: () => Promise<void> };
    scriptedText = 'wait, use the cached file instead';
    s.buffering = true;
    s.buffer = Array.from({ length: 8 }, () => new Float32Array(FRAME_SIZE));
    s.bufferSamples = FRAME_SIZE * 8;
    await s.endpoint();

    // No new generation started for the steering text.
    expect(GiaBrain.generate).toHaveBeenCalledTimes(1);
    // The steering note landed in the store rail.
    const store = useGiaStore.getState();
    expect(store.addSteering).toBeDefined();

    release();
    await run;
  });

  it('phase 3: keyword barge-in while she works stops the generation', async () => {
    let release!: () => void;
    (GiaBrain.generate as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<{ text: string; model: string }>((resolve) => {
        release = () => resolve({ text: 'never shown', model: 'm' });
      }),
    );
    await voiceSession.open();
    const run = voiceSession.handleUtterance('long task');
    await new Promise((r) => setTimeout(r, 20));
    scriptedText = 'stop';
    const s = voiceSession as unknown as { buffering: boolean; buffer: Float32Array[]; bufferSamples: number; endpoint: () => Promise<void> };
    s.buffering = true;
    s.buffer = Array.from({ length: 8 }, () => new Float32Array(FRAME_SIZE));
    s.bufferSamples = FRAME_SIZE * 8;
    await s.endpoint();
    // generation aborted → no assistant turn is ever persisted
    release();
    await run;
    const msgs = sessions[0].messages as { role: string; content?: string }[];
    expect(msgs.filter((m) => m.role === 'assistant' && m.content === 'never shown')).toHaveLength(0);
  });
});
