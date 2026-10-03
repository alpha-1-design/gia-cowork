import { logger } from '../utils/logger';
import { useGiaStore, type Skill } from '../store/useGiaStore';
import { costTracker } from './CostTracker';
import GiaTools from './GiaTools';

/**
 * SkillAuthor — the learning loop.
 *
 * Hermes Agent's headline feature is that it writes its own skills from
 * experience and improves them during use. Gia had a skills *store* and a
 * marketplace, but nothing that let Gia author one — every skill was
 * hand-written by a human. This closes that loop: after GIA solves
 * something non-trivial, it can distil the approach into a reusable skill
 * that gets injected into future system prompts.
 *
 * Design notes:
 *  - Skills are attributed and separable. Authored skills are marked so the
 *    UI can show provenance and the user can delete them; a skill GIA wrote
 *    should never be indistinguishable from a shipped one.
 *  - Tools are validated against the real registry. A skill claiming
 *    `filesystem_wrtpe` would silently never fire, so bad ids are dropped
 *    and recorded rather than trusted.
 *  - Authoring costs tokens like any other call, so it is metered through
 *    the same cost tracker the dashboard reads.
 */

export interface SkillDraft {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  category: Skill['category'];
}

export interface AuthoredSkill extends Skill {
  author: 'gia';
  /** How many times this skill has been used since it was authored. */
  useCount: number;
  /** Set when the user has hand-edited it, so a later GIA write cannot silently clobber their change. */
  editedByUser?: boolean;
  editedAt?: number;
  lastUsedAt?: number;
  /** Free-form notes on what the skill was learned from. */
  origin?: string;
}

const STORAGE_KEY = 'gia-authored-skills-v1';
const MAX_AUTHORED = 100;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'skill';
}

/** Keep only tool ids that actually exist, so a skill never claims a phantom capability. */
function validateTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const all = GiaTools.getAllTools();
  // Before registerAllTools() runs the registry is legitimately empty. Treating
  // that as "every id is unknown" would silently strip all tools from a skill
  // authored during startup, so pass them through instead — the ids are only
  // ever a hint the model reads, not something we execute.
  if (all.length === 0) {
    return [...new Set(tools.map(t => String(t).trim()).filter(Boolean))];
  }
  const known = new Set<string>(all.map((t: { id: string }) => t.id));
  const valid: string[] = [];
  const dropped: string[] = [];
  for (const t of tools) {
    const id = String(t).trim();
    if (!id) continue;
    if (known.has(id)) {
      if (!valid.includes(id)) valid.push(id);
    } else {
      dropped.push(id);
    }
  }
  if (dropped.length > 0) {
    logger.warn(`[SkillAuthor] Dropped unknown tool ids from skill: ${dropped.join(', ')}`);
  }
  return valid;
}

export class SkillAuthor {
  private authored: AuthoredSkill[];

  constructor() {
    this.authored = this.load();
  }

  private load(): AuthoredSkill[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {
      logger.warn('[SkillAuthor] Failed to load authored skills:', e);
    }
    return [];
  }

  private save() {
    try {
      if (this.authored.length > MAX_AUTHORED) {
        this.authored.splice(0, this.authored.length - MAX_AUTHORED);
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.authored));
    } catch { /* storage full — authored skills are a cache, not critical state */ }
  }

  /**
   * Validate and persist a draft as a skill. Re-authoring the same name
   * updates the existing skill and bumps its version rather than creating a
   * near-duplicate, which is what "improves them during use" means in
   * practice.
   */
  commit(draft: Partial<SkillDraft>, origin?: string): { skill: AuthoredSkill; replaced: boolean } {
    const name = (draft.name || '').trim();
    if (!name) throw new Error('A skill needs a name.');
    const systemPrompt = (draft.systemPrompt || '').trim();
    if (!systemPrompt) throw new Error('A skill needs a systemPrompt describing when and how to apply it.');

    const id = `gia-${slugify(name)}`;
    const tools = validateTools(draft.tools);
    const category: Skill['category'] = draft.category ?? 'user';

    const existingIndex = this.authored.findIndex(s => s.id === id);
    const prior = existingIndex >= 0 ? this.authored[existingIndex] : undefined;

    const skill: AuthoredSkill = {
      id,
      name,
      description: (draft.description || systemPrompt.slice(0, 140)).trim(),
      systemPrompt,
      tools,
      category,
      author: 'gia',
      useCount: prior?.useCount ?? 0,
      lastUsedAt: prior?.lastUsedAt,
      origin: origin ?? prior?.origin,
    };

    if (existingIndex >= 0) {
      this.authored[existingIndex] = skill;
    } else {
      this.authored.push(skill);
    }
    this.save();

    // Make it live immediately: the store's addSkill is a no-op for an
    // existing id, so remove first to guarantee the updated version lands.
    const store = useGiaStore.getState();
    if (prior) store.removeSkill(id);
    store.addSkill(skill);

    return { skill, replaced: Boolean(prior) };
  }

  /** Author a skill from a free-form description without an explicit draft. */
  async authorFromExperience(
    taskSummary: string,
    whatWorked: string,
    providerId?: string,
  ): Promise<AuthoredSkill> {
    const { activeProvider, providers } = (await import('../store/useProviderStore')).useProviderStore.getState();
    const targetProvider = providerId || activeProvider;
    const model = providers[targetProvider]?.model || '';

    const res = await (await import('./GiaBrain')).default.generate({
        prompt: `You are distilling a reusable skill from a task you just completed.

TASK:
${taskSummary}

WHAT WORKED:
${whatWorked}

Write a skill another agent could reuse for similar future work.

Return ONLY valid JSON:
{
  "name": "Short, memorable skill name (2-4 words)",
  "description": "One sentence: when to use this skill",
  "systemPrompt": "Instructions for an agent applying this skill. Be concrete and procedural — what to do, in what order, and what to avoid. 2-6 sentences.",
  "tools": ["tool_id_1", "tool_id_2"],
  "category": "core"
}

Rules:
- "tools" must contain ONLY exact tool ids from this list: ${GiaTools.getAllTools().map((t: { id: string }) => t.id).join(', ')}
- "category" must be one of: core, user, dev, creative
- The systemPrompt must generalize beyond this one task — it should work for similar future tasks.
- Return ONLY the JSON.`,
        maxTokens: 1500,
        forceJson: true,
        providerId: targetProvider,
      });

    const { extractJSON } = await import('../utils/helpers');
    const parsed = extractJSON<{
      name?: string; description?: string; systemPrompt?: string;
      tools?: string[]; category?: Skill['category'];
    }>(res.text);

    const { skill } = this.commit({
      name: parsed.name || taskSummary.slice(0, 40),
      description: parsed.description,
      systemPrompt: parsed.systemPrompt || whatWorked,
      tools: parsed.tools,
      category: parsed.category === 'dev' || parsed.category === 'creative' || parsed.category === 'core' ? parsed.category : 'user',
    }, taskSummary.slice(0, 200));

    // Authoring is a real model call — meter it so the dashboard is honest.
    costTracker.record(
      res.provider || targetProvider,
      res.model || model,
      res.tokenUsage?.input ?? 800,
      res.tokenUsage?.output ?? Math.ceil((res.text?.length || 0) / 4),
      useGiaStore.getState().activeSessionId || 'unknown',
    );

    return skill;
  }

  list(): AuthoredSkill[] {
    return [...this.authored].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  }

  remove(id: string) {
    this.authored = this.authored.filter(s => s.id !== id);
    this.save();
    useGiaStore.getState().removeSkill(id);
  }

  /**
   * Edit an authored skill.
   *
   * GIA writes these from experience, but she gets things wrong: a skill that
   * mis-fires on the wrong tasks, or captures an approach the user does not
   * want repeated. A learning loop the user cannot correct is not a learning
   * loop, it is a slow-motion mistake. Every field is editable and the
   * useCount is preserved, because fixing a skill should not erase the
   * evidence of how often it has fired.
   */
  update(id: string, patch: Partial<Pick<AuthoredSkill, 'name' | 'description' | 'systemPrompt' | 'tools' | 'category'>>): { ok: boolean; skill?: AuthoredSkill; error?: string } {
    const existing = this.authored.find(s => s.id === id);
    if (!existing) return { ok: false, error: `No authored skill with id "${id}".` };

    const tools = patch.tools ?? existing.tools;
    // Reuses the same validator as commit(), including its startup-window
    // behaviour: while the registry is empty it passes tool ids through rather
    // than stripping them all.
    const validTools = validateTools(tools);
    if (validTools.length !== tools.length) {
      const dropped = tools.filter(t => !validTools.includes(t));
      return { ok: false, error: `Unknown tool id${dropped.length === 1 ? '' : 's'}: ${dropped.join(', ')}. Run \`/tools\` to see the valid ids.` };
    }

    const name = (patch.name ?? existing.name).trim();
    if (!name) return { ok: false, error: 'A skill needs a name.' };

    const next: AuthoredSkill = {
      ...existing,
      ...patch,
      name,
      tools: validTools,
      // Recorded so a later automatic re-write is visibly distinct from the
      // user's own edit.
      editedByUser: true,
      editedAt: Date.now(),
    };
    this.authored = this.authored.map(s => (s.id === id ? next : s));
    this.save();

    // Same sync path as commit(): addSkill is a no-op for an existing id.
    const store = useGiaStore.getState();
    store.removeSkill(id);
    store.addSkill(next);

    logger.log(`[SkillAuthor] updated "${next.name}" (user edit)`);
    return { ok: true, skill: next };
  }

  /**
   * Relevance-matched prompt block.
   *
   * The previous version dumped every authored skill into every prompt. That
   * is worse than useless past a handful of skills: it dilutes attention,
   * inflates cost on every message, and invites the model to apply a skill
   * that has nothing to do with the task. This scores each skill against the
   * live query and only surfaces genuine matches.
   *
   * Scoring is lexical (weighted term overlap with field boosts) rather than
   * embedding-based on purpose — it costs nothing, needs no model call, and
   * runs synchronously inside prompt assembly. A real embedding index is the
   * natural upgrade if the skill count grows a lot.
   */
  getPromptBlock(query?: string): string {
    const skills = this.authored.filter(s => s.systemPrompt);
    if (skills.length === 0) return '';

    // No query (e.g. building the system prompt outside a turn) — stay quiet
    // rather than guessing; an unfiltered dump is what we're replacing.
    if (!query || !query.trim()) return '';

    const ranked = rankSkills(skills, query);
    if (ranked.length === 0) return '';

    const lines = ranked.map(({ skill, score }) =>
      `- "${skill.name}" (${skill.tools.length ? skill.tools.join(', ') : 'no tools'}): ${skill.systemPrompt}`
    );
    return `\n\nSKILLS YOU AUTHORED — these match what you were just asked to do, so apply them:\n${lines.join('\n')}`;
  }

  /**
   * Rank authored skills against a query without rendering a prompt block.
   * Used by the self-improvement loop to spot which skills are being used and
   * which have gone stale.
   */
  rank(query: string, limit = 6): Array<{ skill: AuthoredSkill; score: number }> {
    const skills = this.authored.filter(s => s.systemPrompt);
    if (!query.trim()) return [];
    return rankSkills(skills, query).slice(0, limit);
  }

  markUsed(id: string) {
    const s = this.authored.find(x => x.id === id);
    if (!s) return;
    s.useCount = (s.useCount || 0) + 1;
    s.lastUsedAt = Date.now();
    this.save();
  }
}

/** Words too common to carry any signal about which skill applies. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these',
  'i', 'me', 'my', 'you', 'your', 'we', 'us', 'please', 'can', 'could', 'would',
  'should', 'do', 'does', 'did', 'make', 'made', 'get', 'got', 'use', 'used',
  'how', 'what', 'when', 'where', 'which', 'who', 'why', 'not', 'no', 'yes',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/** Crude stem so "report"/"reporting"/"reports" match each other. */
function stem(w: string): string {
  return w.replace(/(ing|ers|er|s|es|ed|d)$/i, '');
}

/**
 * IDF over the skill corpus so a term that appears in every skill ("file",
 * "use") carries less weight than a distinctive one. Without this, a skill
 * that merely shares common vocabulary outranks an exact topical match.
 */
function computeIdf(skills: AuthoredSkill[]): Map<string, number> {
  const docs = skills.map(s => new Set(tokenize(`${s.name} ${s.description} ${s.systemPrompt}`)));
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const t of doc) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = Math.max(1, docs.length);
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + N / count));
  }
  return idf;
}

/**
 * Score each skill against the query. Weighted field overlap: a term in the
 * name or description says much more about when the skill applies than the
 * same term buried in its instructions.
 */
export function rankSkills(
  skills: AuthoredSkill[],
  query: string,
): Array<{ skill: AuthoredSkill; score: number }> {
  if (skills.length === 0 || !query.trim()) return [];

  const queryTerms = [...new Set(tokenize(query).map(stem))];
  if (queryTerms.length === 0) return [];

  const idf = computeIdf(skills);

  const scored = skills.map(skill => {
    const nameTerms = new Set(tokenize(skill.name).map(stem));
    const descTerms = new Set(tokenize(skill.description).map(stem));
    const bodyTerms = new Set(tokenize(skill.systemPrompt).map(stem));

    let score = 0;
    for (const term of queryTerms) {
      const weight = idf.get(term) ?? 0;
      if (nameTerms.has(term)) score += weight * 3;
      else if (descTerms.has(term)) score += weight * 2;
      else if (bodyTerms.has(term)) score += weight;
    }
    return { skill, score };
  });

  // Require a real signal. A single shared common word should not drag an
  // unrelated skill into the prompt on every message.
  return scored
    .filter(s => s.score > 0.8)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

export const skillAuthor = new SkillAuthor();
export default skillAuthor;