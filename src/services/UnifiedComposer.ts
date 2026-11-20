import { getCommandSuggestions, type CommandSpec } from './SlashCommands';
import { getMentionableAgents } from '../utils/mentionableAgents';
import { useGiaStore } from '../store/useGiaStore';

/**
 * The unified composer layer (user mandate: ONE menu on "/", not three).
 *
 * Typing "/" used to stack TWO layers — the SkillPicker modal ("Neural
 * Command Palette") opened on exactly "/", while the inline SlashCommandMenu
 * also opened with its own "Skills & Agents" command category, and agents
 * were reachable only through the separate @-mention picker. One intent,
 * three surfaces. This service merges all three into a single ordered entry
 * list the composer menu renders inline:
 *
 *   Personas first (summoning an agent), then slash commands, then skills.
 *
 * One type-ahead filter runs across all three; the section grouping is
 * presentational. The @-mention picker stays for the "@" trigger — it owns
 * the richer task-draft flow — but "/" now reaches personas too.
 */

export interface UnifiedComposerEntry {
  kind: 'persona' | 'command' | 'skill';
  /** Display name: 'Atlas' | '/note' | 'Deep Research'. */
  name: string;
  description: string;
  /** Section header this entry renders under. */
  group: string;
  /** kind === 'command': the spec the composer inserts on select. */
  command?: CommandSpec;
  /** kind === 'persona': mention id + icon for the inserted @mention. */
  agentId?: string;
  agentIcon?: string;
  /** kind === 'skill': activation target. */
  skillId?: string;
  skillCategory?: string;
}

export function getUnifiedComposerEntries(input: string): UnifiedComposerEntry[] {
  const t = input.trimStart();
  const query = (t.startsWith('/') ? t.slice(1) : t).trim().toLowerCase();
  const matches = (name: string, description: string) =>
    !query || name.toLowerCase().includes(query) || description.toLowerCase().includes(query);

  const out: UnifiedComposerEntry[] = [];

  // Section caps, not one global cap: the Nexus roster is ~20 personas, and
  // an uncapped personas section pushed every command and skill out of the
  // menu on an empty query. A specific query widens naturally — the cap is
  // about the unfiltered browse view staying one glance tall.
  let personaCount = 0;
  for (const a of getMentionableAgents()) {
    if (!matches(a.name, a.description)) continue;
    if (personaCount >= 8) break;
    personaCount++;
    out.push({
      kind: 'persona',
      name: a.name,
      description: a.description,
      group: 'Personas',
      agentId: a.id,
      agentIcon: a.icon,
    });
  }

  for (const c of getCommandSuggestions(input, 10)) {
    out.push({
      kind: 'command',
      name: `/${c.name}`,
      description: c.description,
      group: c.category,
      command: c,
    });
  }

  let skillCount = 0;
  const skills = useGiaStore.getState().skills ?? [];
  for (const s of skills) {
    if (!matches(s.name, s.description)) continue;
    if (skillCount >= 8) break;
    skillCount++;
    out.push({
      kind: 'skill',
      name: s.name,
      description: s.description,
      group: 'Skills',
      skillId: s.id,
      skillCategory: s.category,
    });
  }

  return out.slice(0, 30);
}
