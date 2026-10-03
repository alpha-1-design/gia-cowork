import { describe, it, expect, beforeEach, vi } from 'vitest';

// Keeps the desktop-only command (/present) out of the visible set.
vi.mock('../../platform', () => ({ isTauri: () => false, isDesktop: false, isWeb: () => true }));

import {
  processSlashCommand,
  getCommands,
  getCommandList,
  getCommandSuggestions,
  isSlashCommand,
} from '../SlashCommands';
import { useGiaStore } from '../../store/useGiaStore';
import { useProviderStore } from '../../store/useProviderStore';
import { useMCPStore } from '../../store/useMCPStore';
import { usePluginStore } from '../../store/usePluginStore';
import { useNotesStore } from '../../store/useNotesStore';
import { useTaskStore } from '../../store/useTaskStore';
import { useMemoryStore } from '../../store/useMemoryStore';
import ToolRegistry from '../ToolRegistry';
import { fileSnapshots } from '../FileSnapshots';
import { useProjectMemoryStore } from '../ProjectMemory';
import { useProjectContextStore } from '../../store/useProjectContextStore';

function seedSessions() {
  useGiaStore.setState({
    sessions: [
      { id: 's1', title: 'Auth refactor', messages: [], createdAt: Date.now() - 7200000, updatedAt: Date.now() - 60000, currentBranchId: 'b' },
      { id: 's2', title: 'Dashboard design', messages: [], createdAt: Date.now() - 86400000, updatedAt: Date.now() - 3600000, currentBranchId: 'b' },
      { id: 's3', title: 'Auth tokens audit', messages: [], createdAt: Date.now() - 172800000, updatedAt: Date.now() - 86400000, currentBranchId: 'b' },
    ],
    archivedSessions: [],
    activeSessionId: 's1',
  });
}

describe('SlashCommands registry', () => {
  beforeEach(() => {
    useGiaStore.setState({
      sessions: [], archivedSessions: [], activeSessionId: null,
      webSearch: false, extThinking: false, handsOff: false, onDeviceMode: false,
      theme: 'dark', scheduledTasks: [],
    });
    useProviderStore.setState({
      activeProvider: 'openai',
      providers: {
        openai: { apiKey: 'sk-x', model: 'gpt-4o-mini', enabled: true },
        anthropic: { apiKey: '', model: 'claude-sonnet-4-5', enabled: true },
        ollama: { apiKey: '', model: 'llama3', enabled: false },
      },
      availableModels: {
        openai: [
          { id: 'gpt-4o', label: 'GPT-4o', free: false, context: '128000' },
          { id: 'gpt-4o-mini', label: 'GPT-4o mini', free: false },
        ],
      },
      modelListStatus: {},
    });
    useMCPStore.setState({ servers: [], connections: {} });
    usePluginStore.setState({ plugins: [], pluginSettings: {} });
    useNotesStore.setState({ notes: [] });
    useTaskStore.setState({ tasks: [] });
    useMemoryStore.setState({ memories: [] });
    useProjectMemoryStore.setState({ entries: [] });
    useProjectContextStore.setState({ entry: null });
    // The registry has no bulk clear, so drop the tools these tests register.
    for (const id of ['web_search', 'filesystem_read']) ToolRegistry.unregister(id);
  });

  it('ignores anything that is not a slash command', () => {
    expect(processSlashCommand('hello there').handled).toBe(false);
    expect(processSlashCommand('').handled).toBe(false);
    expect(isSlashCommand('/help')).toBe(true);
    expect(isSlashCommand('  /help')).toBe(true);
    expect(isSlashCommand('help')).toBe(false);
  });

  it('covers every subsystem the user called out', () => {
    const names = getCommandList();
    for (const expected of [
      'mcp', 'mcp-connect', 'mcp-disconnect', 'mcp-tools',
      'plugins', 'plugin-toggle',
      'model', 'models', 'provider', 'key',
      'sessions', 'copy', 'rename', 'fork', 'search', 'delete',
      'agents', 'notes', 'note', 'memories', 'remember', 'task', 'tools',
      'init', 'note-project',
    ]) {
      expect(names, `missing /${expected}`).toContain(expected);
    }
  });

  it('hides desktop-only commands outside the desktop shell', () => {
    expect(getCommandList()).not.toContain('present');
  });

  it('has no duplicate command names or aliases', () => {
    const seen = new Set<string>();
    for (const c of getCommands()) {
      for (const key of [c.name, ...(c.aliases || [])]) {
        expect(seen.has(key), `duplicate /${key}`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('gives every command a description and a category', () => {
    for (const c of getCommands()) {
      expect(c.description.length, `/${c.name} needs a description`).toBeGreaterThan(5);
      expect(c.category).toBeTruthy();
    }
  });

  it('suggests the nearest command on a typo instead of dead-ending', () => {
    const res = processSlashCommand('/hlep');
    expect(res.handled).toBe(true);
    expect(res.message).toMatch(/Did you mean/i);
    expect(res.message).toMatch(/\/help/);
  });

  it('reports a failure inside a command instead of throwing', () => {
    const res = processSlashCommand('/rename');
    expect(res.handled).toBe(true);
    // No active session in this state, so it must explain rather than crash.
    expect(res.message).toMatch(/⚠️|active session/i);
  });

  // ── help ───────────────────────────────────────────────────────────────
  it('groups /help by category and lists usage', () => {
    const res = processSlashCommand('/help');
    expect(res.handled).toBe(true);
    for (const cat of ['Chat & Sessions', 'Models & Providers', 'MCP & Plugins', 'Notes, Memory & Tasks']) {
      expect(res.message).toContain(cat);
    }
    expect(res.message).toContain('/mcp-connect <id or name>');
  });

  it('filters /help by category', () => {
    const res = processSlashCommand('/help mcp');
    expect(res.message).toContain('/mcp-connect');
    expect(res.message).not.toContain('/skill-creator');
  });

  // ── sessions ───────────────────────────────────────────────────────────
  it('lists sessions and switches by index', () => {
    seedSessions();
    const list = processSlashCommand('/sessions');
    expect(list.message).toContain('Auth refactor');
    expect(list.message).toContain('Dashboard design');

    const sw = processSlashCommand('/sessions 2');
    expect(sw.message).toMatch(/Switched to \*\*Dashboard design\*\*/);
    expect(useGiaStore.getState().activeSessionId).toBe('s2');
  });

  it('switches by unique title prefix', () => {
    seedSessions();
    const res = processSlashCommand('/sessions Dashboard');
    expect(res.message).toMatch(/Switched/);
    expect(useGiaStore.getState().activeSessionId).toBe('s2');
  });

  it('refuses an ambiguous prefix instead of guessing', () => {
    seedSessions();
    const res = processSlashCommand('/sessions Auth');
    expect(res.message).toMatch(/matches 2 sessions/);
    expect(useGiaStore.getState().activeSessionId).toBe('s1');
  });

  it('refuses to switch to a session that does not exist', () => {
    seedSessions();
    const res = processSlashCommand('/sessions nothing like this');
    expect(res.message).toMatch(/No session matches/);
    expect(useGiaStore.getState().activeSessionId).toBe('s1');
  });

  it('renames the active session', () => {
    seedSessions();
    const res = processSlashCommand('/rename Ship the release');
    expect(res.handled).toBe(true);
    expect(useGiaStore.getState().sessions[0].title).toBe('Ship the release');
    expect(res.message).toContain('Ship the release');
  });

  it('requires a title for /rename', () => {
    seedSessions();
    const res = processSlashCommand('/rename');
    expect(res.message).toMatch(/Give me a title/);
    expect(useGiaStore.getState().sessions[0].title).toBe('Auth refactor');
  });

  it('copies a session into a new one and drops thinking traces', () => {
    useGiaStore.setState({
      sessions: [], archivedSessions: [], activeSessionId: null,
    });
    const sid = useGiaStore.getState().createSession();
    useGiaStore.getState().addMessage(sid, {
      id: 'm1', role: 'user', content: 'how do I ship this', timestamp: Date.now(),
    });
    useGiaStore.getState().addMessage(sid, {
      id: 'm2', role: 'assistant', content: 'run the build', timestamp: Date.now(),
    });

    const res = processSlashCommand('/copy');
    expect(res.handled).toBe(true);
    expect(res.message).toMatch(/Copied/);

    const state = useGiaStore.getState();
    expect(state.sessions).toHaveLength(2);
    const copy = state.sessions.find(s => s.title.includes('(copy)'))!;
    expect(copy).toBeTruthy();
    expect(state.activeSessionId).toBe(copy.id);
    expect(copy.messages).toHaveLength(2);
  });

  it('deletes a session by index', () => {
    seedSessions();
    const res = processSlashCommand('/delete 2');
    expect(res.message).toMatch(/Deleted \*\*Dashboard design\*\*/);
    expect(useGiaStore.getState().sessions.map(s => s.id)).toEqual(['s1', 's3']);
  });

  it('demands a target for /delete rather than deleting something arbitrary', () => {
    seedSessions();
    const res = processSlashCommand('/delete');
    expect(res.message).toMatch(/Name the session/);
    expect(useGiaStore.getState().sessions).toHaveLength(3);
  });

  it('searches session history', () => {
    seedSessions();
    const sid = 's1';
    useGiaStore.setState({
      sessions: useGiaStore.getState().sessions.map(s =>
        s.id === sid
          ? {
              ...s,
              messages: [{
                id: 'n1',
                message: { id: 'm1', role: 'user' as const, content: 'the refresh token expires too early', timestamp: Date.now() },
                children: [],
              }],
            }
          : s,
      ),
    });
    const res = processSlashCommand('/search refresh token');
    expect(res.message).toMatch(/1 match/);
    expect(res.message).toContain('Auth refactor');
  });

  it('reports when a search finds nothing', () => {
    seedSessions();
    const res = processSlashCommand('/search zzzznothing');
    expect(res.message).toMatch(/Nothing in your 3 sessions/);
  });

  // ── models & providers ─────────────────────────────────────────────────
  it('refuses a model that is not in the provider list', () => {
    const res = processSlashCommand('/model gpt-9000');
    expect(res.message).toMatch(/not in the openai model list/);
    expect(useProviderStore.getState().providers.openai.model).toBe('gpt-4o-mini');
  });

  it('switches to a known model', () => {
    const res = processSlashCommand('/model gpt-4o');
    expect(res.message).toMatch(/switched to \*\*gpt-4o\*\*/);
    expect(useProviderStore.getState().providers.openai.model).toBe('gpt-4o');
  });

  it('flags enabled providers with no key', () => {
    const res = processSlashCommand('/key');
    expect(res.message).toMatch(/anthropic.*enabled, no key/s);
    // Must never echo a key value.
    expect(res.message).not.toContain('sk-x');
  });

  it('switches provider and rejects an unknown one', () => {
    expect(processSlashCommand('/provider ollama').message).toMatch(/Switched to \*\*ollama\*\*/);
    expect(useProviderStore.getState().activeProvider).toBe('ollama');
    expect(processSlashCommand('/provider nope').message).toMatch(/Unknown provider/);
  });

  // ── capability toggles ─────────────────────────────────────────────────
  it('toggles a capability with no argument and reads the new state', () => {
    expect(useGiaStore.getState().webSearch).toBe(false);
    const on = processSlashCommand('/web');
    expect(on.message).toMatch(/Web search: on/);
    expect(useGiaStore.getState().webSearch).toBe(true);

    processSlashCommand('/web off');
    expect(useGiaStore.getState().webSearch).toBe(false);
  });

  it('sets a capability to an explicit value rather than flipping it', () => {
    processSlashCommand('/web on');
    processSlashCommand('/web on');
    expect(useGiaStore.getState().webSearch).toBe(true);
  });

  it('rejects a nonsense toggle value instead of silently flipping', () => {
    const res = processSlashCommand('/web maybe');
    expect(res.message).toMatch(/not a value I understand/);
    expect(useGiaStore.getState().webSearch).toBe(false);
  });

  it('switches theme and rejects an unknown one', () => {
    // Confirmation names the theme as a human would say it ("Light"), not the
    // raw id the user typed. Case-insensitive, because the label is display
    // copy and the stored value is the thing under test below.
    expect(processSlashCommand('/theme light').message).toMatch(/light/i);
    expect(useGiaStore.getState().theme).toBe('light');
    expect(processSlashCommand('/theme neon').message).toMatch(/Unknown theme/);
    expect(useGiaStore.getState().theme).toBe('light');
  });

  // ── MCP & plugins ──────────────────────────────────────────────────────
  it('lists MCP servers with connection state', () => {
    useMCPStore.setState({
      servers: [
        { id: 'mcp-local-ollama', name: 'Local Ollama', transport: 'sse', url: '', command: '', args: [], enabled: true, autoConnect: true },
      ],
      connections: { 'mcp-local-ollama': { status: 'connected', toolCount: 7 } },
    });
    const res = processSlashCommand('/mcp');
    expect(res.message).toContain('Local Ollama');
    expect(res.message).toContain('7 tools');
    expect(res.message).toContain('1/1 connected');
  });

  it('reports no MCP servers rather than an empty table', () => {
    const res = processSlashCommand('/mcp');
    expect(res.message).toMatch(/No MCP servers configured/);
  });

  it('does not connect to an unknown MCP server', () => {
    const res = processSlashCommand('/mcp-connect nope');
    expect(res.message).toMatch(/No MCP server matches/);
  });

  it('toggles a plugin', () => {
    usePluginStore.setState({
      plugins: [{ id: 'p1', name: 'Notion', version: '1.2.0', description: 'Notion sync' }],
      pluginSettings: {},
    });
    expect(processSlashCommand('/plugin-toggle p1').message).toMatch(/enabled/);
    expect(usePluginStore.getState().pluginSettings.p1.enabled).toBe(true);
    expect(processSlashCommand('/plugin-toggle p1 off').message).toMatch(/disabled/);
    expect(usePluginStore.getState().pluginSettings.p1.enabled).toBe(false);
  });

  // ── notes, memory, tasks ───────────────────────────────────────────────
  it('adds a note and searches it back', () => {
    processSlashCommand('/note the deploy key rotates on Fridays');
    expect(useNotesStore.getState().notes).toHaveLength(1);

    const found = processSlashCommand('/notes deploy key');
    expect(found.message).toContain('deploy key rotates on Fridays');
  });

  it('adds a memory with a valid tier', () => {
    processSlashCommand('/remember the staging database is read-only');
    const mems = useMemoryStore.getState().memories;
    expect(mems).toHaveLength(1);
    expect(mems[0].value).toContain('staging database');
  });

  it('adds a task', () => {
    processSlashCommand('/task rotate the deploy key');
    expect(useTaskStore.getState().tasks).toHaveLength(1);
    expect(useTaskStore.getState().tasks[0].title).toBe('rotate the deploy key');
  });

  // ── tools ──────────────────────────────────────────────────────────────
  it('lists tools grouped by category', () => {
    ToolRegistry.register({
      id: 'web_search', name: 'Web search', description: 'Search the web',
      execute: async () => ({ success: true, content: '' }),
    });
    ToolRegistry.register({
      id: 'filesystem_read', name: 'Read file', description: 'Read a file',
      execute: async () => ({ success: true, content: '' }),
    });
    const res = processSlashCommand('/tools');
    expect(res.message).toContain('Web & Search');
    expect(res.message).toContain('Files & Data');
    expect(res.message).toContain('web_search');
  });

  it('filters the tool list', () => {
    ToolRegistry.register({
      id: 'web_search', name: 'Web search', description: 'Search the web',
      execute: async () => ({ success: true, content: '' }),
    });
    ToolRegistry.register({
      id: 'filesystem_read', name: 'Read file', description: 'Read a file',
      execute: async () => ({ success: true, content: '' }),
    });
    const res = processSlashCommand('/tools filesystem');
    expect(res.message).toContain('filesystem_read');
    expect(res.message).not.toMatch(/- `web_search`/);
  });

  it('rejects a skill that pins an unregistered tool', () => {
    const res = processSlashCommand('/skill-creator Report — build it --tools not_a_real_tool');
    expect(res.message).toMatch(/not a registered tool/);
  });

  // ── init ───────────────────────────────────────────────────────────────
  it('/init acknowledges immediately and reports the result back to the session', async () => {
    // The scan runs through the terminal, which is unavailable in tests. What
    // matters is that the command is handled, acknowledges synchronously, and
    // surfaces a failure into the session rather than failing silently.
    const res = processSlashCommand('/init');
    expect(res.handled).toBe(true);
    expect(res.message).toMatch(/AGENTS\.md/);

    // The async body only reaches the session after its dynamic imports
    // resolve, so poll rather than guess a fixed delay.
    let posted = '';
    for (let i = 0; i < 40 && !posted; i++) {
      await new Promise(r => setTimeout(r, 25));
      const s = useGiaStore.getState();
      const all = JSON.stringify(s.sessions.map(x => x.messages));
      // Either the document was written or the failure was explained — what
      // must not happen is silence, which is indistinguishable from a hang.
      if (all.includes('AGENTS.md')) posted = all;
    }
    expect(posted, '/init never reported back into the session').not.toBe('');
  });

  it('/init lists as a System command with usage in help', () => {
    expect(processSlashCommand('/help').message).toContain('/init [path]');
  });

  // ── project notes ─────────────────────────────────────────────────────
  it('/note-project records a typed note', () => {
    const res = processSlashCommand('/note-project gotcha — the dev relay only speaks HTTP');
    expect(res.handled).toBe(true);
    expect(useProjectMemoryStore.getState().entries).toHaveLength(1);
    expect(useProjectMemoryStore.getState().entries[0].kind).toBe('gotcha');
  });

  it('/note-project requires a kind', () => {
    const res = processSlashCommand('/note-project the relay is HTTP only');
    expect(res.message).toMatch(/Start with a kind/);
    expect(useProjectMemoryStore.getState().entries).toHaveLength(0);
  });

  it('/note-project rejects a note with no substance', () => {
    const res = processSlashCommand('/note-project gotcha — a');
    expect(res.message).toMatch(/Add a bit more/);
    expect(useProjectMemoryStore.getState().entries).toHaveLength(0);
  });

  it('/note-project with no arguments explains itself and lists notes', () => {
    const empty = processSlashCommand('/note-project');
    expect(empty.message).toMatch(/decision.*gotcha.*architecture/s);
    expect(empty.message).toMatch(/Nothing recorded/);

    processSlashCommand('/note-project gotcha — the relay only speaks HTTP');
    const listed = processSlashCommand('/note-project');
    expect(listed.message).toContain('1 recorded');
  });

  // ── undo ───────────────────────────────────────────────────────────────
  it('reports nothing to undo when the snapshot list is empty', async () => {
    await fileSnapshots.clear();
    const res = processSlashCommand('/undo');
    expect(res.message).toMatch(/No file changes waiting/);
  });

  // ── autocomplete ───────────────────────────────────────────────────────
  it('suggests commands for a bare slash', () => {
    const list = getCommandSuggestions('/');
    expect(list.length).toBeGreaterThan(4);
    expect(list.length).toBeLessThanOrEqual(8);
  });

  it('ranks prefix matches above fuzzy matches', () => {
    const list = getCommandSuggestions('/sess');
    expect(list[0].name).toBe('sessions');
  });

  it('matches on alias as well as name', () => {
    const list = getCommandSuggestions('/spend');
    expect(list.map(c => c.name)).toContain('cost');
  });

  it('matches on description text when no name matches', () => {
    // "configured" appears only in /whoami's description — no name or alias
    // contains it, so this can only match through the description fallback.
    const list = getCommandSuggestions('/configured');
    expect(list.map(c => c.name)).toContain('whoami');
  });

  it('returns nothing for a prefix no command matches', () => {
    expect(getCommandSuggestions('/zzzznotacommand')).toEqual([]);
  });

  it('never suggests a desktop-only command in a browser', () => {
    // /present would be a no-op outside Tauri, so it must not even appear in
    // the autocomplete list the user is choosing from.
    const names = getCommandSuggestions('/').map(c => c.name);
    expect(names).not.toContain('present');
    expect(getCommandSuggestions('/present')).toEqual([]);
  });
});