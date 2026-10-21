import { useEffect, useState } from 'react';
import { useGiaStore } from '../store/useGiaStore';
import { useAgentStore } from '../store/useAgentStore';
import { GIA_BOTS, syncGiaBots } from './GiaBots';
import { STUDIO_AGENTS, syncStudioSkills } from '../services/studio/devAgents';
import { COUNCIL_HEAD, COUNCIL_SEATS, syncCouncilSkills } from './Council';

interface Row {
  id: string;
  name: string;
  role: string;
  fallback: string;
  kind: 'skill' | 'custom';
}

function useRows(): { group: string; rows: Row[] }[] {
  const custom = useAgentStore(s => s.agents);
  const skills = [
    ...GIA_BOTS.map(b => ({ id: b.id, name: b.name, role: b.role, fallback: b.systemPrompt, kind: 'skill' as const })),
    ...STUDIO_AGENTS.map(b => ({ id: b.id, name: b.name, role: b.role, fallback: b.systemPrompt, kind: 'skill' as const })),
    ...COUNCIL_SEATS.map(b => ({ id: b.id, name: b.name, role: b.role, fallback: b.systemPrompt, kind: 'skill' as const })),
    { id: COUNCIL_HEAD.id, name: COUNCIL_HEAD.name, role: COUNCIL_HEAD.role, fallback: COUNCIL_HEAD.systemPrompt, kind: 'skill' as const },
  ];
  return [
    { group: 'Chat', rows: skills.slice(0, GIA_BOTS.length) },
    { group: 'Studio', rows: skills.slice(GIA_BOTS.length, GIA_BOTS.length + STUDIO_AGENTS.length) },
    { group: 'Council', rows: skills.slice(GIA_BOTS.length + STUDIO_AGENTS.length) },
    { group: 'Yours', rows: custom.map(a => ({ id: a.id, name: a.name, role: 'Custom', fallback: a.systemPrompt, kind: 'custom' as const })) },
  ];
}

function PromptCard({ row }: { row: Row }) {
  const saved = useGiaStore(s => s.skills.find(sk => sk.id === row.id)?.systemPrompt);
  const customSaved = useAgentStore(s => s.agents.find(a => a.id === row.id)?.systemPrompt);
  const current = row.kind === 'custom' ? (customSaved ?? row.fallback) : (saved ?? row.fallback);
  const [text, setText] = useState(current);
  const [note, setNote] = useState('');

  useEffect(() => { setText(current); }, [current]);

  const save = () => {
    const next = text.trim();
    if (!next) {
      setNote('A prompt cannot be empty.');
      return;
    }
    if (row.kind === 'custom') {
      useAgentStore.getState().updateAgent(row.id, { systemPrompt: next });
    } else {
      const gia = useGiaStore.getState();
      if (gia.skills.some(s => s.id === row.id)) gia.updateSkill(row.id, { systemPrompt: next });
      else gia.addSkill({ id: row.id, name: row.name, description: row.role, systemPrompt: next, tools: [], category: 'user' });
    }
    setNote('Saved. The next reply uses this.');
  };

  const reset = () => {
    setText(row.fallback);
    setNote('');
  };

  return (
    <article className="rounded-2xl p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium" style={{ color: 'var(--gia-text)' }}>{row.name}</p>
        <p className="text-[10px] uppercase tracking-wide" style={{ color: 'rgba(214,198,161,0.7)' }}>{row.role}</p>
      </div>
      <textarea
        value={text}
        onChange={e => { setText(e.target.value); setNote(''); }}
        aria-label={`${row.name} system prompt`}
        rows={5}
        className="mt-2 w-full rounded-xl px-3 py-2 text-[12px] leading-relaxed outline-none resize-y"
        style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
      />
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={save} className="h-7 px-3 rounded-full text-[11px] font-medium" style={{ background: '#f4efe4', color: '#1a1610' }}>
          Save
        </button>
        {text !== row.fallback && (
          <button type="button" onClick={reset} className="h-7 px-3 rounded-full text-[11px]" style={{ color: 'var(--gia-muted)' }}>
            Restore
          </button>
        )}
        {note && <span className="text-[11px]" style={{ color: 'var(--gia-muted)' }}>{note}</span>}
      </div>
    </article>
  );
}

/** Every agent's instructions, visible and editable. Saved prompts are what the next reply uses. */
export default function AgentPrompts() {
  const groups = useRows();
  useEffect(() => {
    syncGiaBots();
    syncStudioSkills();
    syncCouncilSkills();
  }, []);

  return (
    <div className="h-full overflow-y-auto px-5 py-4 space-y-5" data-testid="agent-prompts">
      <div>
        <h2 className="text-[15px] font-medium" style={{ color: 'var(--gia-text)' }}>Prompts</h2>
        <p className="text-[12px] mt-1" style={{ color: 'var(--gia-muted)' }}>This is the instruction each agent actually follows. Save, then talk.</p>
      </div>
      {groups.map(group => (
        group.rows.length === 0 ? null : (
          <section key={group.group} className="space-y-2">
            <h3 className="text-[11px] uppercase tracking-wide" style={{ color: 'rgba(214,198,161,0.7)' }}>{group.group}</h3>
            {group.rows.map(row => <PromptCard key={row.id} row={row} />)}
          </section>
        )
      ))}
    </div>
  );
}
