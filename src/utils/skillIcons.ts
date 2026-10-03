/**
 * Skill icons.
 *
 * Skills used to render as the same generic glyph everywhere, which made a
 * list of them unreadable. This resolves a stable, meaningful icon per skill:
 * explicit icon -> category default -> keyword match on the name -> a
 * deterministic pick from the pool.
 *
 * Deterministic on purpose: the same skill must always get the same icon
 * across reloads, or the list would reshuffle itself every render.
 */

const CATEGORY_ICONS: Record<string, string> = {
  core: '⚡',
  user: '👤',
  dev: '🛠️',
  creative: '🎨',
};

/** Ordered: first keyword hit wins, so put the specific ones first. */
const NAME_ICONS: Array<[RegExp, string]> = [
  [/report|summary|digest|weekly|recap/i, '📊'],
  [/email|mail|inbox/i, '📧'],
  [/calendar|schedule|meeting/i, '📅'],
  [/code|program|script|debug|refactor/i, '💻'],
  [/test|qa|verify/i, '🧪'],
  [/deploy|release|ship|ci/i, '🚀'],
  [/doc|write|writing|article|blog/i, '📝'],
  [/design|ui|ux|mockup/i, '🎨'],
  [/data|analy|chart|metric|sql/i, '📈'],
  [/research|search|find|scout/i, '🔍'],
  [/file|folder|organi|clean/i, '🗂️'],
  [/security|scan|audit|threat/i, '🛡️'],
  [/git|commit|version|branch/i, '🌿'],
  [/voice|speech|tts|audio/i, '🎙️'],
  [/image|photo|camera|vision/i, '🖼️'],
  [/learn|memory|remember/i, '🧠'],
  [/automat|schedul|cron|task/i, '⏰'],
  [/build|compile|package/i, '🧱'],
  [/web|scrape|crawl|url/i, '🌐'],
  [/message|chat|notify/i, '💬'],
];

const FALLBACK_ICONS = ['✨', '🧩', '🛠️', '🔹', '🔸', '💫', '🌟', '⚙️', '🪄', '🧭'];

/** Stable string hash — same input always yields the same icon. */
function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function resolveSkillIcon(skill: {
  id?: string;
  name?: string;
  icon?: string;
  category?: string;
}): string {
  if (skill.icon) return skill.icon;
  const name = skill.name || '';

  for (const [pattern, icon] of NAME_ICONS) {
    if (pattern.test(name)) return icon;
  }
  if (skill.category && CATEGORY_ICONS[skill.category]) return CATEGORY_ICONS[skill.category];

  return FALLBACK_ICONS[hash(skill.id || name) % FALLBACK_ICONS.length];
}