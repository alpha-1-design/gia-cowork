import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock all external dependencies
const deductTokens = vi.fn();
const setProviderModel = vi.fn();

vi.mock('../../store/useProviderStore', () => ({
  useProviderStore: {
    getState: vi.fn(() => ({
      providers: { openai: { apiKey: 'sk-test', model: 'gpt-4o', enabled: true } },
      activeProvider: 'openai',
      // W11: generate() compacts against the active model's real window —
      // compaction.ts reads availableModels[provider] off this store, so the
      // mock must carry the field (empty = fallback window, which is fine).
      availableModels: {},
      deductTokens,
      setProviderModel,
    })),
  },
}));

vi.mock('../../store/useGiaStore', () => ({
  useGiaStore: {
    getState: vi.fn(() => ({
      responseCache: false,
      addNotification: vi.fn(),
    })),
  },
}));

vi.mock('../ProviderService', () => ({
  default: {
    callProvider: vi.fn(),
  },
}));

vi.mock('../ToolExecutionService', () => ({
  default: {
    execute: vi.fn(),
  },
}));

vi.mock('../ErrorHandlingService', () => ({
  default: {
    handleErrors: vi.fn(),
  },
}));

vi.mock('../brain/modelUtils', () => ({
  selectBestModel: vi.fn(() => ({ model: 'gpt-4o', reason: null, switched: false })),
  buildMessages: vi.fn(() => []),
}));

vi.mock('../brain/memoryExtractor', () => ({
  extractMemories: vi.fn(async () => {}),
}));

vi.mock('../PluginManager', () => ({
  default: {
    runBeforeGenerate: vi.fn(async (p: string) => p),
    runAfterGenerate: vi.fn(async (r: { text: string; provider: string; model: string }) => r),
  },
}));

vi.mock('../AnalyticsTracker', () => ({
  default: {
    trackGenerationComplete: vi.fn(),
  },
}));

vi.mock('../ResponseCache', () => ({
  default: {
    get: vi.fn(() => null),
    set: vi.fn(),
  },
}));

vi.mock('../CollaborativeGenerationService', () => ({
  default: {
    generate: vi.fn(),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { default: ProviderService } = await import('../ProviderService');
const { default: ToolExecutionService } = await import('../ToolExecutionService');

// Import after mocks
const { default: GiaBrain } = await import('../GiaBrain');

describe('GiaBrain (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a singleton instance', () => {
    expect(GiaBrain).toBeDefined();
    expect(GiaBrain.generate).toBeInstanceOf(Function);
    expect(GiaBrain.generateCollaborative).toBeInstanceOf(Function);
  });

  it('returns text from provider when no tool execution', async () => {
    vi.mocked(ProviderService.callProvider).mockResolvedValueOnce({
      text: 'Hello from AI',
      provider: 'openai',
      model: 'gpt-4o',
    });
    vi.mocked(ToolExecutionService.execute).mockResolvedValueOnce({
      didExecute: false,
      result: undefined,
    });

    const result = await GiaBrain.generate({ prompt: 'Say hi' });
    expect(result.text).toBe('Hello from AI');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o');
  });

  it('passes onStream to provider call and returns final text', async () => {
    vi.mocked(ProviderService.callProvider).mockResolvedValueOnce({
      text: 'Streamed result',
      provider: 'openai',
      model: 'gpt-4o',
    });
    vi.mocked(ToolExecutionService.execute).mockResolvedValueOnce({
      didExecute: false,
      result: undefined,
    });

    const onStream = vi.fn();
    const result = await GiaBrain.generate({ prompt: 'Stream test', onStream });
    expect(result.text).toBe('Streamed result');
  });

  it('executes tool loop and feeds observations back', async () => {
    const callProvider = vi.mocked(ProviderService.callProvider);
    const executeTool = vi.mocked(ToolExecutionService.execute);

    // First iteration — model responds with a tool call
    callProvider.mockResolvedValueOnce({
      text: 'I will use a tool',
      provider: 'openai',
      model: 'gpt-4o',
    });
    executeTool.mockResolvedValueOnce({
      didExecute: true,
      result: undefined,
    });

    // Second iteration — model responds with final answer
    callProvider.mockResolvedValueOnce({
      text: 'Final answer after tool',
      provider: 'openai',
      model: 'gpt-4o',
    });
    executeTool.mockResolvedValueOnce({
      didExecute: false,
      result: undefined,
    });

    const result = await GiaBrain.generate({ prompt: 'Use a tool' });
    expect(result.text).toBe('Final answer after tool');
    expect(callProvider).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it('announces every parsed tool-call format, not just quoted-id ```tool fences (S2-4)', async () => {
    const callProvider = vi.mocked(ProviderService.callProvider);
    const executeTool = vi.mocked(ToolExecutionService.execute);

    // One text exercising every parser format the old regex missed:
    // an unquoted-id fence (bare tool name + line args), a ```json fence, and an XML tag.
    const text = [
      '```tool\n{"id": "web_search", "args": {"query": "a"}}\n```',
      '```tool\nfilesystem_read\npath: "x"\n```',
      '```json\n{"tool": "list_files", "args": {}}\n```',
      '<tool_call>\n{"id": "read_url", "args": {"url": "https://x"}}\n</tool_call>',
    ].join('\n\n');
    callProvider.mockResolvedValueOnce({ text, provider: 'openai', model: 'gpt-4o' });
    executeTool.mockResolvedValueOnce({ didExecute: true, result: undefined });
    callProvider.mockResolvedValueOnce({ text: 'done', provider: 'openai', model: 'gpt-4o' });
    executeTool.mockResolvedValueOnce({ didExecute: false, result: undefined });

    const onThought = vi.fn();
    await GiaBrain.generate({ prompt: 'Use tools', onThought });

    // Every parsed id was announced BEFORE ToolExecutionService.execute —
    // the contract SwarmCoordinator's allow-list enforcement listens for.
    for (const id of ['web_search', 'filesystem_read', 'list_files', 'read_url']) {
      expect(onThought).toHaveBeenCalledWith(`⚙️ Executing ${id}...`);
    }
    expect(executeTool).toHaveBeenCalled();
  });

  it('throws when max iterations reached', async () => {
    vi.mocked(ProviderService.callProvider).mockResolvedValue({
      text: 'tool use',
      provider: 'openai',
      model: 'gpt-4o',
    });
    vi.mocked(ToolExecutionService.execute).mockResolvedValue({
      didExecute: true,
      result: undefined,
    });

    await expect(GiaBrain.generate({ prompt: 'Loop' })).rejects.toThrow('Max agentic iterations reached');
  });

  it('returns clarification signal', async () => {
    vi.mocked(ProviderService.callProvider).mockResolvedValueOnce({
      text: 'clarify?',
      provider: 'openai',
      model: 'gpt-4o',
    });
    vi.mocked(ToolExecutionService.execute).mockResolvedValueOnce({
      didExecute: true,
      result: '__CLARIFICATION__' as const,
    });

    const result = await GiaBrain.generate({ prompt: 'Vague prompt' });
    expect(result.text).toBe('__CLARIFICATION__');
  });

  it('retries on malformed JSON in tool block', async () => {
    const callProvider = vi.mocked(ProviderService.callProvider);
    const executeTool = vi.mocked(ToolExecutionService.execute);

    callProvider.mockResolvedValueOnce({
      text: 'bad json tool',
      provider: 'openai',
      model: 'gpt-4o',
    });
    executeTool.mockResolvedValueOnce({
      didExecute: true,
      result: 'malformed_json' as const,
    });

    callProvider.mockResolvedValueOnce({
      text: 'now fixed',
      provider: 'openai',
      model: 'gpt-4o',
    });
    executeTool.mockResolvedValueOnce({
      didExecute: false,
      result: undefined,
    });

    const result = await GiaBrain.generate({ prompt: 'Fix it' });
    expect(result.text).toBe('now fixed');
    expect(callProvider).toHaveBeenCalledTimes(2);
  });

  it('deducts tokens when usage provided', async () => {
    vi.mocked(ProviderService.callProvider).mockResolvedValueOnce({
      text: 'Done',
      provider: 'openai',
      model: 'gpt-4o',
      tokenUsage: { input: 50, output: 100, total: 150 },
    });
    vi.mocked(ToolExecutionService.execute).mockResolvedValueOnce({
      didExecute: false,
      result: undefined,
    });

    await GiaBrain.generate({ prompt: 'Count tokens' });
    expect(deductTokens).toHaveBeenCalledWith('openai', 150);
  });
});
