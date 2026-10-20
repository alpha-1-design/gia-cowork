import { useEffect } from 'react';
import { useGiaStore, type Skill } from '../store/useGiaStore';

/** Built-in GIA bots. Same idea as a model bot: a named mind with a job. */
export const GIA_BOTS: {
  id: string;
  name: string;
  mark: string;
  role: string;
  blurb: string;
  systemPrompt: string;
  tools: string[];
  category: Skill['category'];
}[] = [
  {
    id: 'core-general',
    name: 'GIA',
    mark: 'G',
    role: 'Principal',
    blurb: 'Decides, acts, and asks before anything risky.',
    category: 'core',
    tools: ['web_search', 'terminal_run', 'filesystem_read', 'filesystem_write'],
    systemPrompt: `You are GIA, the principal agent in this room.
Speak once, clearly, and then act. Lead with the result. Name the tool you are using and what it returned. Ask one precise question only when the answer would change the work. Before anything destructive or outside the folder the user named, stop and ask. When a task will recur, leave a skill or a note behind. No filler. No performance of busyness.`,
  },
  {
    id: 'core-developer',
    name: 'Code',
    mark: 'C',
    role: 'Engineer',
    blurb: 'Reads first. Smallest change. Checks before claiming it works.',
    category: 'dev',
    tools: ['web_search', 'terminal_run', 'filesystem_read', 'filesystem_write', 'zip_project'],
    systemPrompt: `You are Code, GIA's engineering bot.
Read the surrounding code before you write. Make the smallest change that fully solves the problem. Match the file's own style. Run the check before you claim it works. Report the files you touched and one thing you noticed but did not change. No redesigns you were not asked for.`,
  },
  {
    id: 'skill-researcher',
    name: 'Research',
    mark: 'R',
    role: 'Analyst',
    blurb: 'Evidence first. Says when the sources do not settle it.',
    category: 'core',
    tools: ['web_search', 'filesystem_read', 'filesystem_write'],
    systemPrompt: `You are Research, GIA's evidence bot.
Search before you state anything that could have changed. Separate what a source shows from what you infer. Prefer primary sources. Lead with the finding, then the date and the source. If the evidence does not settle it, say so. Do not stack repeats of one press release and call it confirmation.`,
  },
  {
    id: 'skill-creative',
    name: 'Writer',
    mark: 'W',
    role: 'Voice',
    blurb: 'One strong draft, in your register. No throat-clearing.',
    category: 'creative',
    tools: ['web_search', 'image_generation'],
    systemPrompt: `You are Writer, GIA's voice bot.
Write in the user's register, not a generic brand voice. Cut the first sentence if it is throat-clearing. Offer one strong version, then at most one alternate. Name the choice you made and why. Do not decorate.`,
  },
  {
    id: 'skill-tutor',
    name: 'Tutor',
    mark: 'T',
    role: 'Teacher',
    blurb: 'Leads you to the answer. Does not hand it over.',
    category: 'core',
    tools: ['web_search', 'filesystem_read'],
    systemPrompt: `You are Tutor, GIA's teaching bot.
Never open with the final answer. Ask the next useful question. Point at the exact step that failed. When they get it right, say why it works in one line. Match the level they are actually at.`,
  },
  {
    id: 'skill-security',
    name: 'Sentinel',
    mark: 'S',
    role: 'Guard',
    blurb: 'The flaw, the trigger, and the smallest fix.',
    category: 'dev',
    tools: ['terminal_run', 'filesystem_read', 'web_search'],
    systemPrompt: `You are Sentinel, GIA's security bot.
Name the concrete flaw, the condition that triggers it, and the smallest fix. Do not lecture the whole OWASP list. If you are unsure, say what you would need to confirm it. Prefer least privilege.`,
  },
];

/** Keep stock bots current without touching skills the user authored. */
export function syncGiaBots() {
  const { skills } = useGiaStore.getState();
  const byId = new Map(skills.map(s => [s.id, s]));
  let changed = false;
  const next = skills.map(s => {
    const bot = GIA_BOTS.find(b => b.id === s.id);
    if (!bot) return s;
    if (s.systemPrompt === bot.systemPrompt && s.name === bot.name && s.description === bot.role) return s;
    changed = true;
    return { ...s, name: bot.name, description: bot.role, systemPrompt: bot.systemPrompt, icon: bot.mark };
  });
  for (const bot of GIA_BOTS) {
    if (!byId.has(bot.id)) {
      changed = true;
      next.push({
        id: bot.id,
        name: bot.name,
        description: bot.role,
        systemPrompt: bot.systemPrompt,
        tools: bot.tools,
        category: bot.category,
        icon: bot.mark,
      });
    }
  }
  if (changed) useGiaStore.setState({ skills: next });
}

export function botPortrait(id: string): string {
  const map: Record<string, string> = {
    'core-general': 'gia',
    'core-developer': 'code',
    'skill-researcher': 'research',
    'skill-creative': 'writer',
    'skill-tutor': 'tutor',
    'skill-security': 'sentinel',
  };
  return `./bots/${map[id] ?? 'gia'}.jpg`;
}

function useBots() {
  const activeSkillId = useGiaStore(s => s.activeSkillId);
  useEffect(() => { syncGiaBots(); }, []);
  const pick = (id: string) => {
    const s = useGiaStore.getState();
    const sess = s.sessions.find(x => x.id === s.activeSessionId);
    if (sess && sess.messages.length > 0 && (s.activeSkillId ?? 'core-general') !== id) {
      s.createSession();
    }
    s.setSkill(id);
  };
  const active = activeSkillId ?? 'core-general';
  return { pick, active };
}

/** Empty-room roster. One portrait per bot, like a Grok bot picker. Picking one opens its own chat. */
export function GiaBotRoster() {
  const { pick, active } = useBots();
  return (
    <div className="w-full max-w-xl" data-testid="gia-bot-roster">
      <div className="grid grid-cols-3 gap-x-3 gap-y-5">
        {GIA_BOTS.map(bot => {
          const on = active === bot.id;
          return (
            <button
              key={bot.id}
              type="button"
              onClick={() => pick(bot.id)}
              className="flex flex-col items-center text-center"
            >
              <span
                className="rounded-full overflow-hidden"
                style={{
                  width: 84,
                  height: 84,
                  boxShadow: on ? '0 0 0 2px #f4efe4, 0 0 0 4px #1a1610' : '0 0 0 1px rgba(255,255,255,0.08)',
                }}
              >
                <img src={botPortrait(bot.id)} alt="" className="w-full h-full object-cover" draggable={false} />
              </span>
              <span className="mt-2 text-[13px] font-medium" style={{ color: 'var(--gia-text)' }}>{bot.name}</span>
              <span className="mt-0.5 text-[11px] leading-snug max-w-[140px]" style={{ color: 'var(--gia-muted)' }}>{bot.blurb}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function GiaBots() {
  return null;
}
