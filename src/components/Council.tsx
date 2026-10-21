import { useEffect, useRef, useState } from 'react';
import GiaBrain from '../services/GiaBrain';
import { useGiaStore } from '../store/useGiaStore';
import { livePrompt } from '../services/studio/devAgents';

type Phase = 'idle' | 'sitting' | 'verdict' | 'done';
type SeatStatus = 'waiting' | 'speaking' | 'done' | 'failed';

export const COUNCIL_SEATS = [
  {
    id: 'council-scout',
    name: 'Scout',
    role: 'Facts',
    systemPrompt: `You are Scout, one seat on GIA's council. Your only job is facts.
State only what can be checked. Name the assumption you are making. Three sentences at most. Do not recommend.`,
  },
  {
    id: 'council-lens',
    name: 'Lens',
    role: 'Objection',
    systemPrompt: `You are Lens, one seat on GIA's council. Your only job is the objection.
Name the strongest reason not to do this. One concrete failure, not a list. Three sentences at most.`,
  },
  {
    id: 'council-proof',
    name: 'Proof',
    role: 'Test',
    systemPrompt: `You are Proof, one seat on GIA's council. Your only job is the test.
Say how the user will know the decision was right. One check. Three sentences at most.`,
  },
  {
    id: 'council-forge',
    name: 'Forge',
    role: 'Move',
    systemPrompt: `You are Forge, one seat on GIA's council. Your only job is the move.
Name the smallest action that changes the outcome. Not a plan. Three sentences at most.`,
  },
] as const;

export const COUNCIL_HEAD = {
  id: 'council-head',
  name: 'GIA',
  role: 'Verdict',
  systemPrompt: `You are GIA, head of this council. The seats have already spoken. You did not.
Do not repeat their notes. Do not average them.
Write a verdict in three short parts:
1. The decision, in one sentence.
2. The risk you are accepting, and whose objection you are setting aside.
3. The single next action.
If a seat failed or said nothing useful, ignore it and say so in one clause.`,
};

export function syncCouncilSkills() {
  const { skills } = useGiaStore.getState();
  const have = new Set(skills.map(s => s.id));
  const missing = [...COUNCIL_SEATS, COUNCIL_HEAD].filter(s => !have.has(s.id));
  if (missing.length === 0) return;
  useGiaStore.setState({
    skills: [
      ...skills,
      ...missing.map(s => ({
        id: s.id,
        name: s.name,
        description: s.role,
        systemPrompt: s.systemPrompt,
        tools: [] as string[],
        category: 'core' as const,
      })),
    ],
  });
}

interface Seat {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  text: string;
  status: SeatStatus;
}

function freshSeats(): Seat[] {
  return COUNCIL_SEATS.map(s => ({ ...s, text: '', status: 'waiting' }));
}

async function speak(
  systemPrompt: string,
  prompt: string,
  onChunk: (chunk: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const result = await GiaBrain.generate({
    prompt,
    systemPrompt,
    signal,
    onStream: onChunk,
  });
  return result.text || '';
}

export default function Council({ initialPrompt = '' }: { initialPrompt?: string }) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [phase, setPhase] = useState<Phase>('idle');
  const [seats, setSeats] = useState<Seat[]>(freshSeats);
  const [verdict, setVerdict] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => { syncCouncilSkills(); }, []);

  const patch = (id: string, next: Partial<Seat>) => {
    setSeats(prev => prev.map(s => (s.id === id ? { ...s, ...next } : s)));
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase('done');
  };

  const convene = async () => {
    const ask = prompt.trim();
    if (ask.length < 8 || phase === 'sitting' || phase === 'verdict') return;
    syncCouncilSkills();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    setVerdict('');
    setSeats(freshSeats());
    setPhase('sitting');

    const spoken = await Promise.all(COUNCIL_SEATS.map(async (seat) => {
      patch(seat.id, { status: 'speaking', text: '' });
      try {
        let text = '';
        const full = await speak(
          livePrompt(seat.id, seat.systemPrompt),
          ask,
          (chunk) => {
            text += chunk;
            patch(seat.id, { text, status: 'speaking' });
          },
          controller.signal,
        );
        const body = (full || text).trim();
        patch(seat.id, { text: body, status: 'done' });
        return { name: seat.name, role: seat.role, text: body };
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'AbortError') throw e;
        const message = e instanceof Error ? e.message : 'This seat failed';
        patch(seat.id, { status: 'failed', text: message });
        return { name: seat.name, role: seat.role, text: `(failed: ${message})` };
      }
    })).catch((e: unknown) => {
      if (e instanceof Error && e.name === 'AbortError') return null;
      setError(e instanceof Error ? e.message : 'The council stopped');
      return null;
    });

    if (!spoken || controller.signal.aborted) {
      if (!controller.signal.aborted) setPhase('done');
      return;
    }

    setPhase('verdict');
    const packet = spoken.map(s => `## ${s.name} (${s.role})\n${s.text}`).join('\n\n');
    try {
      let text = '';
      const full = await speak(
        livePrompt(COUNCIL_HEAD.id, COUNCIL_HEAD.systemPrompt),
        `The question:\n${ask}\n\nWhat the seats said:\n${packet}`,
        (chunk) => {
          text += chunk;
          setVerdict(text);
        },
        controller.signal,
      );
      setVerdict((full || text).trim());
      setPhase('done');
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : 'The head could not speak');
      setPhase('done');
    }
  };

  const busy = phase === 'sitting' || phase === 'verdict';
  const heard = seats.filter(s => s.status === 'done' || s.status === 'failed').length;

  return (
    <div className="flex flex-col h-full" data-testid="council" style={{ background: 'var(--gia-bg)' }}>
      <div className="px-5 pt-4 pb-3 shrink-0" style={{ borderBottom: '1px solid var(--gia-border)' }}>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-medium" style={{ color: 'var(--gia-text)' }}>Council</h2>
          <p className="text-[11px]" style={{ color: 'var(--gia-muted)' }}>
            {phase === 'sitting' ? `${heard} of ${seats.length} have spoken` : phase === 'verdict' ? 'GIA is deciding' : 'Four seats. One verdict.'}
          </p>
        </div>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          aria-label="Question for the council"
          rows={3}
          placeholder="The decision you want them to argue."
          className="mt-3 w-full rounded-xl px-3 py-2 text-[13px] outline-none resize-y"
          style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={prompt.trim().length < 8 || busy}
            onClick={() => { void convene(); }}
            className="h-8 px-3 rounded-full text-[12px] font-medium disabled:opacity-40"
            style={{ background: '#f4efe4', color: '#1a1610' }}
          >
            {busy ? 'In session' : 'Convene'}
          </button>
          {busy && (
            <button type="button" onClick={stop} className="h-8 px-3 rounded-full text-[12px]" style={{ border: '1px solid var(--gia-border)', color: 'var(--gia-muted)' }}>
              Stop
            </button>
          )}
        </div>
        {error && <p className="mt-2 text-[12px]" style={{ color: '#f87171' }}>{error}</p>}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {seats.map(seat => (
            <article
              key={seat.id}
              className="rounded-2xl p-3 min-h-[120px]"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: `1px solid ${seat.status === 'speaking' ? 'rgba(244,239,228,0.45)' : 'rgba(255,255,255,0.06)'}`,
              }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[13px] font-medium" style={{ color: 'var(--gia-text)' }}>{seat.name}</p>
                <p className="text-[10px] uppercase tracking-wide" style={{ color: 'rgba(214,198,161,0.7)' }}>
                  {seat.status === 'waiting' ? 'Waiting' : seat.status === 'speaking' ? 'Speaking' : seat.status === 'failed' ? 'Failed' : seat.role}
                </p>
              </div>
              <p className="mt-2 text-[12px] leading-relaxed whitespace-pre-wrap" style={{ color: seat.text ? 'var(--gia-text)' : 'var(--gia-muted)' }}>
                {seat.text || 'Waiting to speak.'}
              </p>
            </article>
          ))}
        </div>

        <article
          className="rounded-2xl p-4"
          style={{ background: 'rgba(244,239,228,0.06)', border: '1px solid rgba(244,239,228,0.28)' }}
        >
          <p className="text-[11px] tracking-[0.16em] uppercase" style={{ color: 'rgba(214,198,161,0.8)' }}>GIA · verdict</p>
          <p className="mt-2 text-[14px] leading-relaxed whitespace-pre-wrap" style={{ color: verdict ? 'var(--gia-text)' : 'var(--gia-muted)' }}>
            {verdict || (phase === 'verdict' ? 'Reading the seats…' : 'She speaks after the seats finish. Not before.')}
          </p>
        </article>
      </div>
    </div>
  );
}
