/**
 * Project isolation.
 *
 * A user running GIA across several projects hits a specific failure: context
 * from the last project leaks into the next one. GIA remembers that a file was
 * `src/auth.ts`, mentions it while working in a project that has no `src`, and
 * the user cannot tell whether she is wrong or being deliberately confusing.
 *
 * So a project is a boundary with three parts, and all three have to hold or
 * the boundary is decorative:
 *
 *  1. **Memory scoping.** A memory can be global or belong to one project. When
 *     the user restricts a project, only that project's memories plus the ones
 *     they explicitly marked global are visible. Restricting is opt-in per
 *     project because the default — remembering everything — is what most people
 *     want most of the time.
 *  2. **A welcome back.** On returning to a project, GIA says so and names the
 *     project, rather than starting cold or pretending continuity she does not
 *     have.
 *  3. **An ingress gate.** GIA does not read from, or write into, a project the
 *     user has not switched to. This is the part that has to be enforced rather
 *     than prompted, because a model told "don't look at the other project" in
 *     prose is a suggestion.
 */

export interface ProjectMemory {
  key: string;
  value: string;
  /** null or undefined means global — visible from every project. */
  projectId: string | null;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  lastSeenAt: number;
  /** When true, only this project's memories and global ones are visible here. */
  restrictMemory: boolean;
}

/** The project the user is currently in, if any. */
let activeProjectId: string | null = null;
let lastProjectId: string | null = null;

/** How long before a return counts as "coming back" rather than "never left". */
export const RETURN_WINDOW_MS = 1000 * 60 * 60 * 24 * 14; // two weeks

export function setActiveProject(id: string | null): void {
  if (id !== activeProjectId) {
    lastProjectId = activeProjectId;
    activeProjectId = id;
  }
}

export function getActiveProjectId(): string | null {
  return activeProjectId;
}

/** The project we were in immediately before the current one. */
export function getPreviousProjectId(): string | null {
  return lastProjectId;
}

export function resetProjectContext(): void {
  activeProjectId = null;
  lastProjectId = null;
}

/**
 * Which memories are visible from the active project.
 *
 * The asymmetry is the whole feature: a global memory is always visible because
 * the user chose to make it global, but a project-scoped memory is visible from
 * anywhere unless its own project has restricted memory. Without the second
 * half, scoping would still leak — every unrestricted project would see every
 * other project's notes.
 */
export function visibleMemories(
  all: ProjectMemory[],
  opts: {
    projectId: string | null;
    /** Restriction flags by project id. */
    restricted: Record<string, boolean>;
  },
): ProjectMemory[] {
  const { projectId, restricted } = opts;
  return all.filter((m) => {
    if (m.projectId === null || m.projectId === undefined) return true; // global
    if (!projectId) return false; // no project open: only global memories
    // Visible from its own project always.
    if (m.projectId === projectId) return true;
    // Visible elsewhere only when the owning project allows it.
    return !restricted[m.projectId];
  });
}

/** Scope a memory to a project, or make it global by passing null. */
export function scopeMemory(m: Omit<ProjectMemory, 'projectId'>, projectId: string | null): ProjectMemory {
  return { ...m, projectId };
}

export interface WelcomeResult {
  /** True when this counts as returning rather than opening for the first time. */
  returning: boolean;
  /** The line to greet with, or '' when there is nothing to say. */
  message: string;
  userName: string;
}

/**
 * The greeting for entering a project.
 *
 * Says it plainly and only when it is true. An assistant that says "welcome
 * back" on a first visit teaches the user that the phrase means nothing, and
 * then the genuine one does not land either.
 */
export function welcomeBack(project: ProjectRecord, userName: string, now = Date.now()): WelcomeResult {
  const name = userName?.trim() || 'there';
  const gap = now - project.lastSeenAt;
  const away = humanGap(gap);

  if (project.lastSeenAt === 0 || gap > RETURN_WINDOW_MS) {
    return {
      returning: false,
      message: `Starting ${project.name}.`,
      userName: name,
    };
  }

  return {
    returning: true,
    message: `Welcome back ${name}. Back in ${project.name} — last time you were here ${away}.`,
    userName: name,
  };
}

function humanGap(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 2) return 'a moment ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

export interface IngressDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * May GIA touch this path?
 *
 * Denied when it belongs to a *known other* project and the user has not opened
 * that project. Unknown paths are allowed through, because refusing every path
 * outside the current project root would break ordinary work — reading a shared
 * library, writing to a temp directory — and an over-eager gate gets switched
 * off entirely, which is worse than a slightly loose one.
 */
export function checkProjectIngress(
  targetPath: string,
  projects: ProjectRecord[],
  opts: { activeProjectId: string | null; explicitlyAllowed?: string[] },
): IngressDecision {
  const normalised = normalise(targetPath);
  const explicitlyAllowed = (opts.explicitlyAllowed ?? []).map(normalise);

  for (const p of projects) {
    if (p.id === opts.activeProjectId) continue; // the current project is always fine
    if (explicitlyAllowed.includes(p.path)) continue;

    const root = normalise(p.path);
    // Only a genuine descendant counts — "/repo-other" is not inside "/repo".
    if (normalised === root || normalised.startsWith(root + '/')) {
      return {
        allowed: false,
        reason: `That path belongs to "${p.name}", which is not the project you are working in. Ask the user to switch to it, or to explicitly allow access, before reading or writing there.`,
      };
    }
  }
  return { allowed: true };
}

function normalise(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** The prompt block describing the boundary. */
export function projectIsolationPromptBlock(
  project: ProjectRecord | null,
  others: ProjectRecord[],
): string {
  if (!project) return '';
  const otherNames = others.filter(o => o.id !== project.id).map(o => o.name);
  const lines: string[] = [];
  lines.push(`## Project boundary`);
  lines.push(`You are working in **${project.name}** (\`${project.path}\`).`);
  lines.push('');
  lines.push(
    'Do not read from, write to, or draw on anything belonging to another project unless the user has explicitly switched to it or told you that you may. Do not assume a file you remember from an earlier conversation still exists — that memory may belong to a different project entirely.',
  );
  if (project.restrictMemory) {
    lines.push('');
    lines.push(
      'Memory is restricted in this project. Only what was learned here, plus what the user explicitly marked global, is available. If something you think you know is not available here, say so rather than acting on it.',
    );
  }
  if (otherNames.length) {
    lines.push('');
    lines.push(`Other known projects (off-limits unless asked): ${otherNames.join(', ')}.`);
  }
  return lines.join('\n');
}