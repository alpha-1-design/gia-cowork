import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGiaState = {
  userProfile: { name: '', bio: '', goals: '' },
  activeSkillId: null as string | null,
  skills: [] as { id: string; name: string; description: string }[],
  extThinking: false,
  customInstructions: '',
  pinnedMemories: [] as string[],
  handsOff: false,
  sessions: [] as unknown[],
};

const mockIdentityState = {
  identity: {
    name: 'GIA',
    personalityStyle: 'warm',
    customPrompt: '',
    focusAreas: [] as string[],
    proactiveness: 0.5,
    tone: 'casual',
  },
};

const mockMemoryState = {
  memories: [] as unknown[],
  getRelevantContext: vi.fn(() => ''),
};

const mockProviderState = {
  activeProvider: 'openai',
  providers: {
    openai: { enabled: true, apiKey: 'sk-test', model: 'gpt-4o' },
  },
  availableModels: {
    openai: [
      { id: 'gpt-4o', label: 'GPT-4o', free: false, tools: true, vision: true, context: { length: 128000 } },
    ],
  },
};

let mockGetState: Record<string, unknown> = {};

vi.mock('../../store/useGiaStore', () => ({
  useGiaStore: {
    getState: vi.fn(() => mockGetState.gia || mockGiaState),
  },
}));

vi.mock('../../store/useMemoryStore', () => ({
  useMemoryStore: {
    getState: vi.fn(() => mockGetState.memory || mockMemoryState),
  },
}));

vi.mock('../../store/useProviderStore', () => ({
  useProviderStore: {
    getState: vi.fn(() => mockGetState.provider || mockProviderState),
  },
}));

vi.mock('../../store/useGiaIdentity', () => ({
  useGiaIdentity: {
    getState: vi.fn(() => mockGetState.identity || mockIdentityState),
  },
}));

vi.mock('../../utils/helpers', () => ({
  isNativePlatform: vi.fn(() => false),
}));

vi.mock('../../config/gia-identity', () => ({
  GIA_VOICE: {
    name: 'GIA',
    subtitle: 'Your Co-Work Agent',
    tagline: 'Built for the work, built for you.',
    traits: ['Direct but warm', 'Gets excited about good ideas'],
    speech: {
      openings: ['Here we go.', 'Let\'s get into it.', 'Alright —'],
      confirmations: ['Got it.', 'On it.', 'Done.'],
    },
    rules: ['Be direct', 'Use tools', 'Stay helpful'],
    context: {
      chat: { tone: 'conversational', energy: 'moderate', warmth: 'high' },
      debugging: { tone: 'technical', energy: 'focused', warmth: 'medium' },
      planning: { tone: 'strategic', energy: 'measured', warmth: 'medium' },
      writing: { tone: 'creative', energy: 'high', warmth: 'medium' },
    },
  },
}));

const { buildGiaSystem } = await import('../buildGiaSystem');

describe('buildGiaSystem', () => {
  beforeEach(() => {
    mockGetState = {};
    vi.clearAllMocks();
  });

  it('returns a string', () => {
    const result = buildGiaSystem();
    expect(typeof result).toBe('string');
  });

  it('contains GIA name in the prompt', () => {
    const result = buildGiaSystem();
    expect(result).toContain('GIA');
  });

  it('sends the master-builder brief in BUILD mode', () => {
    mockGetState.gia = {
      ...mockGiaState,
      sharedData: { currentMode: 'build' },
      theme: 'dark',
      buildStyleId: 'obsidian',
    };
    const result = buildGiaSystem();
    expect(result).toContain('## Current mode: BUILD');
    expect(result).toContain('you are the master builder');
    expect(result).toContain('It **runs**');
  });

  it('tells the model to work inside the active session worktree', () => {
    // The anti-theater check. A per-session worktree that never reaches the
    // prompt means GIA still edits the main checkout while the sidebar shows a
    // reassuring branch name — the exact collision isolation was meant to stop.
    mockGetState.gia = {
      ...mockGiaState,
      sessions: [{
        id: 's1', title: 'Fix login', messages: [], createdAt: 1, updatedAt: 1, currentBranchId: 'b1',
        worktree: { path: '/repo/.gia/worktrees/fix-login-abcd', branch: 'gia/fix-login-abcd', repoRoot: '/repo' },
      }],
      activeSessionId: 's1',
    };
    const result = buildGiaSystem();
    expect(result).toContain('/repo/.gia/worktrees/fix-login-abcd');
    expect(result).toContain('gia/fix-login-abcd');
  });

  it('says nothing about worktrees when the session is not isolated', () => {
    mockGetState.gia = {
      ...mockGiaState,
      sessions: [{ id: 's1', title: 'Fix login', messages: [], createdAt: 1, updatedAt: 1, currentBranchId: 'b1' }],
      activeSessionId: 's1',
    };
    expect(buildGiaSystem()).not.toContain('.gia/worktrees');
  });

  it('ignores a worktree belonging to a different session', () => {
    mockGetState.gia = {
      ...mockGiaState,
      sessions: [
        { id: 's1', title: 'a', messages: [], createdAt: 1, updatedAt: 1, currentBranchId: 'b1' },
        { id: 's2', title: 'b', messages: [], createdAt: 1, updatedAt: 1, currentBranchId: 'b1',
          worktree: { path: '/repo/.gia/worktrees/other', branch: 'gia/other', repoRoot: '/repo' } },
      ],
      activeSessionId: 's1',
    };
    expect(buildGiaSystem()).not.toContain('.gia/worktrees');
  });

  it('includes tool table with web_search', () => {
    const result = buildGiaSystem();
    expect(result).toContain('web_search');
    expect(result).toContain('terminal_run');
  });

  it('includes user name when provided', () => {
    mockGetState.gia = {
      ...mockGiaState,
      userProfile: { name: 'Alice', bio: 'Developer', goals: 'Build great things' },
    };
    const result = buildGiaSystem();
    expect(result).toContain('Alice');
    expect(result).toContain('Developer');
    expect(result).toContain('Build great things');
  });

  it('includes memory context when provided', () => {
    mockGetState.memory = {
      ...mockMemoryState,
      memories: [{ id: 'mem-1', key: 'user_name', value: 'Alice', category: 'profile', tier: 'core', confidence: 0.9, createdAt: 0, updatedAt: 0 }],
      getRelevantContext: vi.fn(() => '\n\n## What GIA remembers:\n- user_name: Alice\n'),
    };
    const result = buildGiaSystem();
    expect(result).toContain('What GIA remembers');
  });

  it('includes custom instructions when set', () => {
    mockGetState.gia = {
      ...mockGiaState,
      userProfile: { name: 'Alice', bio: '', goals: '' },
      customInstructions: 'Always respond in French.',
    };
    const result = buildGiaSystem('test');
    expect(result).toContain('French');
  });

  it('includes active skill section', () => {
    mockGetState.gia = {
      ...mockGiaState,
      activeSkillId: 'skill-1',
      skills: [{ id: 'skill-1', name: 'Coding', description: 'Help with code', systemPrompt: 'Focus on best practices.' }],
    };
    const result = buildGiaSystem();
    expect(result).toContain('Coding');
    expect(result).toContain('best practices');
  });

  it('uses "the user" when no name is provided', () => {
    const result = buildGiaSystem();
    expect(result).toContain('the user');
  });

  it('includes provider and model info', () => {
    const result = buildGiaSystem();
    expect(result).toContain('OPENAI');
    expect(result).toContain('gpt-4o');
  });

  it('includes language detection instruction', () => {
    const result = buildGiaSystem();
    expect(result).toContain('Detect the language');
    expect(result).toContain('ALWAYS respond in the same language');
  });

  it('applies custom GIA name from identity', () => {
    mockGetState.identity = {
      identity: { ...mockIdentityState.identity, name: 'Zara' },
    };
    const result = buildGiaSystem();
    expect(result).toContain('calls you Zara');
  });

  it('shows no-tool-support section when model lacks tools', () => {
    mockGetState.provider = {
      activeProvider: 'openai',
      providers: { openai: { enabled: true, apiKey: 'sk-test', model: 'gpt-3.5-turbo' } },
      availableModels: {
        openai: [
          { id: 'gpt-3.5-turbo', label: 'GPT-3.5', free: false, tools: false, vision: false, context: { length: 16000 } },
        ],
      },
    };
    const result = buildGiaSystem();
    expect(result).toContain('Limited tool support');
    expect(result).not.toContain('## Tools you can use');
  });

  it('includes collapsible sections info', () => {
    const result = buildGiaSystem();
    expect(result).toContain('<details>');
    expect(result).toContain('<summary>');
  });

  it('includes mermaid diagram info', () => {
    const result = buildGiaSystem();
    expect(result).toContain('mermaid');
  });

  it('includes katex math info', () => {
    const result = buildGiaSystem();
    expect(result).toContain('KaTeX');
  });

  it('includes truthfulness section', () => {
    const result = buildGiaSystem();
    expect(result).toContain('Never fabricate');
  });

  it('includes suggestion block format', () => {
    const result = buildGiaSystem();
    expect(result).toContain('```suggestions');
  });
});

/**
 * W10 — V2 clarity audit fixes: contradictions resolved, stale facts
 * corrected, and the prompt length governor. The banned-phrase checks are the
 * regression locks for the contradictions the audit found; the governor tests
 * pin the trim order (hand table first, examples second) and the guarantee
 * that a large-context model gets the ungoverned prompt unchanged.
 */
describe('W10 clarity: contradictions and stale facts', () => {
  it('no longer claims to be completely unrestricted (vs the PERMISSION DENIED doctrine)', () => {
    const result = buildGiaSystem();
    expect(result).not.toContain('completely unrestricted');
    expect(result).toContain('never bypassing the permission gate');
  });

  it('scopes the catalog rule to the advertised set instead of "ONLY from the table below"', () => {
    const result = buildGiaSystem();
    expect(result).not.toContain('Use ONLY tool IDs from the table below');
    expect(result).toContain('Call ONLY tool IDs that were advertised to you');
    expect(result).toContain('anything tool_search returned');
  });

  it('teaches that visual/artifact/suggestion/mermaid fences are NOT tool calls', () => {
    const result = buildGiaSystem();
    expect(result).toContain('Fence types are not interchangeable');
    expect(result).toContain('they are NEVER tool calls');
  });

  it('quotes the terminal_run schema (host shell, sh/python/js/cpp, workdir, timeout)', () => {
    const result = buildGiaSystem();
    expect(result).toContain('real host shell on GIA Desktop');
    expect(result).toContain('`workdir`?');
    expect(result).toContain('`timeout`?');
    expect(result).toContain('sh (default) / python / js / cpp');
  });

  it('has no filesystem_list phantom and no "Mobile only" lie on desktop-capable rows', () => {
    const result = buildGiaSystem();
    expect(result).not.toContain('filesystem_list');
    expect(result).toContain('`list_files`');
  });

  it('first contact uses capabilities_scan, not the music-library media_access tool', () => {
    const result = buildGiaSystem();
    expect(result).not.toContain('media_access');
    expect(result).toContain('`capabilities_scan` — inventory what is installed');
  });

  it('gates the first-contact diagnostic off in ASK mode', () => {
    const result = buildGiaSystem();
    expect(result).toContain('current mode is NOT ask');
  });

  it('scopes the base lead-with-the-answer rule to the EXAM tutor rule', () => {
    const result = buildGiaSystem();
    expect(result).toContain('Sole exception: in EXAM mode');
    expect(result).toContain('never give the final answer first');
  });

  it('EXAM mode delivers the tutor prompt, not the answer-key style', () => {
    mockGetState.gia = { ...mockGiaState, sharedData: { currentMode: 'exam' } };
    const result = buildGiaSystem();
    expect(result).toContain('## Current mode: EXAM');
    expect(result).toContain('Never give the final answer first');
  });

  it('teaches sub_agent_call as a virtual tool with its real arg shape', () => {
    const result = buildGiaSystem();
    expect(result).toContain('`sub_agent_call` is a **virtual tool**');
    expect(result).toContain('`provider` (required — provider name');
    expect(result).toContain('"provider": "openai"');
  });

  it('states the fixed skills-vs-modes precedence instead of "skills override mode restrictions"', () => {
    const result = buildGiaSystem();
    expect(result).not.toContain('Skills override mode restrictions');
    expect(result).toContain('**Skills vs modes — fixed precedence.**');
    expect(result).toContain('never overridable');
  });

  it('scopes the search-by-default and install philosophies out of ASK and PLAN modes', () => {
    const result = buildGiaSystem();
    expect(result).toContain('(None of this applies in ASK mode');
    expect(result).toContain('(In PLAN mode this does not apply');
  });

  it('describes the deferred block: fenced-block-only for native providers, read schemas first', () => {
    const result = buildGiaSystem();
    expect(result).toContain('invoked ONLY through a ```tool fenced block');
    expect(result).toContain('BEFORE calling an unfamiliar tool id');
  });
});

describe('W10 clarity: prompt length governor', () => {
  it('keeps the hand-written table when the context window is large', () => {
    const result = buildGiaSystem();
    expect(result).toContain('| `web_search` | Search the web');
    expect(result).toContain('## Tool calling examples');
    expect(result).not.toContain('Prompt budget notice');
  });

  it('drops the hand table first, then the examples, and says so, on a small window', () => {
    mockGetState.provider = {
      activeProvider: 'openai',
      providers: { openai: { enabled: true, apiKey: 'sk-test', model: 'gpt-4o' } },
      availableModels: {
        openai: [
          { id: 'gpt-4o', label: 'GPT-4o', free: false, tools: true, vision: true, context: '8000' },
        ],
      },
    };
    const result = buildGiaSystem();
    // The deferred compact index (or its header) still tells the model where
    // the full catalog lives.
    expect(result).toContain('Deferred tool catalog');
    // Probe with the hand table's HEADER, not a row. The compact index
    // legitimately still lists web_search — its row starts with the same
    // "| `web_search` | Search the web" prefix — so a row probe matches even
    // after the hand table is dropped. "Args | Notes" is the hand table's
    // unique column layout; the compact index ends in "Category".
    expect(result).not.toContain('| Tool | What it does | Args | Notes |');
    expect(result).not.toContain('## Tool calling examples');
    expect(result).toContain('Prompt budget notice');
    expect(result).toContain('the hand-written tool table');
    expect(result).toContain('the tool-calling examples');
    // The desktop execution paragraph must survive trimming — it is not
    // inside the examples block. It lives behind isTauri(), so arm the flag
    // the way the desktop app runs (mirrors PresenterMode.test.ts) and clean
    // it up so other tests still see the web branch.
    const win = window as unknown as Record<string, unknown>;
    win.__TAURI_INTERNALS__ = {};
    try {
      expect(buildGiaSystem()).toContain('real shell on this computer');
    } finally {
      delete win.__TAURI_INTERNALS__;
    }
  });

  it('trims the examples before the table — the boundary pins the order', () => {
    // Find the smallest context window at which the hand table still fits,
    // then build exactly there. At that boundary the table fits by
    // definition, so if the examples are trimmed it can only be because the
    // governor drops the LOWER-priority section first.
    mockGetState.gia = { ...mockGiaState };
    // Probe with the hand table's HEADER: the deferred compact index lists
    // web_search too, so a row probe reports "table present" even when the
    // table was dropped and the binary search never converges on the real
    // boundary. "Args | Notes" exists only when the hand table is emitted.
    const TABLE_HEADER = '| Tool | What it does | Args | Notes |';
    const setContext = (ctxLength: number) => {
      mockGetState.provider = {
        activeProvider: 'openai',
        providers: { openai: { enabled: true, apiKey: 'sk-test', model: 'gpt-4o' } },
        availableModels: {
          openai: [
            { id: 'gpt-4o', label: 'GPT-4o', free: false, tools: true, vision: true, context: String(ctxLength) },
          ],
        },
      };
    };
    const tablePresent = (ctxLength: number) => {
      setContext(ctxLength);
      return buildGiaSystem().includes(TABLE_HEADER);
    };
    let lo = 1000;
    let hi = 300000;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (tablePresent(mid)) hi = mid; else lo = mid;
    }
    // Rebuild exactly at the converged boundary. The loop's last probe is
    // `lo` — the largest window where the table is ALREADY dropped — so
    // building on the leftover provider state would assert the trimmed side
    // of the boundary, not the boundary itself.
    setContext(hi);
    const result = buildGiaSystem();
    expect(result).toContain(TABLE_HEADER);
    expect(result).toContain('Prompt budget notice');
    expect(result).toContain('the tool-calling examples');
    // The table itself was NOT on the trimmed list at this boundary.
    expect(result).not.toContain('the hand-written tool table — the deferred compact index');
  });
});
