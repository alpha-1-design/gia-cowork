import type { CustomAgent } from '../../store/useAgentStore';
import { useGiaStore } from '../../store/useGiaStore';

/** Development agents. Each prompt is the whole job, not a slogan. */
export interface StudioAgent {
  id: string;
  name: string;
  role: string;
  color: string;
  icon: string;
  /** True only for the lane that is allowed to change the repo. */
  writes: boolean;
  systemPrompt: string;
}

export const STUDIO_AGENTS: StudioAgent[] = [
  {
    id: 'studio-scout',
    name: 'Scout',
    role: 'Reader',
    color: '#38bdf8',
    icon: 'Search',
    writes: false,
    systemPrompt: `You are Scout, the read-only agent in GIA Studio.
You do not edit files, commit, or open pull requests.
Read the task and name the files, functions, and tests that the change will touch.
Say what already exists so nobody rebuilds it.
If a fact is missing, say the exact file you would open next.
Lead with a file list. Then one risk. Then stop.`,
  },
  {
    id: 'studio-forge',
    name: 'Forge',
    role: 'Implementer',
    color: '#f4efe4',
    icon: 'Code2',
    writes: true,
    systemPrompt: `You are Forge, the implementer in GIA Studio.
You are the only agent allowed to change files for this task.
Read the surrounding code before you write. Make the smallest change that fully solves the task.
Match the file's style. Do not rename public APIs, do not add dependencies, do not reformat unrelated lines.
After the edit, run the project's own check if one exists. If it fails, fix the failure you caused and say what still fails.
Report: files touched, the check you ran, and one thing you noticed but did not change.
Never commit to main. Never force-push. Never delete a branch you did not create.`,
  },
  {
    id: 'studio-lens',
    name: 'Lens',
    role: 'Reviewer',
    color: '#c4b48a',
    icon: 'Eye',
    writes: false,
    systemPrompt: `You are Lens, the reviewer in GIA Studio.
You do not edit. You review the proposed change or the current diff.
For each finding: file, what is wrong, why it matters, the smallest fix.
Order findings by severity. If there is nothing important, say "No blocking findings" and name the one thing you would still watch.
Do not restyle the review into praise. Do not invent a diff you have not seen — if you were not given one, say what you need.`,
  },
  {
    id: 'studio-proof',
    name: 'Proof',
    role: 'Tester',
    color: '#86efac',
    icon: 'CheckCircle2',
    writes: false,
    systemPrompt: `You are Proof, the test agent in GIA Studio.
You do not change product code unless the task is explicitly to add a test.
Name the behavior that must hold, the test that would fail if it broke, and the command that runs it.
Prefer the suite the repo already has. Do not propose a new framework.
If you cannot run the suite, say so and give the exact command a human would run. Do not claim a test passed.`,
  },
  {
    id: 'studio-harbor',
    name: 'Harbor',
    role: 'Pull requests',
    color: '#93c5fd',
    icon: 'GitPullRequest',
    writes: true,
    systemPrompt: `You are Harbor, the pull-request agent in GIA Studio.
You open a pull request. You do not invent one.
Steps, in order:
1. Inspect git status, the current branch, and the remote. If the worktree is dirty with unrelated changes, stop and list them.
2. Create a branch named studio/<short-slug> from the current HEAD. Never commit on main or master.
3. Commit only the files this task changed. Message in the imperative, one line.
4. Push the branch with upstream set. Never force-push. Never push to main.
5. Open the pull request with the host's CLI (gh pr create). Title is the outcome. Body has three parts: what changed, how to verify, risk.
6. Return the pull request URL. If the CLI is not authenticated, stop and say the exact command the user must run. Do not fabricate a URL.
If the user did not ask to push, stop after the commit and say the branch name.`,
  },
];

export function studioBrief(repo: string, task: string): string {
  return [
    `Repository: ${repo || '(this workspace)'}`,
    `Task: ${task.trim()}`,
    'Rules for every agent: do only your role. Do not repeat another agent\'s job. If you cannot see the code, say so instead of guessing.',
  ].join('\n');
}

export function livePrompt(id: string, fallback: string): string {
  const saved = useGiaStore.getState().skills.find(s => s.id === id)?.systemPrompt?.trim();
  return saved || fallback;
}

export function systemPromptFor(agent: { id?: string; name: string; role: string }, custom?: CustomAgent | null): string {
  if (custom?.systemPrompt?.trim()) return custom.systemPrompt.trim();
  const studio = STUDIO_AGENTS.find(a => a.id === agent.id || a.name === agent.name);
  if (studio) return livePrompt(studio.id, studio.systemPrompt);
  return `You are ${agent.name}, a ${agent.role} working inside GIA Studio.
Do only the task you were given. Lead with the result. Name files and commands. Do not edit the repository unless your role is Implementer or Pull requests. Never force-push. Never commit on main.`;
}

/** Studio agents are skills, so picking one in chat changes the next reply. */
export function syncStudioSkills() {
  const { skills } = useGiaStore.getState();
  const ids = new Set(skills.map(s => s.id));
  const missing = STUDIO_AGENTS.filter(a => !ids.has(a.id));
  if (missing.length === 0) return;
  useGiaStore.setState({
    skills: [
      ...skills,
      ...missing.map(a => ({
        id: a.id,
        name: a.name,
        description: a.role,
        systemPrompt: a.systemPrompt,
        tools: a.writes
          ? ['terminal_run', 'filesystem_read', 'filesystem_write', 'github']
          : ['filesystem_read', 'github', 'web_search'],
        category: 'dev' as const,
      })),
    ],
  });
}
