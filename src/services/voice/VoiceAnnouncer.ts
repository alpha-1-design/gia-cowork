import { logger } from '../../utils/logger';
import { TOOL_LABELS } from '../../utils/toolLabels';

/**
 * VoiceAnnouncer — the whitelist between GiaBrain's thought stream and her
 * mouth (wave-1 §4: voice summarizes, screens detail).
 *
 * GiaBrain already announces tool work through `onThought`
 * ("⚙️ Executing web_search...", "✅ Tools completed", "Spawning N
 * sub-agents..."). The announcer filters that stream down to short spoken
 * lines and enforces the anti-drowning rules:
 *   - only whitelisted patterns are spoken — thought prose, tool JSON and
 *     observations never reach the queue;
 *   - at most one announcement every ANNOUNCE_MIN_GAP_MS;
 *   - a hard cap per turn so a tool-heavy task doesn't become a lecture.
 */

const ANNOUNCE_MIN_GAP_MS = 6000;
const MAX_PER_TURN = 10;

interface AnnouncerState {
  lastAnnouncedAt: number;
  count: number;
  /** Human phrase for the current tool/thinking state (may be empty). */
  currentActivity: string;
}

function toolPhrase(toolId: string): string {
  const label = TOOL_LABELS[toolId];
  if (label) return `${label}.`;
  // Unknown tool: speak the id, de-underscored, never raw.
  return `Using ${toolId.replace(/_/g, ' ')}.`;
}

/** Extract a speakable announcement from one onThought message, or null. */
export function announcementFor(thought: string): { phrase: string; activity: string } | null {
  const clean = thought.trim();
  if (!clean) return null;

  // Tool execution: "⚙️ Executing web_search..." (possibly several per block).
  const exec = clean.match(/⚙️\s*Executing\s+([\w_]+)/);
  if (exec) {
    const phrase = toolPhrase(exec[1]);
    return { phrase, activity: TOOL_LABELS[exec[1]] ?? exec[1].replace(/_/g, ' ') };
  }

  // Parallel group: "⚡ Running 3 tools in parallel..."
  const par = clean.match(/⚡\s*Running\s+(\d+)\s+tools?/);
  if (par) {
    const n = par[1];
    return { phrase: n === '1' ? 'One step to run.' : `Running ${n} steps in parallel.`, activity: `${n} steps` };
  }

  // Completion: "✅ Tools completed — generating response..."
  if (/✅\s*Tools completed/.test(clean)) {
    return { phrase: 'Done checking. One moment.', activity: '' };
  }

  // Sub-agents: "Spawning 3 sub-agents in parallel[GOD MODE]..."
  const sub = clean.match(/Spawning\s+(\d+)\s+sub-agents/);
  if (sub) {
    return { phrase: `Handing this to ${sub[1]} agents in parallel.`, activity: `${sub[1]} agents` };
  }

  // Compliance blocks are important enough to always speak.
  if (/🛑\s*Blocked:/.test(clean)) {
    return { phrase: 'That step breaks the current mode rules, so I stopped it.', activity: 'Blocked' };
  }

  // Everything else — thought prose, observations, hints — stays silent.
  return null;
}

/**
 * Rate-limited stateful announcer. One instance per voice turn.
 */
export class VoiceAnnouncer {
  private state: AnnouncerState = { lastAnnouncedAt: 0, count: 0, currentActivity: '' };

  /** Returns the phrase to speak, or null if rate-limited / not speakable. */
  onThought(thought: string): string | null {
    const announcement = announcementFor(thought);
    if (!announcement) return null;

    this.state.currentActivity = announcement.activity ?? '';
    if (this.state.count >= MAX_PER_TURN) {
      logger.log('[VoiceAnnouncer] per-turn cap reached, staying silent');
      return null;
    }
    const now = Date.now();
    if (now - this.state.lastAnnouncedAt < ANNOUNCE_MIN_GAP_MS) return null;
    this.state.lastAnnouncedAt = now;
    this.state.count++;
    return announcement.phrase;
  }

  /** Human phrase for the UI activity line ("Running tests · 12s" strip). */
  get activity(): string {
    return this.state.currentActivity;
  }

  reset() {
    this.state = { lastAnnouncedAt: 0, count: 0, currentActivity: '' };
  }
}
