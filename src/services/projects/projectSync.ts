import { useProjectContextStore } from '../../store/useProjectContextStore';
import { useProjectStore, knownProjects, MAX_KNOWN_PROJECTS } from '../../store/useProjectStore';
import { useGiaStore } from '../../store/useGiaStore';
import {
  setActiveProject,
  getActiveProjectId,
  getPreviousProjectId,
  welcomeBack,
  checkProjectIngress,
  type ProjectRecord,
  type IngressDecision,
} from './projectIsolation';

/**
 * The bridge between "which project is open" and the isolation machinery.
 *
 * `projectIsolation.ts` holds pure, well-tested logic — memory scoping, the
 * ingress decision, the boundary paragraph. But all of it takes its project as
 * an argument, and nothing was ever passing one: no store field, no call site,
 * no writer for the project list. Five functions, a full feature, zero callers.
 *
 * This module supplies the missing three things: a stable id for a project
 * directory, the sync that keeps the registry and `projectIsolation` agreeing,
 * and the welcome-back that fires on a genuine switch.
 */

/**
 * A stable id for a project path.
 *
 * Derived from the path rather than generated, so the same directory maps to
 * the same record across restarts. A fresh uuid per visit would make every
 * launch look like a new project, and "welcome back" would never fire.
 */
export function projectIdFor(path: string): string {
  const normalised = path.replace(/\\/g, '/').replace(/\/+$/, '');
  let h = 0x811c9dc5;
  for (let i = 0; i < normalised.length; i++) {
    h ^= normalised.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `proj-${h.toString(36)}`;
}

/** The display name for a project directory. */
export function projectNameFor(path: string): string {
  const normalised = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalised.split('/').filter(Boolean).pop();
  return base || 'project';
}

/**
 * Reconcile the registry with whichever project is currently open.
 *
 * Called on startup and whenever the project context changes. Idempotent, so
 * calling it twice is a no-op rather than a duplicate record.
 *
 * Returns the active record, or null when no project is open. Callers should
 * treat null as "no boundary to state" rather than an error.
 */
/**
 * What the previous visit looked like, captured before the record is stamped.
 *
 * `syncActiveProject` updates `lastSeenAt` to now so the gap next time is
 * measured from this visit. That would erase the "first visit" signal if the
 * greeting were computed from the stored record afterwards — every launch would
 * read as a return. So the pre-sync value is kept here, where only the sync can
 * write it.
 */
let lastSyncPreviousSeenAt: number | null = null;
let lastSyncProjectId: string | null = null;

export function syncActiveProject(now = Date.now()): ProjectRecord | null {
  const entry = useProjectContextStore.getState().entry;

  if (!entry?.path) {
    useProjectStore.getState().setActive(null);
    setActiveProject(null);
    lastSyncPreviousSeenAt = null;
    lastSyncProjectId = null;
    return null;
  }

  const id = projectIdFor(entry.path);
  const existing = useProjectStore.getState().projects.find((p) => p.id === id);
  const previousSeen = existing?.lastSeenAt ?? 0;

  lastSyncPreviousSeenAt = previousSeen > 0 ? previousSeen : null;
  lastSyncProjectId = id;

  const record = useProjectStore.getState().upsert({
    id,
    name: entry.projectName?.trim() || projectNameFor(entry.path),
    path: entry.path,
    lastSeenAt: previousSeen,
    restrictMemory: existing?.restrictMemory ?? false,
  });

  useProjectStore.getState().setActive(id);
  setActiveProject(id);

  // Stamp the visit *after* reading it, so the next gap is measured from here.
  useProjectStore.getState().patch(id, { lastSeenAt: now });

  return record;
}

/**
 * The greeting for having just switched into a project.
 *
 * Returns null when nothing worth saying: no project open, or the first visit
 * ever. An assistant that says "welcome back" on a first visit teaches the user
 * the phrase is noise, and then the genuine one does not land either.
 */
export function welcomeForSwitch(now = Date.now()): { record: ProjectRecord; message: string; returning: boolean } | null {
  const activeId = getActiveProjectId();
  if (!activeId) return null;
  // Only a project this sync actually switched into can be greeted. Reading any
  // active record would greet on a cold launch, before the user did anything.
  if (lastSyncProjectId !== activeId) return null;

  const record = knownProjects().find((p) => p.id === activeId);
  if (!record) return null;

  // Measured from the pre-sync stamp — see `lastSyncPreviousSeenAt`.
  const asSeen = { ...record, lastSeenAt: lastSyncPreviousSeenAt ?? 0 };
  const userName = useGiaStore.getState().userProfile?.name || '';
  const result = welcomeBack(asSeen, userName, now);
  if (!result.returning) return null;

  return { record, message: result.message, returning: true };
}

/** True when we genuinely moved between two different projects. */
export function didSwitchProjects(): boolean {
  const active = getActiveProjectId();
  return !!active && !!getPreviousProjectId() && active !== getPreviousProjectId();
}

/**
 * May GIA touch this path?
 *
 * Inert unless the user has actually opened two or more projects — with a
 * single project (or none) there is no boundary, and a gate that fires on every
 * unrelated path gets switched off entirely, which is worse than a loose one.
 */
export function guardPath(targetPath: string, explicitlyAllowed?: string[]): IngressDecision {
  const projects = knownProjects();
  const activeId = getActiveProjectId();
  if (!activeId || projects.length < 2) return { allowed: true };
  return checkProjectIngress(targetPath, projects, { activeProjectId: activeId, explicitlyAllowed });
}

/** Every known project except the active one. */
export function otherProjects(): ProjectRecord[] {
  const activeId = getActiveProjectId();
  return knownProjects().filter((p) => p.id !== activeId).slice(0, MAX_KNOWN_PROJECTS);
}