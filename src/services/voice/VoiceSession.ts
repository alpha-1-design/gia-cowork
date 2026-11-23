import { logger } from '../../utils/logger';
import { startMicTap, stopMicTap, FRAME_SIZE, type MicTap } from './micTap';
import { createVAD, concatFrames, type VAD } from './vad';
import whisperService from '../WhisperService';
import ttsService from '../TTSService';
import GiaBrain from '../GiaBrain';
import { SentenceChunker } from './SentenceChunker';
import { VoiceAnnouncer } from './VoiceAnnouncer';
import { routeUtterance, gateAnswer, spokenGatePrompt } from './bargeIn';
import { useTrustStore } from '../../store/useTrustStore';
import type { PermissionRequest } from '../permissions';
import { fileSnapshots } from '../FileSnapshots';
import { useGiaStore } from '../../store/useGiaStore';

/**
 * VoiceSession — the phase-1 "fast walkie-talkie" engine (wave-1 §6).
 *
 * One mic tap → conversation VAD (silero, energy fallback) → batched local
 * whisper → GiaBrain.generate → TTSService sentence-chunked playback.
 * GiaBrain is untouched: the voice turn is an ordinary generate() call, so
 * tools run mid-turn exactly as they do in chat. The voice renderer is a
 * subscriber, not a wrapper.
 *
 * Hard rules from the research reports:
 *  - one capture owner at a time — VoiceMode and the composer "listen"
 *    toggle must never hold the mic simultaneously;
 *  - nothing enters the scrollback until it's real — only endpointed,
 *    transcribed utterances are committed;
 *  - barge-in: "stop"/"quiet" keyword or the interrupt button kills speech
 *    AND the running generation;
 *  - the mic ducks while she speaks (barge-in thresholds) so speaker
 *    leakage doesn't read as the user talking.
 */

export type VoicePhase =
  | 'idle'          // engine off
  | 'listening'     // mic open, waiting for speech
  | 'capturing'     // speech energy present — buffering
  | 'transcribing'  // utterance endpointed — whisper running
  | 'thinking'      // GiaBrain generating (tools may be running)
  | 'speaking';     // TTS playing (may overlap with tool work — "acting" is
                    // rendered by the UI from tts + generation flags)

export interface VoiceSnapshot {
  phase: VoicePhase;
  error: string | null;
  /** Human phrase for the current tool/thinking state, e.g. "Reading context". */
  activity: string | null;
  /** True while a generation is running (mouth may also be speaking). */
  working: boolean;
  /** The sentence she is saying right now — the live caption. */
  caption: string | null;
  stt: typeof whisperService.status;
  vad: 'silero' | 'energy' | null;
}

export interface VoiceSessionOptions {
  /** Extra system-prompt tail (active skill, persona) — appended by VoiceMode. */
  systemPromptTail?: string;
  /** Auto re-listen after she finishes speaking. Default true. */
  auto?: boolean;
  /** Keep her answers silent (UI mute toggle). Default false. */
  muted?: boolean;
}

type Listener = (snapshot: VoiceSnapshot) => void;

const MAX_UTTERANCE_SECONDS = 30;

function newId() {
  try { return crypto.randomUUID(); } catch { return `vs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
}

class VoiceSessionImpl {
  private listeners = new Set<Listener>();
  private tap: MicTap | null = null;
  private offFrame: (() => void) | null = null;
  private vad: VAD | null = null;
  private buffering = false;
  private buffer: Float32Array[] = [];
  private bufferSamples = 0;
  private options: VoiceSessionOptions = {};
  private captionOff: (() => void) | null = null;
  /** In-flight open() — concurrent calls await it instead of racing. */
  private opening: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private closed = true;
  private disposed = false;
  /**
   * Spoken permission prompts: when the gate asks while the user is at the
   * mic, the ask is spoken and the answer can be spoken back — but ONLY for
   * low-risk asks, and only whole-utterance whitelisted phrases. Higher
   * risks are spoken as "needs the card" and must be answered on screen.
   */
  private gateUnsub: (() => void) | null = null;
  private spokenGate: { id: string; request: PermissionRequest; repeats: number } | null = null;
  /** One capture owner at a time; claimed on open, released on close. */
  private static ownerToken: symbol | null = null;

  private snapshot: VoiceSnapshot = {
    phase: 'idle',
    error: null,
    activity: null,
    working: false,
    caption: null,
    stt: 'unloaded',
    vad: null,
  };

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => { this.listeners.delete(listener); };
  }

  getSnapshot(): VoiceSnapshot {
    return this.snapshot;
  }

  get isCapturing() { return !this.closed; }

  private emit(patch: Partial<VoiceSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of Array.from(this.listeners)) {
      try { l(this.snapshot); } catch (err) { logger.error('[VoiceSession] listener error:', err); }
    }
  }

  /** Claim exclusive capture; returns null when someone else holds the mic. */
  private static claim(): symbol | null {
    if (VoiceSessionImpl.ownerToken) return null;
    VoiceSessionImpl.ownerToken = Symbol('voice-capture');
    return VoiceSessionImpl.ownerToken;
  }

  private static release(token: symbol | null) {
    if (token && VoiceSessionImpl.ownerToken === token) VoiceSessionImpl.ownerToken = null;
  }

  /**
   * Open the engine: mic + VAD + whisper model. Resolves into `listening`.
   * Rejects with a user-actionable message when the platform can't do it.
   */
  async open(options: VoiceSessionOptions = {}): Promise<void> {
    if (!this.closed) { this.options = { ...this.options, ...options }; return; }
    if (this.opening) return this.opening; // StrictMode double-mount calls open() twice
    const token = VoiceSessionImpl.claim();
    if (!token) throw new Error('Another microphone user is active. Turn off "listen" first.');
    this.disposed = false;
    this.options = options;
    this.emit({ error: null, phase: 'listening', activity: null, working: false });

    this.opening = (async () => {
      try {
        this.tap = await startMicTap();
      } catch (err) {
        VoiceSessionImpl.release(token);
        const message = (err as Error)?.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow the mic in your system settings, then try again.'
          : 'No microphone is available. Type below instead.';
        this.emit({ phase: 'idle', error: message });
        throw new Error(message);
      }

      this.vad = await createVAD();
      this.emit({ vad: this.vad.kind });

      // Local whisper only speaks English in phase 1 (tiny.en). Non-en
      // languages fall back to the browser recognizer in VoiceMode.
      this.offFrame = this.tap.onFrame((frame) => void this.onFrame(frame));
      this.closed = false;
      // Spoken permission prompts: watch the gate while the session is open.
      this.attachGateWatch();
      // Unmounted while opening (StrictMode): release everything instead of
      // leaving an open session with no UI subscribed to it.
      if (this.disposed) {
        VoiceSessionImpl.release(token);
        await this.tap.stop();
        this.tap = null;
        this.closed = true;
        throw new Error('Voice session closed while opening');
      }
      logger.log('[VoiceSession] open, vad =', this.vad.kind);
    })();

    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.disposed = true;
    this.clearCaption();
    this.abort?.abort();
    this.abort = null;
    this.buffering = false;
    this.buffer = [];
    this.bufferSamples = 0;
    if (this.offFrame) { this.offFrame(); this.offFrame = null; }
    if (this.gateUnsub) { this.gateUnsub(); this.gateUnsub = null; }
    this.spokenGate = null;
    this.vad = null;
    void stopMicTap();
    this.tap = null;
    VoiceSessionImpl.release(VoiceSessionImpl.ownerToken);
    VoiceSessionImpl.ownerToken = null;
    // A closing session must never keep held utterances trapped — the drain's
    // 5-minute staleness guard is the backstop; this is the normal path.
    if (useGiaStore.getState().queuedMessages.some(m => m.holdForVoice)) {
      useGiaStore.getState().releaseHeldQueues();
    }
    this.emit({ phase: 'idle', activity: null, working: false, vad: null });
  }

  /** User interrupt: kill speech + generation, keep listening. */
  interrupt() {
    ttsService.stop();
    this.abort?.abort();
    this.abort = null;
    this.emit({ working: false, activity: null });
    this.clearCaption();
    this.resumeListening();
  }

  /** Public: (re)arm listening after manual mode's idle pause. */
  startListening() {
    if (this.closed) return;
    this.vad?.setBargeInMode(false);
    this.vad?.reset();
    this.emit({ phase: 'listening', activity: null, working: false, error: null });
  }

  /** Walkie-talkie: send whatever is buffered right now (Space / tap). */
  async endpointNow() {
    if (this.closed || !this.buffering) return;
    await this.endpoint();
  }

  // ── VAD frame pump ───────────────────────────────────────────────────

  private async onFrame(frame: Float32Array) {
    if (this.closed || !this.vad) return;
    const phase = this.snapshot.phase;
    const decision = this.vad.feed(frame);

    // She runs the mic ducked while talking through speakers (barge-in
    // thresholds), open while thinking or waiting.
    this.vad.setBargeInMode(phase === 'speaking');

    if (!this.buffering && decision.speechStart
        && (phase === 'listening' || phase === 'thinking' || phase === 'speaking')) {
      this.buffering = true;
      this.buffer = [frame];
      this.bufferSamples = frame.length;
      if (phase === 'listening') this.emit({ phase: 'capturing' });
      return;
    }
    if (this.buffering) {
      this.buffer.push(frame);
      this.bufferSamples += frame.length;
      if (this.bufferSamples >= FRAME_SIZE * MAX_UTTERANCE_SECONDS * (1000 / 80)) {
        // Hard cap: endpoint it ourselves before memory balloons.
        await this.endpoint();
        return;
      }
      if (decision.speechEnd) await this.endpoint();
      return;
    }
  }

  private async endpoint() {
    this.buffering = false;
    const busyPhase = this.snapshot.phase === 'thinking' || this.snapshot.phase === 'speaking';
    const audio = concatFrames(this.buffer);
    this.buffer = [];
    this.bufferSamples = 0;
    if (audio.length < FRAME_SIZE * 4) {
      // Sub-320 ms blip (click, cough) — back to listening, no STT.
      this.emit({ phase: 'listening' });
      return;
    }
    if (!busyPhase) this.emit({ phase: 'transcribing' });
    let text = '';
    try {
      text = await whisperService.transcribeFloat32(audio);
    } catch (err) {
      logger.error('[VoiceSession] transcription failed:', err);
      this.emit({
        phase: 'listening',
        error: 'Could not transcribe that. Make sure the Whisper model finished downloading, or type below.',
      });
      return;
    }
    text = text.trim();
    if (!text) {
      // Confirmed-interrupt gate: a burst that transcribes to nothing was
      // speaker leakage or noise, not the user deciding to talk.
      this.emit({ phase: busyPhase ? this.snapshot.phase : 'listening' });
      return;
    }

    // Spoken permission answer takes precedence: while a gate ask is
    // outstanding, the next utterance is an ANSWER, not a task. Then go
    // straight back to listening — an answered gate must never strand the
    // session in 'transcribing'.
    if (await this.handleSpokenGateAnswer(text)) {
      if (!busyPhase) this.resumeListening();
      return;
    }

    // While she is busy, the barge-in gate decides the consequence.
    if (busyPhase) {
      const busyRoute = this.snapshot.phase === 'thinking' ? 'thinking' as const : 'speaking' as const;
      const decision = routeUtterance(text, busyRoute);
      switch (decision.action) {
        case 'interrupt':
          logger.log('[VoiceSession] barge-in keyword:', decision.keyword);
          this.interrupt();
          return;
        case 'steer':
          logger.log('[VoiceSession] steering:', text);
          useGiaStore.getState().addSteering(
            useGiaStore.getState().activeSessionId || '', text);
          useGiaStore.getState().addNotification('🎙 Heard — correction lands at the next tool boundary');
          this.speakPiece('Noted — adjusting course.');
          this.emit({ activity: 'Adjusting course' });
          return; // she keeps working; the note lands at the next tool group
        case 'park':
          // Handshake: the parked utterance becomes a VISIBLE, cancellable
          // card in the chat queue, held until playback ends.
          this.parkUtterance(decision.text);
          return;
        case 'revert':
          await this.performRevert();
          return;
        default:
          return;
      }
    }

    // Spoken undo works while idle too — it acts on the last COMPLETED write,
    // never on anything in flight, so there is nothing to race.
    if (routeUtterance(text, 'listening').action === 'revert') {
      await this.performRevert();
      return;
    }

    await this.handleUtterance(text);
  }

  /**
   * Watch the permission gate while voice is open. When a prompt reaches the
   * head of the queue and the user is present at the mic, the ask is spoken.
   * Low-risk asks can be answered by voice; anything higher is directed to
   * the card — a spoken "yes" must never unlock a dangerous action the user
   * has not SEEN.
   */
  private attachGateWatch() {
    if (this.gateUnsub) return;
    let lastPendingId: string | null = null;
    this.gateUnsub = useTrustStore.subscribe((s) => {
      if (this.closed || this.disposed) return;
      const head = s.pending;
      if (!head) {
        // Answered on the card, timed out, or revoked — either way the
        // spoken question is void now.
        this.spokenGate = null;
        lastPendingId = null;
        return;
      }
      const id = head.request.id;
      if (id === lastPendingId && this.spokenGate?.id === id) return;
      lastPendingId = id;
      // Only speak when the user is present at the mic — not while she is
      // mid-turn, where the ask would collide with her speech.
      const phase = this.snapshot.phase;
      if (phase !== 'listening' && phase !== 'capturing') return;
      this.spokenGate = { id, request: head.request, repeats: 0 };
      const risk = head.request.risk;
      const sayThis = spokenGatePrompt(head.request.toolName, head.request.headline, risk);
      const voiceAnswerable = risk === 'none' || risk === 'low';
      this.emit({ activity: voiceAnswerable ? 'Asking permission — say do it, or no' : 'Asking permission — needs the card' });
      this.speakPiece(sayThis);
    });
  }

  /** Answer a spoken permission prompt, or re-ask once, or stand down. */
  private async handleSpokenGateAnswer(text: string): Promise<boolean> {
    const gate = this.spokenGate;
    if (!gate) return false;
    const answer = gateAnswer(text);
    if (!answer) {
      // Not an answer — re-ask once, then leave the card to do its job.
      gate.repeats++;
      if (gate.repeats > 1) {
        this.spokenGate = null;
        this.speakPiece('I will leave it on the card.');
        return true;
      }
      const risk = gate.request.risk;
      this.speakPiece(spokenGatePrompt(gate.request.toolName, gate.request.headline, risk));
      return true;
    }
    const voiceAnswerable = gate.request.risk === 'none' || gate.request.risk === 'low';
    if (answer === 'deny') {
      this.spokenGate = null;
      useTrustStore.getState().resolve('deny');
      this.speakPiece('Denied.');
      return true;
    }
    if (!voiceAnswerable) {
      // A spoken yes must never unlock a moderate+ action unseen.
      this.speakPiece('Use the card on screen for this one.');
      return true;
    }
    this.spokenGate = null;
    useTrustStore.getState().resolve('once');
    this.speakPiece('Doing it.');
    return true;
  }

  /**
   * Park an utterance heard while she was talking. It goes through the store
   * queue (visible, cancellable in QueuedMessages) held until playback ends,
   * then the normal drain delivers it as an ordinary turn.
   */
  private parkUtterance(text: string) {
    const store = useGiaStore.getState();
    const sessionId = store.activeSessionId;
    if (!sessionId) return;
    logger.log('[VoiceSession] parking utterance until playback ends');
    store.enqueueMessage({
      id: newId(),
      sessionId,
      text,
      attachments: [],
      queuedAt: Date.now(),
      holdForVoice: true,
      origin: 'voice',
    });
  }

  /**
   * Spoken undo: revert GIA's most recent surviving write. User-initiated
   * (like the Undo page) — it acts on completed writes only, so it never
   * races work in flight, and it never needs the agent permission gate.
   */
  private async performRevert() {
    const snaps = fileSnapshots.listPending();
    if (snaps.length === 0) {
      this.speakPiece('Nothing to undo.');
      return;
    }
    const latest = snaps[0]; // newest first
    const res = await fileSnapshots.revert(latest.id);
    const name = latest.path.split('/').pop() || latest.path;
    if (res.success) {
      logger.log('[VoiceSession] spoken revert:', latest.path);
      this.speakPiece(`Reverted ${name}.`);
      useGiaStore.getState().addNotification(`🎙 Reverted ${latest.path} (spoken undo)`);
    } else {
      logger.warn('[VoiceSession] spoken revert failed:', res.error);
      this.speakPiece(`Could not revert ${name}.`);
    }
  }

  private speakPiece(text: string) {
    if (this.disposed || this.options.muted || !text) return;
    void ttsService.speak(text, true).catch((e: unknown) => logger.warn('[VoiceSession] speak failed:', e));
  }

  /** Playback ended: release voice-parked queue items so the normal drain
   *  delivers them as ordinary turns. */
  private releasePending() {
    if (this.closed || this.disposed) return;
    const store = useGiaStore.getState();
    if (store.queuedMessages.some(m => m.holdForVoice)) {
      store.releaseHeldQueues(store.activeSessionId || undefined);
    }
  }

  // ── Turn handling ────────────────────────────────────────────────────

  /** Commit a real utterance into the session and run the brain. */
  async handleUtterance(text: string) {
    const clean = text.trim();
    if (!clean) { this.resumeListening(); return; }

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
      origin: 'voice',
    });
    this.onUserUtterance?.(clean);
    if (session && session.title === 'New Chat') {
      store.updateSessionTitle(sessionId, clean.slice(0, 42));
    }

    this.emit({ phase: 'thinking', activity: null, working: true });
    const controller = new AbortController();
    this.abort = controller;

    // Phase 2: she speaks WHILE she thinks. Stream chunks go through the
    // sentence chunker into the already sentence-buffering TTS queue; tool
    // announcements flow through the whitelisted announcer. The finished
    // answer is only spoken via speakFinal when NOTHING was streamed
    // (providers without onStream), so she never says it twice.
    const chunker = new SentenceChunker();
    const announcer = new VoiceAnnouncer();
    let streamedAny = false;
    // Live caption: the sentence she is saying right now (TTS emission events).
    this.captionOff?.();
    this.captionOff = ttsService.onSentence((sentence: string) => {
      if (!this.disposed) this.emit({ caption: sentence });
    });
    const speakPiece = (text: string) => {
      if (this.disposed || this.options.muted || !text) return;
      void ttsService.speak(text, true).catch((e: unknown) => logger.warn('[VoiceSession] speak failed:', e));
    };

    try {
      const res = await GiaBrain.generate({
        prompt: clean,
        history,
        systemPrompt: `You are GIA, speaking in voice mode. The user is talking to you directly. Be conversational, concise, and natural — like a knowledgeable friend. Keep responses under 3 sentences unless the user asked for detail. No markdown, no bullet points, no headers — just natural spoken language. ${this.options.systemPromptTail ?? ''}`,
        signal: controller.signal,
        onStream: (chunk) => {
          if (controller.signal.aborted) return;
          streamedAny = true;
          for (const sentence of chunker.feed(chunk)) this.speakPiece(sentence);
        },
        onThought: (thought) => {
          if (controller.signal.aborted) return;
          const phrase = announcer.onThought(thought);
          if (phrase) {
            this.emit({ activity: announcer.activity });
            this.speakPiece(phrase);
          }
        },
      });

      if (controller.signal.aborted) { this.resumeListening(); return; }

      const reply = res.text.trim() || 'I did not get a response. Try that again.';
      useGiaStore.getState().addMessage(sessionId, {
        id: newId(),
        role: 'assistant',
        content: reply,
        timestamp: Date.now(),
        model: res.model,
      });

      this.abort = null;
      this.emit({ phase: 'speaking', working: false, activity: null });
      // Announce completion to the transcript layer; VoiceMode appends the
      // turn from the store.
      this.onAssistantReply?.(reply, sessionId);
      if (!this.options.muted) {
        try {
          if (streamedAny) {
            // Flush the tail through the SAME queue — speakFinal would stop()
            // the in-flight sentences first and then replay the whole text.
            for (const sentence of chunker.flush()) this.speakPiece(sentence);
          } else {
            await ttsService.speakFinal(reply);
          }
        } catch (e) { logger.warn('[VoiceSession] speech failed:', e); }
      }
      if (this.disposed) return;
      if (this.abort) { this.resumeListening(); return; } // interrupted during speech
      this.releasePending();
      this.resumeListening();
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') { this.resumeListening(); return; }
      if (this.disposed) return;
      logger.error('[VoiceSession] generation failed:', e);
      this.emit({ phase: 'listening', working: false, error: e instanceof Error ? e.message : 'Generation failed' });
    } finally {
      this.abort = null;
    }
  }

  /** Fired after the user's turn is persisted, for UI transcript sync. */
  onUserUtterance: ((text: string) => void) | null = null;
  /** Fired after the assistant turn is persisted, for UI transcript sync. */
  onAssistantReply: ((reply: string, sessionId: string) => void) | null = null;

  /** Update live options (mute toggle) without reopening the engine. */
  setOption<K extends keyof VoiceSessionOptions>(key: K, value: VoiceSessionOptions[K]) {
    this.options = { ...this.options, [key]: value };
  }

  private clearCaption() {
    this.captionOff?.();
    this.captionOff = null;
    if (this.snapshot.caption) this.emit({ caption: null });
  }

  private resumeListening() {
    if (this.closed || this.disposed) return;
    this.clearCaption();
    if (this.options.auto === false) {
      this.emit({ phase: 'idle', activity: null, working: false });
      return;
    }
    this.vad?.setBargeInMode(false);
    this.vad?.reset();
    this.emit({ phase: 'listening', working: false, activity: null });
  }
}

export const voiceSession = new VoiceSessionImpl();
