import { logger } from '../utils/logger';
import { useGiaStore } from '../store/useGiaStore';
import { useProviderStore } from '../store/useProviderStore';
import { skillAuthor } from './SkillAuthor';
import { costTracker } from './CostTracker';
import GiaTools from './GiaTools';

/**
 * Self-improvement loop — GIA's "night shift".
 *
 * The user described the behaviour they want: leave for bed, come back to a
 * GIA that researched, noticed what it is bad at, wrote skills to cover
 * those gaps, and left notes about what it learned. Hermes does routine-
 * triggered nudges; this is the same idea made concrete.
 *
 * Hard constraints, because an agent improving itself unsupervised is exactly
 * the kind of thing that needs guardrails:
 *  - It only runs when genuinely idle, or inside an explicitly scheduled
 *    window the user opted into. Never while the user is working.
 *  - It spends real money. It is metered through CostTracker and every run
 *    reports what it cost, so an overnight loop can't quietly run up a bill.
 *  - It never installs or executes anything. It may *research* and *write*;
 *    anything that changes the machine goes back to the user as a proposal.
 *  - Every artefact is attributed and reversible.
 */

export type ImprovementActivity =
  | 'research'
  | 'skill'
  | 'documentation'
  | 'gap-analysis'
  | 'local-models';

export interface ImprovementRun {
  id: string;
  startedAt: number;
  finishedAt?: number;
  trigger: 'idle' | 'scheduled' | 'manual';
  activities: {
    kind: ImprovementActivity;
    title: string;
    detail: string;
    artifactId?: string;
  }[];
  /** Gaps GIA identified but cannot close on its own. */
  gaps: string[];
  costUsd: number;
  status: 'running' | 'done' | 'error';
  error?: string;
}

export interface ImprovementConfig {
  enabled: boolean;
  /** Minutes of user inactivity before the loop may start. */
  idleThresholdMinutes: number;
  /** Local-time window (hour, 24h) the loop is allowed to run in. */
  startHour: number;
  endHour: number;
  /** Hard stop so an overnight loop can't spiral. */
  maxMinutesPerRun: number;
  maxRunsPerDay: number;
  /** Refuse to run without a provider, rather than failing mid-run. */
  requireProvider: boolean;
}

const STORAGE_KEY = 'gia-self-improvement-v1';
const HISTORY_KEY = 'gia-self-improvement-runs-v1';
const MAX_HISTORY = 20;

export const DEFAULT_CONFIG: ImprovementConfig = {
  enabled: false,
  idleThresholdMinutes: 30,
  startHour: 1,   // 01:00
  endHour: 6,     // 06:00
  maxMinutesPerRun: 20,
  maxRunsPerDay: 1,
  requireProvider: true,
};

/**
 * Topics the loop researches when it has no better lead. Local models are
 * first because that is where GIA is genuinely behind: it can run Ollama and
 * LM Studio but does not know what good local model choices exist now, what
 * context lengths and quantisations matter, or how to pick for a given box.
 */
const RESEARCH_TOPICS = [
  {
    kind: 'local-models' as const,
    title: 'Local model landscape',
    prompt: `Survey the current state of local (on-device) LLMs available to run through Ollama and LM Studio.

Cover: which model families are currently worth running locally, realistic context lengths and VRAM/RAM requirements, quantisation trade-offs (q4/q5/q8), and how to choose between them for different hardware.

Return ONLY JSON:
{ "findings": ["...3-6 specific, factual findings..."], "sources": ["url"] }`,
  },
  {
    kind: 'gap-analysis' as const,
    title: 'Capability gap analysis',
    prompt: `Here are GIA's available tools and skills:
${GiaTools.getAllTools().map(t => t.id).join(', ')}

Identify what a powerful local-first desktop AI assistant should be able to do that these tools do NOT cover. Be concrete and honest — prioritise gaps that would be felt daily, not nice-to-haves.

Return ONLY JSON:
{ "findings": ["...3-6 concrete missing capabilities, most valuable first..."] }`,
  },
  {
    kind: 'research' as const,
    title: 'Desktop agent capabilities',
    prompt: `What capabilities are state-of-the-art AI desktop agents shipping in 2026 that a local-first assistant should adopt? Focus on concrete features, not marketing.

Return ONLY JSON:
{ "findings": ["...3-6 concrete capabilities..."], "sources": ["url"] }`,
  },
];

export class SelfImprovement {
  private config: ImprovementConfig;
  private runs: ImprovementRun[] = [];
  private current: ImprovementRun | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastUserActivity = Date.now();

  constructor() {
    this.config = this.loadConfig();
    this.runs = this.loadHistory();
  }

  private loadConfig(): ImprovementConfig {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch (e) {
      logger.warn('[SelfImprovement] Failed to load config:', e);
    }
    return { ...DEFAULT_CONFIG };
  }

  private saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    } catch { /* ignore */ }
  }

  private loadHistory(): ImprovementRun[] {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      }
    } catch { /* ignore */ }
    return [];
  }

  private saveHistory() {
    try {
      if (this.runs.length > MAX_HISTORY) this.runs = this.runs.slice(-MAX_HISTORY);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this.runs));
    } catch { /* ignore */ }
  }

  getConfig(): ImprovementConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<ImprovementConfig>) {
    this.config = { ...this.config, ...updates };
    this.saveConfig();
  }

  /** Call on any user interaction so the idle timer resets. */
  noteActivity() {
    this.lastUserActivity = Date.now();
  }

  isRunning(): boolean {
    return this.current?.status === 'running';
  }

  getCurrentRun(): ImprovementRun | null {
    return this.current ? { ...this.current, activities: [...this.current.activities] } : null;
  }

  getHistory(): ImprovementRun[] {
    return [...this.runs].reverse();
  }

  /** True when local time is inside the user's chosen window. Handles wrap. */
  private inWindow(): boolean {
    const h = new Date().getHours();
    const { startHour, endHour } = this.config;
    // Window can wrap past midnight (01:00 -> 06:00 does not, but a user
    // setting 22:00 -> 05:00 should still work).
    return startHour <= endHour
      ? h >= startHour && h < endHour
      : h >= startHour || h < endHour;
  }

  private runsToday(): number {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this.runs.filter(r => r.startedAt >= startOfDay.getTime()).length;
  }

  /** Whether the loop may start right now, and if not, why not. */
  canRun(trigger: ImprovementRun['trigger'] = 'idle'): { ok: boolean; reason: string } {
    if (!this.config.enabled && trigger !== 'manual') {
      return { ok: false, reason: 'Self-improvement is off.' };
    }
    if (this.isRunning()) return { ok: false, reason: 'A run is already in progress.' };
    if (this.runsToday() >= this.config.maxRunsPerDay && trigger !== 'manual') {
      return { ok: false, reason: `Daily limit reached (${this.config.maxRunsPerDay}/day).` };
    }
    if (trigger === 'idle') {
      const idleMin = (Date.now() - this.lastUserActivity) / 60000;
      if (idleMin < this.config.idleThresholdMinutes) {
        return { ok: false, reason: `User active ${Math.round(idleMin)}m ago (needs ${this.config.idleThresholdMinutes}m).` };
      }
      if (!this.inWindow()) {
        return { ok: false, reason: `Outside the ${this.config.startHour}:00–${this.config.endHour}:00 window.` };
      }
    }
    if (this.config.requireProvider) {
      const { activeProvider, providers } = useProviderStore.getState();
      const cfg = providers[activeProvider];
      if (!cfg?.enabled || !cfg.apiKey?.trim()) {
        return { ok: false, reason: 'No provider connected.' };
      }
    }
    return { ok: true, reason: '' };
  }

  /**
   * Start one improvement run. Resolves with the finished run so a manual
   * trigger can report results directly.
   */
  async run(trigger: ImprovementRun['trigger'] = 'manual'): Promise<ImprovementRun | null> {
    const gate = this.canRun(trigger);
    if (!gate.ok) {
      logger.log(`[SelfImprovement] Skipping run: ${gate.reason}`);
      return null;
    }

    const run: ImprovementRun = {
      id: `imp-${Date.now()}`,
      startedAt: Date.now(),
      trigger,
      activities: [],
      gaps: [],
      costUsd: 0,
      status: 'running',
    };
    this.current = run;

    const before = costTracker.getSummary().totalCost;
    const deadline = Date.now() + this.config.maxMinutesPerRun * 60_000;

    try {
      // Phase 1 — research + gap analysis. Each topic is one model call.
      for (const topic of RESEARCH_TOPICS) {
        if (Date.now() > deadline) break;
        const findings = await this.research(topic.prompt, run);
        if (!findings.length) continue;

        run.activities.push({
          kind: topic.kind,
          title: topic.title,
          detail: findings.join('\n'),
        });

        // Local model findings are exactly the kind of durable knowledge
        // worth persisting as a note the user can read later.
        if (topic.kind === 'local-models') {
          await this.writeDoc('Local model landscape', findings);
        }
        if (topic.kind === 'gap-analysis') {
          run.gaps.push(...findings);
        }
      }

      // Phase 2 — turn what was learned into a skill she can actually use.
      if (Date.now() < deadline) {
        await this.deriveSkill(run);
      }

      run.status = 'done';
    } catch (e) {
      run.status = 'error';
      run.error = e instanceof Error ? e.message : String(e);
      logger.error('[SelfImprovement] Run failed:', e);
    } finally {
      run.finishedAt = Date.now();
      run.costUsd = Math.max(0, costTracker.getSummary().totalCost - before);
      this.runs.push(run);
      this.saveHistory();
      this.current = null;
      this.notify(run);
    }

    return run;
  }

  private async research(prompt: string, run: ImprovementRun): Promise<string[]> {
    try {
      const { default: GiaBrain } = await import('./GiaBrain');
      const res = await GiaBrain.generate({
        prompt: `${prompt}\n\nCurrent time: ${new Date().toLocaleString()}`,
        maxTokens: 1200,
        forceJson: true,
      });
      const { extractJSON } = await import('../utils/helpers');
      const parsed = extractJSON<{ findings?: string[]; gaps?: string[] }>(res.text);
      const findings = Array.isArray(parsed.findings) ? parsed.findings.filter(Boolean).map(String) : [];
      if (findings.length > 0) {
        run.activities.push({
          kind: 'research',
          title: 'Research',
          detail: `${findings.length} findings`,
        });
      }
      return findings;
    } catch (e) {
      logger.warn('[SelfImprovement] Research call failed:', e);
      return [];
    }
  }

  private async deriveSkill(run: ImprovementRun) {
    const topics = run.activities.filter(a => a.kind === 'local-models' || a.kind === 'research');
    if (topics.length === 0) return;

    const material = topics.map(t => `## ${t.title}\n${t.detail}`).join('\n\n');
    try {
      const skill = await skillAuthor.authorFromExperience(
        'Overnight self-research: local-first assistant capabilities',
        material,
      );
      run.activities.push({
        kind: 'skill',
        title: 'Skill authored',
        detail: `${skill.name} — ${skill.description}`,
        artifactId: skill.id,
      });
    } catch (e) {
      logger.warn('[SelfImprovement] Skill derivation failed:', e);
    }
  }

  /**
   * Persist findings as a note. Deliberately a note rather than a tool or a
   * skill: the loop can learn, but it must not change how the machine
   * behaves without the user reviewing it.
   */
  private async writeDoc(title: string, findings: string[]) {
    const content = [
      `# ${title}`,
      '',
      `_Researched ${new Date().toLocaleString()} while GIA was idle._`,
      '',
      ...findings.map(f => `- ${f}`),
      '',
    ].join('\n');

    try {
      const { useNotesStore, randomNoteColor } = await import('../store/useNotesStore');
      useNotesStore.getState().addNote({
        title,
        content,
        color: randomNoteColor(),
        pinned: false,
        tags: ['self-improvement', 'research'],
      });
    } catch (e) {
      logger.warn('[SelfImprovement] Failed to write doc:', e);
    }
  }

  private notify(run: ImprovementRun) {
    const parts: string[] = [];
    if (run.activities.length > 0) parts.push(`${run.activities.length} activities`);
    if (run.gaps.length > 0) parts.push(`${run.gaps.length} gaps found`);
    const cost = run.costUsd > 0 ? ` · $${run.costUsd.toFixed(4)}` : '';
    const msg = `🌙 Self-improvement ${run.status === 'done' ? 'complete' : 'failed'}${parts.length ? `: ${parts.join(', ')}` : ''}${cost}`;
    try {
      useGiaStore.getState().addNotification(msg);
    } catch { /* ignore */ }
  }

  /** Lightweight scheduler. Checks every 5 minutes; cheap and predictable. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.config.enabled || this.isRunning()) return;
      const gate = this.canRun('idle');
      if (gate.ok) void this.run('idle');
    }, 5 * 60 * 1000);
    logger.log('[SelfImprovement] Scheduler started');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const selfImprovement = new SelfImprovement();
export default selfImprovement;