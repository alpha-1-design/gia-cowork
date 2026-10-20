import { useState } from 'react';
import { useAgentStore } from '../store/useAgentStore';
import { useGiaStore } from '../store/useGiaStore';
import { STUDIO_AGENTS, studioBrief, systemPromptFor } from '../services/studio/devAgents';
import { runStudioLane } from '../services/studio/runLane';

const READ_LANES = ['studio-scout', 'studio-lens', 'studio-proof'] as const;

/**
 * Development studio.
 * Review lanes run together and only read.
 * Implement and pull request go to chat, because that is the agent with tools.
 */
export default function DevStudio() {
  const custom = useAgentStore(s => s.agents || []);
  const [repo, setRepo] = useState('alpha-1-design/gia-cowork');
  const [task, setTask] = useState('');
  const [note, setNote] = useState('');

  const ready = task.trim().length >= 8;

  const sendToChat = (text: string) => {
    const gia = useGiaStore.getState();
    gia.setModule('chat');
    gia.setPendingAction({ type: 'send-message', data: { text } });
  };

  const runParallel = (ids: string[]) => {
    if (!ready) return;
    const brief = studioBrief(repo, task);
    for (const id of ids) {
      const agent = STUDIO_AGENTS.find(a => a.id === id);
      if (!agent || agent.writes) continue;
      runStudioLane(agent, brief, agent.systemPrompt);
    }
    setNote(`${ids.length} lanes running. They only read.`);
  };

  const runCustom = (id: string) => {
    if (!ready) return;
    const agent = custom.find(a => a.id === id);
    if (!agent) return;
    runStudioLane(
      {
        id: agent.id,
        name: agent.name,
        role: 'Custom',
        color: '#d6c6a1',
        icon: agent.icon || 'Bot',
        writes: false,
        systemPrompt: agent.systemPrompt,
      },
      studioBrief(repo, task),
      systemPromptFor({ name: agent.name, role: 'Custom' }, agent),
    );
    setNote(`${agent.name} is on the task. Custom agents do not push unless their prompt says so.`);
  };

  const implement = () => {
    if (!ready) return;
    const forge = STUDIO_AGENTS.find(a => a.id === 'studio-forge')!;
    runParallel(['studio-scout']);
    sendToChat(`${forge.systemPrompt}\n\n${studioBrief(repo, task)}`);
  };

  const openPr = () => {
    if (!ready) return;
    const harbor = STUDIO_AGENTS.find(a => a.id === 'studio-harbor')!;
    runParallel(['studio-lens', 'studio-proof']);
    sendToChat(`${harbor.systemPrompt}\n\n${studioBrief(repo, task)}\n\nOpen the pull request only for this task.`);
  };

  return (
    <section className="px-5 py-4" data-testid="dev-studio" style={{ borderBottom: '1px solid var(--gia-border)' }}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-medium" style={{ color: 'var(--gia-text)' }}>Studio</h2>
        <p className="text-[11px]" style={{ color: 'var(--gia-muted)' }}>Parallel readers. One writer.</p>
      </div>
      <input
        value={repo}
        onChange={e => setRepo(e.target.value)}
        aria-label="Repository"
        className="mt-3 w-full rounded-lg px-3 py-2 text-[12px] outline-none"
        style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
      />
      <textarea
        value={task}
        onChange={e => setTask(e.target.value)}
        aria-label="Studio task"
        rows={3}
        placeholder="What should change, and how you will know it worked."
        className="mt-2 w-full rounded-lg px-3 py-2 text-[12px] outline-none resize-y"
        style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={!ready} onClick={() => runParallel([...READ_LANES])} className="h-8 px-3 rounded-full text-[12px] disabled:opacity-40" style={{ border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}>
          Review in parallel
        </button>
        <button type="button" disabled={!ready} onClick={implement} className="h-8 px-3 rounded-full text-[12px] disabled:opacity-40" style={{ background: '#f4efe4', color: '#1a1610' }}>
          Implement
        </button>
        <button type="button" disabled={!ready} onClick={openPr} className="h-8 px-3 rounded-full text-[12px] disabled:opacity-40" style={{ border: '1px solid rgba(147,197,253,0.5)', color: '#dbeafe' }}>
          Open pull request
        </button>
      </div>
      {custom.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {custom.map(a => (
            <button key={a.id} type="button" disabled={!ready} onClick={() => runCustom(a.id)} className="h-7 px-2.5 rounded-full text-[11px] disabled:opacity-40" style={{ border: '1px solid var(--gia-border)', color: 'var(--gia-muted)' }}>
              {a.name}
            </button>
          ))}
        </div>
      )}
      {note && <p className="mt-2 text-[11px]" style={{ color: 'var(--gia-muted)' }}>{note}</p>}
    </section>
  );
}
