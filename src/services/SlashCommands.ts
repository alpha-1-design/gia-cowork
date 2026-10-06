import { useGiaStore, type ChatSession, type Message, type MessageNode } from '../store/useGiaStore';
import { THEME_IDS, getDesktopTheme } from '../config/themes';
import { THINKING_LEVELS, THINKING_SPECS, toThinkingLevel } from './system/thinkingLevels';
import { BUILD_STYLES, getBuildStyle } from './build/giaThemes';
import { MODES, getModePromptName } from './system/modePrompts';
import { useProviderStore } from '../store/useProviderStore';
import { useMCPStore } from '../store/useMCPStore';
import { usePluginStore } from '../store/usePluginStore';
import { useAgentStore } from '../store/useAgentStore';
import { useNotesStore } from '../store/useNotesStore';
import { useMemoryStore } from '../store/useMemoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { useGiaIdentity } from '../store/useGiaIdentity';
import { skillAuthor } from './SkillAuthor';
import { resolveSkillIcon } from '../utils/skillIcons';
import { costTracker, formatCost } from './CostTracker';
import { togglePresenterMode, presenterSupported, isPresenting } from './PresenterMode';
import { isDesktop } from '../platform';
import MCPManager from './MCPManager';
import { fileSnapshots } from './FileSnapshots';
import { useProjectMemoryStore, type ProjectMemoryKind } from './ProjectMemory';
import { useProjectContextStore } from '../store/useProjectContextStore';
import { useTrustStore } from '../store/useTrustStore';
import { RISK_META } from './permissions';
import giaTools from './GiaTools';
import { categorizeTool } from '../utils/toolCategories';
import { logger } from '../utils/logger';

/**
 * Slash commands.
 *
 * This started as thirteen chat-only commands, which is a bad deal for an app
 * with MCP servers, plugins, agents, notes, memory and a task board behind it:
 * all of that was reachable only by hunting through Settings menus. The command
 * surface is now a registry, so every subsystem has a chat-reachable door and
 * `/help` stays honest as the app grows.
 *
 * Commands are plain data with a `run` handler rather than one giant switch, so
 * the autocomplete menu, the help listing and the dispatcher all read from the
 * same source and cannot drift apart.
 */

export type SlashCommandResult = {
  handled: boolean;
  message?: string;
  action?: 'clear' | 'compact' | 'mode-switch' | 'new-session' | 'show-skills' | 'show-help';
};

// `Giamode` used to type the old `/mode` command, which wrote a key nothing
// read. The live mode list is `MODES` in system/modePrompts — one source, so a
// mode cannot be settable in one place and absent from the other.
export type Giamode = 'code' | 'plan' | 'ask' | 'build' | 'exam' | 'analyst';

export type CommandCategory =
  | 'Chat & Sessions'
  | 'Models & Providers'
  | 'Capabilities'
  | 'Skills & Agents'
  | 'MCP & Plugins'
  | 'Notes, Memory & Tasks'
  | 'System'
  | 'Help';

interface CommandContext {
  /** Words after the command name. */
  args: string[];
  /** Everything after the command name, rejoined — for free-text args. */
  rest: string;
  raw: string;
}

export interface CommandSpec {
  name: string;
  aliases?: string[];
  category: CommandCategory;
  description: string;
  /** Argument syntax, shown in help and the autocomplete menu. */
  usage?: string;
  /** Hidden outside the Tauri shell — a command that cannot work is worse than an absent one. */
  desktopOnly?: boolean;
  run: (ctx: CommandContext) => SlashCommandResult;
}

// ── helpers ──────────────────────────────────────────────────────────────

function countTokens(text: string): number {
  if (!text) return 0;
  // Rough approximation: ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}

function walkMessages(nodes: MessageNode[], visit: (n: MessageNode) => void) {
  for (const node of nodes) {
    visit(node);
    walkMessages(node.children, visit);
  }
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/**
 * Resolve a session by id, exact-title prefix, or numeric index from `/sessions`.
 * Returns the session plus how the user referred to it, so error messages can
 * echo back something they recognise.
 */
function resolveSession(ref: string): { session: ChatSession; label: string } | { error: string } {
  const s = useGiaStore.getState();
  if (!ref) {
    const active = s.getActiveSession();
    return active
      ? { session: active, label: active.title }
      : { error: 'There is no active session.' };
  }

  const byId = s.sessions.find(x => x.id === ref);
  if (byId) return { session: byId, label: byId.title };

  const lower = ref.toLowerCase();
  const byTitle = s.sessions.filter(x => x.title.toLowerCase() === lower);
  if (byTitle.length === 1) return { session: byTitle[0], label: byTitle[0].title };

  const byPrefix = s.sessions.filter(x => x.title.toLowerCase().startsWith(lower));
  if (byPrefix.length === 1) return { session: byPrefix[0], label: byPrefix[0].title };
  if (byPrefix.length > 1) {
    return {
      error: `\`${ref}\` matches ${byPrefix.length} sessions: ${byPrefix.slice(0, 5).map(x => `**${truncate(x.title, 30)}**`).join(', ')}. Be more specific.`,
    };
  }

  // 1-based index into the list `/sessions` prints, which is how a human
  // actually refers to "the third one".
  const n = Number.parseInt(ref, 10);
  if (Number.isInteger(n) && n >= 1 && n <= s.sessions.length) {
    const session = s.sessions[n - 1];
    return { session, label: session.title };
  }

  return { error: `No session matches \`${ref}\`. Use \`/sessions\` to see them.` };
}

function sessionStats(session: ChatSession) {
  let messages = 0;
  let chars = 0;
  let lastUser = '';
  walkMessages(session.messages, n => {
    messages++;
    if (!n.message.thinking && n.message.content) {
      chars += n.message.content.length;
      if (n.message.role === 'user') lastUser = n.message.content;
    }
  });
  return { messages, chars, tokens: countTokens(session.title + lastUser) + Math.ceil(chars / 4), lastUser };
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Shared implementation for every boolean feature toggle. */
function toggleCommand(
  key: keyof ReturnType<typeof useGiaStore.getState>,
  setter: keyof ReturnType<typeof useGiaStore.getState>,
  label: string,
  emoji: string,
  onText: string,
  offText: string,
  extra?: (on: boolean, ctx: CommandContext) => string | null,
) {
  return (ctx: CommandContext): SlashCommandResult => {
    const s = useGiaStore.getState();
    const current = Boolean(s[key]);
    const want = ctx.args[0]?.toLowerCase();

    let next: boolean;
    if (want === 'on' || want === 'true' || want === 'yes') next = true;
    else if (want === 'off' || want === 'false' || want === 'no') next = false;
    else if (!want) next = !current;
    else {
      return {
        handled: true,
        message: `⚠️ \`${want}\` is not a value I understand. Use \`on\` or \`off\` — e.g. \`${ctx.raw.split(/\s+/)[0]} off\`.`,
      };
    }

    (s[setter] as (v: boolean) => void)(next);
    const note = extra?.(next, ctx);
    return {
      handled: true,
      message: [`${emoji} **${label}: ${next ? 'on' : 'off'}**`, '', next ? onText : offText, note ? `\n${note}` : '']
        .filter(Boolean)
        .join('\n'),
    };
  };
}

// ── the registry ─────────────────────────────────────────────────────────

const REGISTRY: CommandSpec[] = [
  // ── Chat & Sessions ───────────────────────────────────────────────────
  {
    name: 'help',
    aliases: ['?', 'commands'],
    category: 'Help',
    description: 'Show every available command, grouped',
    usage: '/help [category]',
    run: ({ args }) => {
      const filter = args.join(' ').trim().toLowerCase();
      const visible = REGISTRY.filter(c => available(c));
      const groups = visible.filter(c => !filter || c.category.toLowerCase().includes(filter) || c.name.includes(filter));
      if (groups.length === 0) {
        return { handled: true, message: `No commands match \`${filter}\`. Try \`/help\`.` };
      }
      const byCategory = new Map<CommandCategory, CommandSpec[]>();
      for (const c of groups) {
        if (!byCategory.has(c.category)) byCategory.set(c.category, []);
        byCategory.get(c.category)!.push(c);
      }
      const sections = Array.from(byCategory.entries()).map(([cat, list]) => {
        const lines = list
          .map(c => {
            const alias = c.aliases?.length ? ` _(${c.aliases.join(', ')})_` : '';
            const usage = c.usage ? ` \`${c.usage}\`` : '';
            return `- \`/${c.name}\`${usage}${alias} — ${c.description}`;
          })
          .join('\n');
        return `### ${cat}\n\n${lines}`;
      });
      return {
        handled: true,
        message: [
          `## Slash Commands`,
          '',
          `_${visible.length} commands. Type \`/\` in the composer for autocomplete._`,
          '',
          sections.join('\n\n'),
        ].join('\n'),
        action: 'show-help',
      };
    },
  },
  {
    name: 'new',
    aliases: ['session', 'reset'],
    category: 'Chat & Sessions',
    description: 'Start a new session',
    run: () => {
      useGiaStore.getState().createSession();
      return { handled: true, message: '✨ New session started.', action: 'new-session' };
    },
  },
  {
    name: 'sessions',
    aliases: ['history'],
    category: 'Chat & Sessions',
    description: 'List sessions, or switch to one',
    usage: '/sessions [name or #]',
    run: ({ args }) => {
      const s = useGiaStore.getState();
      if (args.length === 0) {
        if (s.sessions.length === 0) return { handled: true, message: 'No sessions yet. `/new` to start one.' };
        const lines = s.sessions
          .slice(0, 25)
          .map((x, i) => {
            const active = x.id === s.activeSessionId ? ' ← active' : '';
            const st = sessionStats(x);
            return `${i + 1}. **${truncate(x.title, 46)}**${active}\n   ${st.messages} messages · ~${st.tokens.toLocaleString()} tokens · ${relativeTime(x.updatedAt)}`;
          });
        const archived = s.archivedSessions.length;
        return {
          handled: true,
          message: [
            '## Sessions',
            '',
            lines.join('\n'),
            '',
            `_Switch with \`/sessions <name>\` or \`/sessions <#>\`._` +
              (archived ? `\n_${archived} archived._` : '') +
              (s.sessions.length > 25 ? `\n_Showing the 25 most recent of ${s.sessions.length}._` : ''),
          ].join('\n'),
        };
      }
      const found = resolveSession(args.join(' '));
      if ('error' in found) return { handled: true, message: `⚠️ ${found.error}` };
      if (found.session.id === s.activeSessionId) {
        return { handled: true, message: `Already in **${truncate(found.label, 60)}**.` };
      }
      s.setActiveSession(found.session.id);
      const st = sessionStats(found.session);
      return {
        handled: true,
        message: `↪️ Switched to **${truncate(found.label, 60)}** (${st.messages} messages, last active ${relativeTime(found.session.updatedAt)}).`,
      };
    },
  },
  {
    name: 'rename',
    category: 'Chat & Sessions',
    description: 'Rename the current session',
    usage: '/rename <title>',
    run: ({ rest }) => {
      const title = rest.trim();
      if (!title) return { handled: true, message: '⚠️ Give me a title: `/rename Refactor the auth layer`.' };
      const s = useGiaStore.getState();
      if (!s.activeSessionId) return { handled: true, message: 'No active session to rename.' };
      s.updateSessionTitle(s.activeSessionId, title);
      return { handled: true, message: `✏️ Renamed to **${title}**.` };
    },
  },
  {
    name: 'copy',
    aliases: ['copy-session', 'duplicate'],
    category: 'Chat & Sessions',
    description: 'Copy the current session, or another one, into a new session',
    usage: '/copy [name or #]',
    run: ({ args }) => {
      const s = useGiaStore.getState();
      const found = resolveSession(args.join(' '));
      if ('error' in found) return { handled: true, message: `⚠️ ${found.error}` };

      const src = found.session;
      const newId = s.createSession();
      // Copied as a flat, non-thinking transcript. Carrying the thinking tree
      // across would duplicate reasoning the user cannot see, which makes the
      // copy confusing to read and inflates the context window for no benefit.
      const flat: Message[] = [];
      walkMessages(src.messages, n => {
        if (n.message.thinking || !n.message.content) return;
        flat.push({
          id: `${newId}-${flat.length}`,
          role: n.message.role,
          content: n.message.content,
          timestamp: src.createdAt + flat.length,
        });
      });
      for (const m of flat) s.addMessage(newId, m);
      s.updateSessionTitle(newId, `${truncate(src.title, 50)} (copy)`);
      s.setActiveSession(newId);

      return {
        handled: true,
        message: `📋 Copied **${truncate(src.title, 50)}** into a new session (${flat.length} messages). Thinking traces were left behind.`,
        action: 'new-session',
      };
    },
  },
  {
    name: 'fork',
    category: 'Chat & Sessions',
    description: 'Branch the conversation from a message',
    usage: '/fork [message #]',
    run: ({ args }) => {
      const s = useGiaStore.getState();
      const session = s.getActiveSession();
      if (!session) return { handled: true, message: 'No active session to fork.' };

      const flat: Message[] = [];
      walkMessages(session.messages, n => {
        if (!n.message.thinking) flat.push(n.message);
      });
      if (flat.length === 0) return { handled: true, message: 'Nothing to fork — this session is empty.' };

      const n = args[0] ? Number.parseInt(args[0], 10) : flat.length;
      if (!Number.isInteger(n) || n < 1 || n > flat.length) {
        return { handled: true, message: `⚠️ Pick a message between 1 and ${flat.length}: \`/fork ${flat.length}\` branches from the latest.` };
      }
      const from = flat[n - 1];
      const newId = s.forkSession(session.id, from.id);
      s.setActiveSession(newId);
      s.updateSessionTitle(newId, `${truncate(session.title, 45)} (fork)`);
      return {
        handled: true,
        message: `🌿 Forked from message ${n}: _"${truncate(from.content, 70)}"_\n\nThe branch is now active. The original is untouched.`,
        action: 'new-session',
      };
    },
  },
  {
    name: 'delete',
    aliases: ['rm'],
    category: 'Chat & Sessions',
    description: 'Delete a session',
    usage: '/delete <name or #>',
    run: ({ rest }) => {
      if (!rest.trim()) return { handled: true, message: '⚠️ Name the session to delete: `/delete 3`. Use `/sessions` to see the list.' };
      const s = useGiaStore.getState();
      const found = resolveSession(rest.trim());
      if ('error' in found) return { handled: true, message: `⚠️ ${found.error}` };
      const title = truncate(found.session.title, 50);
      const wasActive = found.session.id === s.activeSessionId;
      s.deleteSession(found.session.id);
      return { handled: true, message: `🗑️ Deleted **${title}**.${wasActive ? ' Switched to another session.' : ''}` };
    },
  },
  {
    name: 'clear',
    aliases: ['cls'],
    category: 'Chat & Sessions',
    description: 'Clear the current conversation',
    run: () => {
      const s = useGiaStore.getState();
      if (s.activeSessionId) s.clearSession(s.activeSessionId);
      return { handled: true, message: '🗑️ Conversation cleared.', action: 'clear' };
    },
  },
  {
    name: 'compact',
    aliases: ['summarize'],
    category: 'Chat & Sessions',
    description: 'Summarize & compress the context window',
    run: () => ({ handled: true, message: '📦 Context compacted — summarized conversation history.', action: 'compact' }),
  },
  {
    name: 'export',
    category: 'Chat & Sessions',
    description: 'Export a session as markdown to the clipboard',
    usage: '/export [name or #]',
    run: ({ args }) => {
      const found = resolveSession(args.join(' '));
      if ('error' in found) return { handled: true, message: `⚠️ ${found.error}` };
      const session = found.session;

      const lines: string[] = [`# ${session.title}\n`];
      walkMessages(session.messages, n => {
        if (n.message.thinking) return;
        const role = n.message.role === 'user' ? '**You**' : '**GIA**';
        lines.push(`### ${role}\n\n${n.message.content}\n`);
      });

      const md = lines.join('\n');
      navigator.clipboard?.writeText(md).catch(() => {});
      return { handled: true, message: `📋 **${truncate(session.title, 50)}** exported to clipboard (${md.length.toLocaleString()} chars).` };
    },
  },
  {
    name: 'search',
    category: 'Chat & Sessions',
    description: 'Search across session history',
    usage: '/search <text>',
    run: ({ rest }) => {
      const q = rest.trim().toLowerCase();
      if (!q) return { handled: true, message: '⚠️ What should I look for? `/search auth token`.' };
      const s = useGiaStore.getState();
      const hits: Array<{ title: string; snippet: string; when: number }> = [];
      for (const session of s.sessions) {
        walkMessages(session.messages, n => {
          if (n.message.thinking || !n.message.content) return;
          const at = n.message.content.toLowerCase().indexOf(q);
          if (at === -1) return;
          const start = Math.max(0, at - 40);
          hits.push({
            title: session.title,
            when: n.message.timestamp,
            snippet: `…${n.message.content.slice(start, at + q.length + 60).replace(/\s+/g, ' ')}…`,
          });
        });
      }
      if (hits.length === 0) return { handled: true, message: `🔍 Nothing in your ${s.sessions.length} sessions matches **${rest.trim()}**.` };
      hits.sort((a, b) => b.when - a.when);
      const lines = hits.slice(0, 20).map(h => `- **${truncate(h.title, 40)}** · ${relativeTime(h.when)}\n  ${truncate(h.snippet, 120)}`);
      return {
        handled: true,
        message: [
          `## 🔍 ${hits.length} match${hits.length === 1 ? '' : 'es'} for "${rest.trim()}"`,
          '',
          lines.join('\n'),
          '',
          `_Open one with \`/sessions <name>\`._`,
        ].join('\n'),
      };
    },
  },

  // ── Models & Providers ────────────────────────────────────────────────
  {
    name: 'model',
    category: 'Models & Providers',
    description: 'Show or switch the active model',
    usage: '/model [name]',
    run: ({ args }) => {
      const { activeProvider, providers, availableModels } = useProviderStore.getState();
      const current = providers[activeProvider]?.model;
      if (args.length === 0) {
        const opts = availableModels[activeProvider] || [];
        const list = opts.slice(0, 15).map(m => `- \`${m.id}\`${m.free ? ' _free_' : ''}${m.vision ? ' 👁️' : ''}${m.tools ? ' 🛠️' : ''}`);
        return {
          handled: true,
          message: [
            `**Current:** ${activeProvider} → \`${current || 'none'}\``,
            '',
            opts.length
              ? `**Available on ${activeProvider}**${availableModels[activeProvider] ? '' : ''}:\n${list.join('\n')}\n\n_Switch with \`/model <name>\`._`
              : `_No model list cached for ${activeProvider}. Run \`/models refresh\` to fetch it._`,
          ].join('\n'),
        };
      }
      const wanted = args.join(' ');
      const opts = availableModels[activeProvider] || [];
      const exact = opts.find(m => m.id === wanted);
      const fuzzy = exact || opts.find(m => m.id.toLowerCase().includes(wanted.toLowerCase()));
      if (!fuzzy && opts.length > 0) {
        return {
          handled: true,
          message: `⚠️ \`${wanted}\` is not in the ${activeProvider} model list.\n\n${opts.slice(0, 12).map(m => `\`${m.id}\``).join(', ')}\n\n_Run \`/models refresh\` if the list looks stale._`,
        };
      }
      useProviderStore.getState().setProviderModel(activeProvider, fuzzy ? fuzzy.id : wanted);
      return { handled: true, message: `✅ Model switched to **${fuzzy ? fuzzy.id : wanted}** on ${activeProvider}.` };
    },
  },
  {
    name: 'models',
    category: 'Models & Providers',
    description: 'Browse and refresh the model catalog',
    usage: '/models [refresh]',
    run: ({ args }) => {
      const p = useProviderStore.getState();
      if ((args[0] || '').toLowerCase() === 'refresh') {
        void p.fetchModels(p.activeProvider).then(models => {
          useGiaStore.getState().addNotification(`Fetched ${models.length} models from ${p.activeProvider}`);
        }).catch(e => {
          logger.warn('[slash] model refresh failed:', e);
          useGiaStore.getState().addNotification('Model refresh failed');
        });
        return { handled: true, message: `🔄 Fetching the ${p.activeProvider} model list…` };
      }
      const entries = Object.entries(p.availableModels).filter(([, m]) => m.length > 0);
      if (entries.length === 0) return { handled: true, message: '🔍 No models cached. Run `/models refresh`.' };
      const sections = entries.map(([id, models]) => {
        const head = `**${id}**${p.modelListStatus[id] === 'live' ? ' _live_' : ' _catalog_'} — ${models.length}`;
        return `${head}\n${models.slice(0, 8).map(m => `  \`${m.id}\`${m.free ? ' _free_' : ''}`).join('\n')}${models.length > 8 ? `\n  _…and ${models.length - 8} more_` : ''}`;
      });
      return { handled: true, message: `## Models\n\n${sections.join('\n\n')}` };
    },
  },
  {
    name: 'provider',
    aliases: ['providers'],
    category: 'Models & Providers',
    description: 'Show or switch the active provider',
    usage: '/provider [id]',
    run: ({ args }) => {
      const p = useProviderStore.getState();
      if (args.length === 0) {
        return { handled: true, message: `**Active provider:** \`${p.activeProvider}\` → \`${p.providers[p.activeProvider]?.model || 'no model'}\`\n\n_All: ${Object.keys(p.providers).join(', ')}_` };
      }
      const wanted = args[0].toLowerCase();
      const match = Object.keys(p.providers).find(id => id === wanted)
        || Object.keys(p.providers).find(id => id.toLowerCase().includes(wanted));
      if (!match) {
        return { handled: true, message: `⚠️ Unknown provider \`${args[0]}\`.\n\nKnown: ${Object.keys(p.providers).join(', ')}` };
      }
      p.setActiveProvider(match);
      return { handled: true, message: `🔀 Switched to **${match}** (${p.providers[match]?.model || 'no model set'}).` };
    },
  },
  {
    name: 'key',
    aliases: ['apikey'],
    category: 'Models & Providers',
    description: 'Check which providers have keys without printing them',
    run: () => {
      const { providers, activeProvider } = useProviderStore.getState();
      const rows = Object.entries(providers).map(([id, c]) => {
        const state = c.apiKey ? '🔑 set' : c.enabled ? '⚠️ enabled, no key' : '—';
        return `- \`${id}\`${id === activeProvider ? ' ← active' : ''} — ${state}`;
      });
      const missing = Object.entries(providers).filter(([, c]) => c.enabled && !c.apiKey);
      return {
        handled: true,
        message: [
          '## Provider keys',
          '',
          rows.join('\n'),
          '',
          missing.length
            ? `⚠️ ${missing.length} provider${missing.length === 1 ? '' : 's'} enabled without a key: ${missing.map(([id]) => `\`${id}\``).join(', ')}. Set them in Engine Room.`
            : '_Keys are never printed. Add them in Engine Room or Settings → Connections._',
        ].join('\n'),
      };
    },
  },

  // ── Capabilities ──────────────────────────────────────────────────────
  // `/thinking` used to be a bare on/off toggle. It is now a five-level control
  // further down this list, which still accepts `on` and `off` so anyone who
  // learned the old form is not suddenly typing an invalid command.
  {
    name: 'web',
    aliases: ['websearch'],
    category: 'Capabilities',
    description: 'Web search for live answers',
    usage: '/web [on|off]',
    run: toggleCommand('webSearch', 'setWebSearch', 'Web search', '🔍',
      'GIA can look things up online.', 'GIA answers from her own knowledge only.'),
  },
  {
    name: 'deep',
    aliases: ['deepsearch'],
    category: 'Capabilities',
    description: 'Deep search — multi-source research',
    usage: '/deep [on|off]',
    run: toggleCommand('deepSearch', 'setDeepSearch', 'Deep search', '🕵️',
      'GIA researches across several sources before answering.',
      'GIA does a single lookup instead of a full research pass.'),
  },
  {
    name: 'handoff',
    aliases: ['hands-off', 'autopilot'],
    category: 'Capabilities',
    description: 'Hands-off mode — execute tools without asking',
    usage: '/handoff [on|off]',
    run: toggleCommand('handsOff', 'setHandsOff', 'Hands-off mode', '⚡',
      'GIA runs tools without stopping to ask. Convenient, and worth keeping off for anything destructive.',
      'GIA asks before each tool that changes anything.'),
  },
  {
    name: 'vision',
    aliases: ['localvision'],
    category: 'Capabilities',
    description: 'Local vision — read the screen on-device',
    usage: '/vision [on|off]',
    run: toggleCommand('localVision', 'setLocalVision', 'Local vision', '👁️',
      'Screenshots are analysed on this machine. Nothing is uploaded.',
      'Screen analysis uses the configured remote provider.'),
  },
  {
    name: 'cache',
    category: 'Capabilities',
    description: 'Response cache — reuse identical answers',
    usage: '/cache [on|off]',
    run: toggleCommand('responseCache', 'setResponseCache', 'Response cache', '💾',
      'Identical prompts reuse the previous answer. Faster and cheaper, but answers can go stale.',
      'Every prompt is sent to the provider.'),
  },
  {
    name: 'guardrails',
    aliases: ['input-guardrails'],
    category: 'Capabilities',
    description: 'Input guardrails — screen prompts for risky content',
    usage: '/guardrails [on|off]',
    run: toggleCommand('inputGuardrails', 'setInputGuardrails', 'Input guardrails', '🛡️',
      'Prompts that look risky are flagged before they reach the model.',
      'Prompts go straight through.'),
  },
  {
    name: 'validate',
    aliases: ['output-validation'],
    category: 'Capabilities',
    description: 'Output validation — check GIA’s answers before you see them',
    usage: '/validate [on|off]',
    run: toggleCommand('outputValidation', 'setOutputValidation', 'Output validation', '🔍',
      'GIA checks her own output for format and safety problems before replying.',
      'Replies are sent as-is. Faster, and occasionally malformed.'),
  },
  {
    name: 'fallback',
    aliases: ['smartfallback'],
    category: 'Capabilities',
    description: 'Smart fallback — switch provider when one fails',
    usage: '/fallback [on|off]',
    run: toggleCommand('smartFallback', 'setSmartFallback', 'Smart fallback', '🔄',
      'If the active provider errors, GIA retries on another configured one.',
      'A provider failure is reported to you instead of being worked around.'),
  },
  {
    name: 'multi',
    aliases: ['multiprovider'],
    category: 'Capabilities',
    description: 'Multi-provider — route by task',
    usage: '/multi [on|off]',
    run: toggleCommand('multiProvider', 'setMultiProvider', 'Multi-provider', '🤝',
      'Different tasks can use different providers.',
      'Every request goes to the active provider.'),
  },
  {
    name: 'ondevice',
    aliases: ['local-mode'],
    category: 'Capabilities',
    description: 'On-device mode — never call a cloud provider',
    usage: '/ondevice [on|off]',
    run: toggleCommand('onDeviceMode', 'setOnDeviceMode', 'On-device mode', '🔒',
      'Requests stay on this machine. Requires a local model to be running.',
      'Cloud providers are available again.'),
  },
  {
    name: 'mode',
    category: 'Capabilities',
    description: 'Set how GIA works: code, plan, ask, build, exam, analyst',
    usage: '/mode <name>',
    run: ({ rest }) => {
      const s = useGiaStore.getState();
      const cur = ((s.sharedData as { currentMode?: string } | undefined)?.currentMode) ?? 'code';
      if (!rest.trim()) {
        const list = MODES
          .map((m: typeof MODES[number]) => `${m === cur ? '**' + m + '**' : m} — ${getModePromptName(m)}`)
          .join('\n');
        return { handled: true, message: `**Mode:** ${getModePromptName(cur)}\n\n${list}\n\n_Use \`/mode <name>\`._` };
      }
      const want = rest.trim().toLowerCase();
      if (!(MODES as readonly string[]).includes(want)) {
        return { handled: true, message: `⚠️ Unknown mode \`${rest.trim()}\`. Options: ${MODES.join(', ')}` };
      }
      s.updateSharedData({ currentMode: want });
      s.setBuildMode(want === 'build');
      return { handled: true, message: `🎚️ Mode set to **${getModePromptName(want)}**.` };
    },
  },
  {
    name: 'thinking',
    category: 'Capabilities',
    description: 'Set reasoning depth: off, low, medium, high, max',
    usage: '/thinking <level>',
    run: ({ rest }) => {
      const s = useGiaStore.getState();
      if (!rest.trim()) {
        const cur = toThinkingLevel(s.thinkingLevel);
        const list = THINKING_LEVELS
          .map((l: typeof THINKING_LEVELS[number]) => `${l === cur ? '**' + l + '**' : l} — ${THINKING_SPECS[l].blurb}`)
          .join('\n');
        return { handled: true, message: `**Thinking:** ${THINKING_SPECS[cur].label}\n\n${list}\n\n_Use \`/thinking <level>\`._` };
      }
      const want = toThinkingLevel(
        // `on`/`off` are the pre-level spelling. `on` maps to `high` rather
        // than `max` — turning it on should not silently triple the token bill.
        ['on', 'true', 'yes'].includes(rest.trim().toLowerCase()) ? 'high'
          : ['off', 'false', 'no'].includes(rest.trim().toLowerCase()) ? 'off'
            : rest.trim().toLowerCase(),
      );
      const raw = rest.trim().toLowerCase();
      if (!(THINKING_LEVELS as string[]).includes(raw) && !['on', 'off', 'true', 'false', 'yes', 'no'].includes(raw)) {
        return { handled: true, message: `⚠️ Unknown level \`${rest.trim()}\`. Options: ${THINKING_LEVELS.join(', ')} (or on/off)` };
      }
      useGiaStore.getState().setThinkingLevel(want);
      const spec = THINKING_SPECS[want];
      return { handled: true, message: `🧠 Thinking set to **${spec.label}** — ${spec.blurb}` };
    },
  },
  {
    name: 'style',
    category: 'Capabilities',
    description: 'Visual style for what GIA builds: obsidian, carbon, nordic, ember, verdant, mono, prism',
    usage: '/style <name>',
    run: ({ rest }) => {
      const s = useGiaStore.getState();
      if (!rest.trim()) {
        const cur = s.buildStyleId;
        const list = BUILD_STYLES
          .map((st: typeof BUILD_STYLES[number]) => `${st.id === cur ? '**' + st.id + '**' : st.id} — ${st.blurb}`)
          .join('\n');
        return { handled: true, message: `**Build style:** ${getBuildStyle(cur).name}\n\n${list}\n\n_Use \`/style <name>\`._` };
      }
      const want = rest.trim().toLowerCase();
      const found = BUILD_STYLES.find((st: typeof BUILD_STYLES[number]) => st.id === want);
      if (!found) {
        return { handled: true, message: `⚠️ Unknown style \`${rest.trim()}\`. Options: ${BUILD_STYLES.map(st => st.id).join(', ')}` };
      }
      s.setBuildStyle(found.id);
      return { handled: true, message: `🎨 Build style set to **${found.name}** — ${found.blurb}` };
    },
  },
  {
    name: 'theme',
    category: 'Capabilities',
    description: 'Switch theme: obsidian-aurora, dark, light, system',
    usage: '/theme <name>',
    run: ({ rest }) => {
      // One list, from config/themes.ts — the picker, this command and the
      // store default all read the same thing, so a theme cannot exist in one
      // place and be missing from another.
      const themes = THEME_IDS;
      const s = useGiaStore.getState();
      if (!rest.trim()) {
        return {
          handled: true,
          message: `**Theme:** ${getDesktopTheme(s.theme).label}\n\n_Options: ${themes.join(', ')} — \`/theme <name>\`._`,
        };
      }
      const want = rest.trim().toLowerCase();
      if (!themes.includes(want as (typeof themes)[number])) {
        return { handled: true, message: `⚠️ Unknown theme \`${rest.trim()}\`. Options: ${themes.join(', ')}` };
      }
      useGiaStore.setState({ theme: want as typeof s.theme });
      return { handled: true, message: `🎨 Theme set to **${getDesktopTheme(want).label}**.` };
    },
  },

  // ── Skills & Agents ───────────────────────────────────────────────────
  {
    name: 'skills',
    aliases: ['marketplace', 'store'],
    category: 'Skills & Agents',
    description: 'Open the skills marketplace',
    run: () => ({ handled: true, message: '🏪 Opening skills marketplace...', action: 'show-skills' }),
  },
  {
    name: 'skill-creator',
    aliases: ['skill-create', 'newskill'],
    category: 'Skills & Agents',
    description: 'Create a skill GIA will reuse automatically',
    usage: '/skill-creator <name> — <what it does>',
    run: ({ rest }) => {
      const spec = rest.trim();
      if (!spec) {
        const authored = skillAuthor.list();
        return {
          handled: true,
          message: [
            '## 🧠 Skill Creator',
            '',
            'Create a reusable skill GIA will apply automatically in future sessions.',
            '',
            '**Usage:**',
            '`/skill-creator <name> — <what it should do>`',
            '',
            '**Example:**',
            "`/skill-creator Weekly Report — pull this week's activity, group by project, and render a markdown summary`",
            '',
            'Tips:',
            '- Name it 2–4 words so it is easy to recall.',
            '- Describe the *process*, not one specific answer.',
            '- Pin the tools it needs with `--tools a,b,c`.',
            '',
            authored.length > 0
              ? `You have ${authored.length} authored skill${authored.length === 1 ? '' : 's'} — \`/skill-list\` to review them.`
              : 'You have not authored any skills yet.',
          ].join('\n'),
        };
      }

      const toolsMatch = spec.match(/--tools\s+([a-z0-9_,\s]+)$/i);
      const tools = toolsMatch ? toolsMatch[1].split(',').map(t => t.trim()).filter(Boolean) : [];
      const nameAndDesc = spec.replace(/--tools\s+[a-z0-9_,\s]+$/i, '').trim();

      const nameMatch = nameAndDesc.match(/^(.+?)\s*(?:—|--|-)\s*(.+)$/);
      const name = (nameMatch ? nameMatch[1] : nameAndDesc.split(/\s+/).slice(0, 3).join(' ')).trim();
      const description = nameMatch ? nameMatch[2].trim() : nameAndDesc;

      if (!name || !description) {
        return { handled: true, message: '⚠️ Could not parse that. Try `/skill-creator <name> — <what it should do>`.' };
      }

      const validIds = new Set(giaTools.getAllTools().map(t => t.id));
      const unknown = tools.filter(t => !validIds.has(t));
      if (unknown.length > 0) {
        // Silently dropping a mistyped tool id would give a skill that
        // promises a capability it does not have.
        const near = unknown.map(u => {
          const hit = [...validIds].find(v => v.includes(u.split('_')[0]) || u.includes(v.split('_')[0]));
          return hit ? `\`${u}\` → did you mean \`${hit}\`?` : `\`${u}\` is not a registered tool.`;
        });
        return {
          handled: true,
          message: `⚠️ ${near.join('\n')}\n\nRun \`/tools\` to see every tool id.`,
        };
      }

      try {
        const { skill, replaced } = skillAuthor.commit({
          name,
          description,
          systemPrompt: `${description}\n\nApply this whenever the task matches, and follow it end to end rather than improvising a different route.`,
          tools,
          category: 'user',
        });
        const icon = resolveSkillIcon(skill);
        return {
          handled: true,
          message: [
            `${replaced ? '♻️ Updated' : '✨ Created'} skill ${icon} **${skill.name}**`,
            '',
            `**When to use:** ${skill.description}`,
            `**Tools:** ${skill.tools.join(', ') || 'none pinned'}`,
            '',
            'It will now be applied automatically in future sessions. Re-run with the same name to improve it.',
          ].join('\n'),
        };
      } catch (e) {
        return { handled: true, message: `⚠️ ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },
  {
    name: 'skill-list',
    category: 'Skills & Agents',
    description: 'List skills GIA authored herself',
    run: () => {
      const authored = skillAuthor.list();
      if (authored.length === 0) {
        return { handled: true, message: '🧠 You have not authored any skills yet.\n\nCreate one with `/skill-creator <name> — <what it should do>`.' };
      }
      const lines = authored.map(s =>
        `${resolveSkillIcon(s)} **${s.name}** (\`${s.id}\`)\n  ${s.description}\n  Tools: ${s.tools.join(', ') || 'none'} · used ${s.useCount}x`,
      );
      return { handled: true, message: `## 🧠 Skills you authored\n\n${lines.join('\n\n')}` };
    },
  },
  {
    name: 'skill-remove',
    aliases: ['skill-delete'],
    category: 'Skills & Agents',
    description: 'Delete an authored skill',
    usage: '/skill-remove <name>',
    run: ({ rest }) => {
      const want = rest.trim().toLowerCase();
      if (!want) return { handled: true, message: '⚠️ Name the skill: `/skill-remove Weekly Report`.' };
      const target = skillAuthor.list().find(s => s.id.toLowerCase() === want || s.name.toLowerCase() === want);
      if (!target) return { handled: true, message: `⚠️ No authored skill matches \`${rest.trim()}\`. Use \`/skill-list\`.` };
      skillAuthor.remove(target.id);
      return { handled: true, message: `🗑️ Removed skill **${target.name}**.` };
    },
  },
  {
    name: 'agents',
    category: 'Skills & Agents',
    description: 'List your custom agents',
    run: () => {
      const { agents } = useAgentStore.getState();
      if (agents.length === 0) return { handled: true, message: '🤖 No custom agents yet. Build one in the Agents module.' };
      const lines = agents.map(a => `- ${a.icon || '🤖'} **${a.name}** — ${truncate(a.description, 80)}\n  Tools: ${a.tools.join(', ') || 'none'}`);
      return { handled: true, message: `## Custom agents\n\n${lines.join('\n')}` };
    },
  },

  // ── MCP & Plugins ─────────────────────────────────────────────────────
  {
    name: 'mcp',
    category: 'MCP & Plugins',
    description: 'List MCP servers and their connection state',
    run: () => {
      const { servers, connections } = useMCPStore.getState();
      if (servers.length === 0) return { handled: true, message: '🔌 No MCP servers configured. Add one in Settings → MCP.' };
      const icon: Record<string, string> = { connected: '🟢', connecting: '🟡', error: '🔴', disconnected: '⚪' };
      const lines = servers.map(s => {
        const c = connections[s.id];
        const tools = c?.status === 'connected' ? ` · ${c.toolCount} tools` : '';
        const err = c?.error ? ` — _${truncate(c.error, 60)}_` : '';
        return `- ${icon[c?.status || 'disconnected']} **${s.name}** (\`${s.id}\`) — ${s.transport}${tools}${err}`;
      });
      const connected = Object.values(connections).filter(c => c.status === 'connected').length;
      return {
        handled: true,
        message: [
          `## MCP servers`,
          '',
          lines.join('\n'),
          '',
          `${connected}/${servers.length} connected${MCPManager.getToolNames().length ? ` · ${MCPManager.getToolNames().length} tools available` : ''}`,
          '',
          '`/mcp-connect <id>` · `/mcp-disconnect <id>` · `/mcp-tools`',
        ].join('\n'),
      };
    },
  },
  {
    name: 'mcp-connect',
    category: 'MCP & Plugins',
    description: 'Connect an MCP server',
    usage: '/mcp-connect <id or name>',
    run: ({ rest }) => {
      const { servers } = useMCPStore.getState();
      const want = rest.trim().toLowerCase();
      if (!want) {
        return { handled: true, message: '⚠️ Name a server: `/mcp-connect mcp-local-ollama`. `/mcp` lists them.' };
      }
      const match = servers.find(s => s.id === want)
        || servers.find(s => s.name.toLowerCase().includes(want))
        || servers.find(s => s.id.includes(want));
      if (!match) {
        return { handled: true, message: `⚠️ No MCP server matches \`${rest.trim()}\`.\n\n${servers.map(s => `\`${s.id}\``).join(', ')}` };
      }
      useMCPStore.getState().setConnectionState(match.id, { status: 'connecting', toolCount: 0 });
      void MCPManager.connect(match.id)
        .then(() => useGiaStore.getState().addNotification(`MCP ${match.name} connected`))
        .catch(e => {
          logger.warn('[slash] mcp connect failed:', e);
          notifyMcpFailure(match.name, e);
        });
      return { handled: true, message: `🔌 Connecting to **${match.name}**…` };
    },
  },
  {
    name: 'mcp-disconnect',
    category: 'MCP & Plugins',
    description: 'Disconnect an MCP server',
    usage: '/mcp-disconnect <id or name>',
    run: ({ rest }) => {
      const { servers } = useMCPStore.getState();
      const want = rest.trim().toLowerCase();
      const match = servers.find(s => s.id === want) || servers.find(s => s.name.toLowerCase().includes(want));
      if (!match) return { handled: true, message: `⚠️ No MCP server matches \`${rest.trim()}\`. \`/mcp\` lists them.` };
      void MCPManager.disconnect(match.id)
        .then(() => useGiaStore.getState().addNotification(`MCP ${match.name} disconnected`))
        .catch(e => logger.warn('[slash] mcp disconnect failed:', e));
      return { handled: true, message: `🔌 Disconnecting **${match.name}**…` };
    },
  },
  {
    name: 'mcp-tools',
    category: 'MCP & Plugins',
    description: 'List tools exposed by connected MCP servers',
    run: () => {
      const tools = MCPManager.getConnectedTools();
      if (tools.length === 0) {
        return { handled: true, message: '🔌 No MCP tools available. Connect a server with `/mcp-connect <id>`.' };
      }
      const byServer = new Map<string, typeof tools>();
      for (const t of tools) {
        if (!byServer.has(t.serverId)) byServer.set(t.serverId, []);
        byServer.get(t.serverId)!.push(t);
      }
      const sections = Array.from(byServer.entries()).map(([id, list]) =>
        `**${id}**\n${list.map(t => `- \`${t.name}\` — ${truncate(t.description, 90)}`).join('\n')}`,
      );
      return { handled: true, message: `## MCP tools\n\n${sections.join('\n\n')}` };
    },
  },
  {
    name: 'plugins',
    category: 'MCP & Plugins',
    description: 'List registered plugins',
    run: () => {
      const { plugins, pluginSettings } = usePluginStore.getState();
      if (plugins.length === 0) return { handled: true, message: '🧩 No plugins registered. Extensions register themselves on load.' };
      const lines = plugins.map(p => {
        const on = pluginSettings[p.id]?.enabled;
        return `- ${on ? '🟢' : '⚪'} **${p.name}** v${p.version} — ${truncate(p.description, 80)}\n  \`/plugin-toggle ${p.id}\` to ${on ? 'disable' : 'enable'}`;
      });
      return { handled: true, message: `## Plugins\n\n${lines.join('\n')}` };
    },
  },
  {
    name: 'plugin-toggle',
    aliases: ['plugin'],
    category: 'MCP & Plugins',
    description: 'Enable or disable a plugin',
    usage: '/plugin-toggle <id> [on|off]',
    run: ({ args }) => {
      const { plugins, pluginSettings, setPluginEnabled } = usePluginStore.getState();
      const want = (args[0] || '').toLowerCase();
      if (!want) return { handled: true, message: '⚠️ Name a plugin: `/plugin-toggle <id>`. `/plugins` lists them.' };
      const match = plugins.find(p => p.id === want) || plugins.find(p => p.name.toLowerCase().includes(want));
      if (!match) return { handled: true, message: `⚠️ No plugin matches \`${args[0]}\`.` };
      const current = pluginSettings[match.id]?.enabled ?? false;
      const verb = args[1]?.toLowerCase();
      const next = verb === 'on' || verb === 'true' ? true : verb === 'off' || verb === 'false' ? false : !current;
      setPluginEnabled(match.id, next);
      return { handled: true, message: `🧩 **${match.name}** ${next ? 'enabled' : 'disabled'}.` };
    },
  },

  // ── Notes, Memory & Tasks ─────────────────────────────────────────────
  {
    name: 'note',
    category: 'Notes, Memory & Tasks',
    description: 'Save a note',
    usage: '/note <text>',
    run: ({ rest }) => {
      const text = rest.trim();
      if (!text) return { handled: true, message: '⚠️ What should I note down? `/note deploy is Thursday 4pm`.' };
      const id = useNotesStore.getState().addNote({
        title: truncate(text, 48),
        content: text,
        color: '#a855f7',
        pinned: false,
        tags: [],
      });
      return { handled: true, message: `📝 Noted. (\`${id}\`)` };
    },
  },
  {
    name: 'notes',
    category: 'Notes, Memory & Tasks',
    description: 'Search your notes',
    usage: '/notes [text]',
    run: ({ rest }) => {
      const { notes, searchNotes } = useNotesStore.getState();
      const q = rest.trim();
      if (!q) {
        const recent = [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
        if (recent.length === 0) return { handled: true, message: '📭 No notes yet. `/note <text>` to add one.' };
        return {
          handled: true,
          message: [
            '## Recent notes',
            '',
            recent.map(n => `- ${n.pinned ? '📌' : '📄'} **${n.title}**${n.tags.length ? ` _${n.tags.join(', ')}_` : ''}\n  ${truncate(n.content, 100)}`).join('\n'),
            '',
            '_Search with `/notes <text>`._',
          ].join('\n'),
        };
      }
      const hits = searchNotes(q);
      if (hits.length === 0) return { handled: true, message: `🔍 No notes match **${q}**.` };
      return {
        handled: true,
        message: `## ${hits.length} note${hits.length === 1 ? '' : 's'} matching "${q}"\n\n${hits.slice(0, 15).map(n => `- ${n.pinned ? '📌' : '📄'} **${n.title}**\n  ${truncate(n.content, 120)}`).join('\n')}`,
      };
    },
  },
  {
    name: 'remember',
    aliases: ['memory'],
    category: 'Notes, Memory & Tasks',
    description: 'Save a durable memory GIA will recall later',
    usage: '/remember <fact>',
    run: ({ rest }) => {
      const value = rest.trim();
      if (!value) return { handled: true, message: '⚠️ What should I remember? `/remember the API keys live in the vault`.' };
      const key = value.split(/\s+/).slice(0, 5).join(' ').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      useMemoryStore.getState().addMemory({ key, value, category: 'fact', tier: 'semantic', confidence: 0.9 });
      return { handled: true, message: `🧠 Remembered. I’ll bring this up when it’s relevant.` };
    },
  },
  {
    name: 'memories',
    category: 'Notes, Memory & Tasks',
    description: 'List what GIA has remembered',
    usage: '/memories [category]',
    run: ({ rest }) => {
      const { memories } = useMemoryStore.getState();
      const want = rest.trim().toLowerCase();
      const list = want ? memories.filter(m => m.category === want) : memories;
      if (list.length === 0) {
        return { handled: true, message: want ? `🧠 No memories in category **${want}**.` : '🧠 Nothing remembered yet. `/remember <fact>` to start.' };
      }
      const sorted = [...list].sort((a, b) => b.confidence - a.confidence).slice(0, 30);
      return {
        handled: true,
        message: [
          `## 🧠 ${list.length} memor${list.length === 1 ? 'y' : 'ies'}`,
          '',
          sorted.map(m => `- **${m.key}** _${m.category}/${m.tier} · ${Math.round(m.confidence * 100)}%_\n  ${truncate(m.value, 120)}`).join('\n'),
        ].join('\n'),
      };
    },
  },
  {
    name: 'task',
    aliases: ['todo'],
    category: 'Notes, Memory & Tasks',
    description: 'Add or list tasks',
    usage: '/task <title>',
    run: ({ rest }) => {
      const { tasks, addTask } = useTaskStore.getState();
      const title = rest.trim();
      if (!title) {
        if (tasks.length === 0) return { handled: true, message: '✅ No tasks. `/task <title>` to add one.' };
        const open = tasks.filter(t => t.status !== 'done');
        const done = tasks.filter(t => t.status === 'done');
        const line = (t: typeof tasks[number]) => `- ${t.status === 'done' ? '☑️' : t.status === 'in_progress' ? '🔄' : '⬜'} **${t.title}**${t.dueDate ? ` _due ${t.dueDate}_` : ''}`;
        return {
          handled: true,
          message: [
            '## Tasks',
            '',
            open.length ? open.map(line).join('\n') : '_Nothing open._',
            done.length ? `\n\n_${done.length} done._` : '',
          ].filter(Boolean).join('\n'),
        };
      }
      const id = addTask({ title, description: '', status: 'todo', priority: 'medium', tags: [], dueDate: null });
      return { handled: true, message: `✅ Added **${title}** (\`${id}\`).` };
    },
  },
  {
    name: 'whoami',
    category: 'Notes, Memory & Tasks',
    description: 'Show GIA’s identity and how she is configured',
    run: () => {
      const { identity } = useGiaIdentity.getState();
      const level = Math.round(identity.proactiveness / 20);
      return {
        handled: true,
        message: [
          '## GIA',
          '',
          `**Name:** ${identity.name}`,
          `**Personality:** ${identity.personalityStyle}`,
          `**Tone:** ${identity.tone || 'default'}`,
          `**Proactiveness:** ${'▰'.repeat(level)}${'▱'.repeat(5 - level)} (${identity.proactiveness}%)`,
          `**Memory:** ${identity.allowsMemory ? 'allowed' : 'blocked'}`,
          identity.focusAreas.length ? `**Focus areas:** ${identity.focusAreas.join(', ')}` : '',
          identity.customPrompt ? `\n**Custom instructions:**\n${truncate(identity.customPrompt, 400)}` : '',
        ].filter(Boolean).join('\n'),
      };
    },
  },

  // ── System ────────────────────────────────────────────────────────────
  {
    name: 'btw',
    category: 'Notes, Memory & Tasks',
    description: 'Give GIA background context without asking her anything or waiting for a reply',
    usage: '/btw <note>',
    run: ({ rest }) => {
      const note = rest.trim();
      if (!note) {
        return { handled: true, message: '`/btw <note>` — say something out loud without a question attached. It is remembered for the rest of the conversation and she will not answer it now.' };
      }
      // Deliberately silent. The whole point of "by the way" is that it is not
      // a question: answering it turns ambient context into a round trip, which
      // is exactly the cost this command exists to avoid.
      const state = useGiaStore.getState();
      const sid = state.activeSessionId || state.createSession();
      state.addMessage(sid, {
        id: `btw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: note,
        timestamp: Date.now(),
      });
      return { handled: true, message: '' };
    },
  },
  {
    name: 'trust',
    aliases: ['permissions', 'grants'],
    category: 'System',
    description: 'Review what GIA is allowed to do, and revoke it',
    usage: '/trust [revoke <scope> | clear | arm | disarm]',
    run: ({ args, rest }) => {
      const store = useTrustStore.getState();
      const sub = (args[0] || '').toLowerCase();

      if (sub === 'disarm') {
        store.setArmed(false);
        return { handled: true, message: '🛑 **Disarmed.** GIA cannot run any tool until you arm it again with `/trust arm` or Ctrl/Cmd+Shift+X.' };
      }
      if (sub === 'arm') {
        store.setArmed(true);
        return { handled: true, message: '🔓 **Armed.** GIA can run tools again, subject to the grants below.' };
      }
      if (sub === 'clear' || sub === 'revoke-all') {
        store.revokeAll();
        return { handled: true, message: '✅ All standing grants revoked. Every write will ask again.' };
      }
      if (sub === 'revoke') {
        const scope = rest.trim().split(/\s+/).slice(1).join(' ');
        if (!scope) return { handled: true, message: 'Which grant? Try `/trust revoke write:/home/me/projects/api`.' };
        const all = [...store.sessionGrants, ...store.grants];
        const match = all.find(g => g.scope === scope || g.scope.includes(scope));
        if (!match) return { handled: true, message: `No grant matches \`${scope}\`. Run \`/trust\` to see the current list.` };
        store.revoke(match.scope);
        return { handled: true, message: `✅ Revoked: **${match.label}**.` };
      }

      const lines: string[] = [];
      lines.push(`## 🛡️ Trust`);
      lines.push('');
      lines.push(store.armed
        ? '**Armed** — GIA may run tools. Anything not already granted will ask first.'
        : '🛑 **Disarmed** — every tool call is blocked. Nothing runs until you re-arm.');
      lines.push('');
      lines.push(`Asking at or above: **${store.askThreshold}** risk. Kill switch: \`Ctrl/Cmd+Shift+X\`.`);
      lines.push('');

      if (store.grants.length === 0 && store.sessionGrants.length === 0) {
        lines.push('_No standing grants. She asks every time._');
      } else {
        lines.push('### Grants');
        for (const g of [...store.sessionGrants, ...store.grants]) {
          lines.push(`- \`${g.scope}\` — ${g.label} · ${RISK_META[g.risk].label} risk · used ${g.uses}×${g.session ? ' · this session only' : ' · saved'}`);
        }
      }

      const recent = store.audit.slice(0, 8);
      if (recent.length > 0) {
        lines.push('');
        lines.push('### Recent decisions');
        for (const a of recent) {
          const icon = a.choice === 'deny' ? '🚫' : a.choice === 'blocked' ? '🛑' : a.choice === 'auto' ? '⚡' : '✅';
          lines.push(`- ${icon} ${a.toolName} — ${a.choice}${a.risk !== 'none' ? ` · ${RISK_META[a.risk].label}` : ''}`);
        }
      }

      lines.push('');
      lines.push('`/trust revoke <scope>` · `/trust clear` · `/trust arm` · `/trust disarm`');
      return { handled: true, message: lines.join('\n') };
    },
  },
  {
    name: 'tools',
    category: 'System',
    description: 'List every tool GIA can call',
    usage: '/tools [filter]',
    run: ({ rest }) => {
      const all = giaTools.getAllTools();
      const q = rest.trim().toLowerCase();
      const list = q ? all.filter(t => t.id.includes(q) || (t.description || '').toLowerCase().includes(q)) : all;
      if (list.length === 0) return { handled: true, message: `🔧 No tools match **${rest.trim()}**.` };
      const groups = new Map<string, typeof list>();
      for (const t of list) {
        const { category } = categorizeTool(t.id);
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category)!.push(t);
      }
      const sections = Array.from(groups.entries())
        .sort((a, b) => b[1].length - a[1].length)
        .map(([cat, items]) => `**${cat}** (${items.length})\n${items.map(t => `- \`${t.id}\``).join(' ')}`);
      return {
        handled: true,
        message: [
          `## 🔧 ${list.length} tool${list.length === 1 ? '' : 's'}`,
          '',
          sections.join('\n\n'),
          '',
          q ? `_Filtered by "${rest.trim()}"._` : '_Filter with `/tools <text>`._',
        ].join('\n'),
      };
    },
  },
  {
    name: 'cost',
    aliases: ['usage', 'spend'],
    category: 'System',
    description: 'Token usage and estimated spend',
    run: () => {
      const state = useGiaStore.getState();
      const session = state.getActiveSession();
      if (!session) return { handled: true, message: 'No active session.' };

      let totalInput = 0;
      let totalOutput = 0;
      let msgCount = 0;
      let toolCalls = 0;
      walkMessages(session.messages, n => {
        if (n.message.tokenUsage) {
          totalInput += n.message.tokenUsage.input;
          totalOutput += n.message.tokenUsage.output;
        }
        msgCount++;
        if (n.message.content?.includes('```tool')) toolCalls++;
      });

      const { activeProvider, providers } = useProviderStore.getState();
      const model = providers[activeProvider]?.model || 'unknown';
      const totalTokens = totalInput + totalOutput;
      const summary = costTracker.getSummary();

      const top = Object.entries(summary.byModel)
        .sort((a, b) => b[1].cost - a[1].cost)
        .slice(0, 5)
        .map(([id, v]) => `- \`${id}\` — ${v.calls} calls · ${formatCost(v.cost)}`);

      return {
        handled: true,
        message: [
          '## Session Usage',
          '',
          `**Messages:** ${msgCount}`,
          `**Tool calls:** ${toolCalls}`,
          `**Input tokens:** ${totalInput.toLocaleString()}`,
          `**Output tokens:** ${totalOutput.toLocaleString()}`,
          `**Total tokens:** ${totalTokens.toLocaleString()}`,
          `**Model:** ${model}`,
          '',
          `**Spend this session:** ${formatCost(costTracker.getSessionCost(state.activeSessionId || ''))}`,
          `**Spend last 24h:** ${formatCost(costTracker.getTodayCost())}`,
          `**Spend all time:** ${formatCost(summary.totalCost)}`,
          top.length ? `\n**Top models**\n${top.join('\n')}` : '',
        ].filter(Boolean).join('\n'),
      };
    },
  },
  {
    name: 'tokens',
    aliases: ['ctx'],
    category: 'System',
    description: 'Context window usage',
    run: () => {
      const state = useGiaStore.getState();
      const session = state.getActiveSession();
      if (!session) return { handled: true, message: 'No active session.' };

      let contextChars = 0;
      let messageCount = 0;
      walkMessages(session.messages, n => {
        if (n.message.thinking) return;
        if (n.message.content) contextChars += n.message.content.length;
        messageCount++;
      });

      const text = session.messages.map(n => n.message.content || '').join('');
      const tokens = countTokens(text);
      const { activeProvider, providers } = useProviderStore.getState();
      const modelId = providers[activeProvider]?.model || '';
      // Use the provider's real window when known — 128k is a guess that
      // badly overstates headroom on small-context models.
      const ctxMeta = (useProviderStore.getState().availableModels[activeProvider] || [])
        .find(m => m.id === modelId)?.context;
      const parsedCtx = ctxMeta ? Number.parseInt(String(ctxMeta).replace(/[^\d]/g, ''), 10) : NaN;
      const maxContext = Number.isFinite(parsedCtx) && parsedCtx > 0 ? parsedCtx : 128000;
      const pct = Math.min(100, Math.round((tokens / maxContext) * 100));
      const filled = Math.min(20, Math.round(pct / 5));

      return {
        handled: true,
        message: [
          '## Context Window',
          '',
          `**Messages:** ${messageCount}`,
          `**Characters:** ${contextChars.toLocaleString()}`,
          `**Estimated tokens:** ~${tokens.toLocaleString()}`,
          `**Context used:** ${pct}% of ${maxContext.toLocaleString()}${ctxMeta ? '' : ' _(assumed — model window unknown)_'}`,
          `**Bar:** ${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}%`,
          '',
          pct > 80 ? '⚠️ Getting full. `/compact` will summarize the history.' : '',
        ].filter(Boolean).join('\n'),
      };
    },
  },
  {
    name: 'status',
    aliases: ['info'],
    category: 'System',
    description: 'Provider, model, and feature status',
    run: () => {
      const state = useGiaStore.getState();
      const { activeProvider, providers } = useProviderStore.getState();
      const cfg = providers[activeProvider];
      const features: string[] = [];
      if (state.webSearch) features.push('🔍 Web search');
      if (state.deepSearch) features.push('🕵️ Deep search');
      if (state.extThinking) features.push('🧠 Extended thinking');
      if (state.handsOff) features.push('⚡ Hands-off');
      if (state.localVision) features.push('👁️ Local vision');
      if (state.onDeviceMode) features.push('🔒 On-device');
      if (state.multiProvider) features.push('🤝 Multi-provider');
      if (state.smartFallback) features.push('🔄 Smart fallback');
      if (state.responseCache) features.push('💾 Response cache');
      if (state.inputGuardrails) features.push('🛡️ Input guardrails');
      if (state.outputValidation) features.push('🔍 Output validation');

      return {
        handled: true,
        message: [
          '## GIA Status',
          '',
          `**Provider:** ${activeProvider} ${cfg?.enabled ? '✅' : '❌'}${cfg?.apiKey ? '' : ' ⚠️ no key'}`,
          `**Model:** ${cfg?.model || 'none'}`,
          `**Network:** ${state.connectionStatus}`,
          `**Mode:** ${(state.sharedData.currentMode as string) || 'code'}`,
          `**Active skill:** ${state.activeSkillId || 'none'}`,
          `**Presenting:** ${presenterSupported() ? (isPresenting() ? 'yes' : 'no') : 'n/a'}`,
          '',
          '**Active features:**',
          features.length > 0 ? features.map(f => `- ${f}`).join('\n') : '- None',
          '',
          `**Sessions:** ${state.sessions.length}${state.archivedSessions.length ? ` (+${state.archivedSessions.length} archived)` : ''}`,
          `**Tools:** ${giaTools.getAllTools().length} registered`,
          `**MCP:** ${MCPManager.getConnectedTools().length} external tools`,
          `**Authored skills:** ${skillAuthor.list().length}`,
        ].join('\n'),
      };
    },
  },
  {
    name: 'present',
    aliases: ['presenter', 'hide-me'],
    category: 'System',
    description: 'Hide GIA for a screen share (restore from the tray)',
    desktopOnly: true,
    run: () => {
      if (!presenterSupported()) {
        return { handled: true, message: '🙈 Presenter mode needs the GIA Cowork desktop app — there is no window to hide in a browser tab.' };
      }
      // Fire-and-forget: the reply text would be invisible anyway once the
      // window is gone, and the state machine owns its own restore path.
      void togglePresenterMode();
      return {
        handled: true,
        message: '🙈 **Presenter mode.** GIA is out of your screen share.\n\nRestore her from the tray icon at any time — that is the only way back, by design.',
      };
    },
  },
  {
    name: 'note-project',
    aliases: ['mem', 'remember-project'],
    category: 'Notes, Memory & Tasks',
    description: 'Record a note about this project that future sessions will see',
    usage: '/note-project <decision|gotcha|architecture|convention|todo> — <what and why>',
    run: ({ rest }) => {
      const spec = rest.trim();
      if (!spec) {
        const project = useProjectContextStore.getState().entry?.projectName || 'current';
        const list = useProjectMemoryStore.getState().list(project);
        return {
          handled: true,
          message: [
            '## 📓 Project notes',
            '',
            'Notes GIA writes for herself while working in a project — they come back into every future session.',
            '',
            '**Usage:**',
            '`/note-project <kind> — <what and why>`',
            '',
            '**Kinds:** `decision` · `gotcha` · `architecture` · `convention` · `todo`',
            '',
            '**Example:**',
            '`/note-project gotcha — the dev relay only speaks HTTP, so do not swap it for websockets without reading relay/index.js`',
            '',
            list.length
              ? `**${list.length} recorded on \`${project}\`** — \`/note-project\` with no arguments lists them.`
              : `Nothing recorded on \`${project}\` yet.`,
          ].join('\n'),
        };
      }

      const m = spec.match(/^(decision|gotcha|architecture|convention|todo)\s*(?:—|--|-|:)\s*(.+)$/i);
      if (!m) {
        return {
          handled: true,
          message: '⚠️ Start with a kind: `/note-project gotcha — <what and why>`.\n\nKinds: `decision` · `gotcha` · `architecture` · `convention` · `todo`',
        };
      }
      const kind = m[1].toLowerCase() as ProjectMemoryKind;
      const body = m[2].trim();
      if (body.length < 10) {
        return { handled: true, message: '⚠️ Add a bit more — the *why* is the part that cannot be re-derived from the code later.' };
      }

      const project = useProjectContextStore.getState().entry?.projectName || 'current';
      const entry = useProjectMemoryStore.getState().add({
        project, kind,
        title: truncate(body, 60),
        body,
        paths: [],
      });
      return {
        handled: true,
        message: `📓 Noted on **${project}**: _${kind}_ — **${entry.title}**\n\nI'll carry this into future sessions.`,
      };
    },
  },
  {
    name: 'init',
    aliases: ['context', 'analyse', 'analyze'],
    category: 'System',
    description: 'Read this project and write an AGENTS.md so future sessions start informed',
    usage: '/init [path]',
    run: ({ args, raw }) => {
      const target = args.join(' ').trim();
      const verb = raw.trim().toLowerCase();

      if (verb.endsWith(' scan') || verb.endsWith(' analyse') || verb.endsWith(' analyze')) {
        // Report-only: show the profile without writing anything.
        void (async () => {
          try {
            const { scanProject, summarizeProfile } = await import('./ProjectContext');
            const profile = await scanProject(target || undefined);
            postToSession(`## 🔍 Project scan\n\n${summarizeProfile(profile)}\n\n${profile.conventions.map(c => `- ${c}`).join('\n')}\n\n_Write it with \`/init\`._`);
          } catch (e) {
            postToSession(`⚠️ Scan failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        })();
        return { handled: true, message: '🔍 Reading the project…' };
      }

      void (async () => {
        try {
          const { scanProject, renderContextMarkdown, summarizeProfile, chooseContextFilename } = await import('./ProjectContext');
          const profile = await scanProject(target || undefined);
          const file = chooseContextFilename(profile.topLevel);
          const markdown = renderContextMarkdown(profile);
          const dir = (target || profile.root).replace(/\/+$/, '');

          const { fileSnapshots } = await import('./FileSnapshots');
          const snap = await fileSnapshots.capture(`${dir}/${file}`, markdown, 'project_context');

          const { default: terminalService } = await import('./TerminalService');
          let delimiter = 'GIA_EOF';
          while (markdown.includes(delimiter)) delimiter += '_X';
          const res = await terminalService.exec(
            `cat > ${JSON.stringify(`${dir}/${file}`)} <<'${delimiter}'\n${markdown}\n${delimiter}`,
            undefined, undefined, 20000,
          );
          if (res?.exitCode !== 0) {
            postToSession(`⚠️ Could not write \`${file}\` into ${dir}. Check the path and permissions.`);
            return;
          }

          const { useProjectContextStore } = await import('../store/useProjectContextStore');
          useProjectContextStore.getState().setEntry({
            path: `${dir}/${file}`,
            projectName: profile.name,
            markdown,
            updatedAt: Date.now(),
          });

          postToSession([
            `## 📘 Initialised ${file}`,
            '',
            summarizeProfile(profile),
            '',
            `**Wrote** \`${dir}/${file}\` (${markdown.length.toLocaleString()} chars)`,
            snap ? '_A snapshot was taken, so you can undo this from Settings → Undo._' : '_This file did not exist before._',
            '',
            'I\'ll read it before making changes from now on.',
          ].filter(Boolean).join('\n'));
        } catch (e) {
          postToSession(`⚠️ \`/init\` failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();

      return {
        handled: true,
        message: '📘 Reading the project and writing an `AGENTS.md`…\n\n_I\'ll post the result here when it\'s done._',
      };
    },
  },
  {
    name: 'undo',
    category: 'System',
    description: 'List file changes GIA can undo',
    run: () => {
      // Synchronous by design — the dispatcher is sync, so this reads the
      // already-loaded snapshot list rather than awaiting a dynamic import.
      const pending = fileSnapshots.list();
      if (pending.length === 0) return { handled: true, message: '↩️ No file changes waiting to be undone.' };
      return {
        handled: true,
        message: [
          `## ↩️ ${pending.length} file change${pending.length === 1 ? '' : 's'} to undo`,
          '',
          pending.slice(0, 20).map(c => `- \`${truncate(c.path, 60)}\` _${relativeTime(c.timestamp)}_`).join('\n'),
          '',
          '_Revert from Settings → Undo, or ask me to undo a specific file._',
        ].join('\n'),
      };
    },
  },
];

function notifyMcpFailure(name: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  useGiaStore.getState().addNotification(`MCP ${name} failed: ${truncate(msg, 80)}`);
}

/**
 * Append a message to the active session from an async command.
 *
 * `/init` and `/models refresh` finish long after the dispatcher returned, so
 * they report back here rather than through the command result.
 */
function postToSession(content: string) {
  const s = useGiaStore.getState();
  const sid = s.activeSessionId || s.createSession();
  s.addMessage(sid, {
    id: Math.random().toString(36).slice(2),
    role: 'assistant',
    content,
    timestamp: Date.now(),
  });
}

function available(c: CommandSpec): boolean {
  return !(c.desktopOnly && !isDesktop);
}

// Index by name and alias so lookup stays O(1) and aliases cannot shadow
// each other silently — a duplicate is a bug worth surfacing in dev.
const LOOKUP = new Map<string, CommandSpec>();
for (const c of REGISTRY) {
  LOOKUP.set(c.name, c);
  for (const a of c.aliases || []) {
    if (LOOKUP.has(a)) {
      logger.warn(`[slash] duplicate alias "${a}" on /${c.name} — keeping the first registration`);
    } else {
      LOOKUP.set(a, c);
    }
  }
}

/** The command a bare reference names, or undefined. */
export function getCommandByName(ref: string): CommandSpec | undefined {
  const p = ref.replace(/^\//, '').toLowerCase();
  if (!p || p.includes(' ')) return undefined;
  return LOOKUP.get(p);
}

export function processSlashCommand(input: string): SlashCommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { handled: false };

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase().slice(1);
  const args = parts.slice(1);
  const rawName = parts[0];

  const spec = LOOKUP.get(cmd);
  if (!spec) {
    // Offer the closest match rather than a dead end — a typo should cost one
    // keystroke, not a trip to /help.
    const suggestion = suggest(cmd);
    return {
      handled: true,
      message: [
        `Unknown command: \`${rawName}\``,
        '',
        suggestion ? `Did you mean \`/${suggestion.name}\`? — ${suggestion.description}` : null,
        '',
        'Type `/help` to see everything, or `/` in the composer for autocomplete.',
      ].filter(Boolean).join('\n'),
    };
  }

  if (!available(spec)) {
    return {
      handled: true,
      message: `⚠️ \`/${spec.name}\` needs the GIA Cowork desktop app. This does not look like the desktop shell.`,
    };
  }

  try {
    return spec.run({ args, rest: args.join(' '), raw: trimmed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`[slash] /${spec.name} failed:`, e);
    return { handled: true, message: `⚠️ \`/${spec.name}\` failed: ${msg}` };
  }
}

/** Cheap edit-distance suggestion for a mistyped command. */
function suggest(cmd: string): CommandSpec | undefined {
  let best: { spec: CommandSpec; score: number } | undefined;
  for (const c of REGISTRY) {
    if (!available(c)) continue;
    for (const name of [c.name, ...(c.aliases || [])]) {
      const score = editDistance(cmd, name);
      // Only suggest when the names are genuinely close, or every short
      // command would match everything.
      if (score <= Math.max(2, Math.floor(name.length / 3)) && (!best || score < best.score)) {
        best = { spec: c, score };
      }
    }
  }
  return best?.spec;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Commands visible in this environment, for the help list and autocomplete. */
export function getCommands(): CommandSpec[] {
  return REGISTRY.filter(available);
}

export function getCommandList(): string[] {
  return getCommands().map(c => c.name);
}

/**
 * What a bare `/` shows.
 *
 * This used to be `getCommands().slice(0, limit)`, i.e. the first N entries in
 * registry order. Those all lived under "Chat & Sessions", so `/init`, `/mcp`,
 * `/model` and `/provider` were never shown unless you already typed their
 * name — 47 of 55 commands were undiscoverable from the menu itself.
 *
 * Round-robin across categories instead, so one `/` gives a cross-section of
 * every category and the menu is a browsing surface rather than a fragment.
 */
function browseCommands(limit: number): CommandSpec[] {
  const byCategory = new Map<CommandCategory, CommandSpec[]>();
  for (const c of getCommands()) {
    const bucket = byCategory.get(c.category);
    if (bucket) bucket.push(c);
    else byCategory.set(c.category, [c]);
  }

  const buckets = [...byCategory.values()];
  const rounds = Math.max(0, ...buckets.map(b => b.length));
  const out: CommandSpec[] = [];
  for (let i = 0; i < rounds && out.length < limit; i++) {
    for (const bucket of buckets) {
      if (out.length >= limit) break;
      if (bucket[i]) out.push(bucket[i]);
    }
  }
  return out;
}

/**
 * Commands matching a `/partial` prefix, for the composer autocomplete menu.
 */
export function getCommandSuggestions(prefix: string, limit = 8): CommandSpec[] {
  const p = prefix.replace(/^\//, '').toLowerCase();
  if (!p) return browseCommands(limit);
  return getCommands()
    .map(c => {
      // The canonical name outranks an alias: typing "/sess" should surface
      // /sessions, not /new (which merely has "session" as an alias).
      const namePrefix = c.name.startsWith(p);
      const aliasPrefix = (c.aliases || []).some(a => a.startsWith(p));
      const anySubstring = c.name.includes(p) || (c.aliases || []).some(a => a.includes(p));
      const descHit = c.description.toLowerCase().includes(p);
      const rank = namePrefix ? 0 : aliasPrefix ? 1 : anySubstring ? 2 : descHit ? 3 : 4;
      return { c, rank };
    })
    .filter(x => x.rank < 4)
    // Within a rank, a shorter name is the more specific match (/model before
    // /model-list), so a bare prefix lands on the command itself.
    .sort((a, b) => a.rank - b.rank || a.c.name.length - b.c.name.length)
    .slice(0, limit)
    .map(x => x.c);
}

export function isSlashCommand(input: string): boolean {
  return input.trim().startsWith('/');
}
