import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerAllTools } from '../tools';
import { getAllToolSchemas, buildOpenAITools, buildAnthropicTools, validateToolArgs } from '../brain/toolSchemas';
import { peerAgentTools } from '../tools/peerAgents';
import { setShell, type ShellResult } from '../agents/peerAgents';

/**
 * The failure this guards is subtle and total: a tool can be defined, unit
 * tested, and registered — and still never reach the model.
 *
 * The provider tool lists are built from `toolSchemas` merged with the
 * ToolRegistry, so "it exists" and "the model can see it" are different claims.
 * If this drifts, the delegation feature passes every test it has while being
 * completely unreachable, and the only symptom is GIA quietly doing the work
 * itself with no explanation.
 */

const NEW_TOOLS = ['list_peer_agents', 'delegate_to_agent'];

const shell = vi.fn(async (_cmd: string): Promise<ShellResult> => ({ output: '', exitCode: 1 }));

beforeEach(() => {
  registerAllTools();
  // Reset, not clear: `mockClear` leaves implementations in place, so a test
  // that faked an installed agent would leak into the next one.
  shell.mockReset();
  shell.mockImplementation(async (_cmd: string): Promise<ShellResult> => ({ output: '', exitCode: 1 }));
  setShell(shell);
});

describe('peer agent tools reach the model', () => {
  it('registers both tools', () => {
    expect(peerAgentTools.map(t => t.id)).toEqual(NEW_TOOLS);
  });

  it('appears in the merged schema set the providers build from', () => {
    const schemas = getAllToolSchemas();
    for (const id of NEW_TOOLS) {
      expect(schemas[id], `${id} missing from getAllToolSchemas`).toBeTruthy();
      expect(schemas[id].description.length).toBeGreaterThan(20);
    }
  });

  it('is advertised to OpenAI-compatible providers', () => {
    const names = buildOpenAITools().map(t => (t.function as { name: string }).name);
    for (const id of NEW_TOOLS) expect(names).toContain(id);
  });

  it('is advertised to Anthropic-compatible providers', () => {
    const names = buildAnthropicTools().map(t => (t as { name: string }).name);
    for (const id of NEW_TOOLS) expect(names).toContain(id);
  });

  it('carries required arguments through to validation', () => {
    // `validateToolArgs` runs on every tool call in toolRunner, so a missing
    // schema entry here means bad calls fail deep inside execution instead of
    // being caught with a clear message.
    expect(validateToolArgs('delegate_to_agent', { agent: 'claude', prompt: 'x' })).toBeNull();
    expect(validateToolArgs('delegate_to_agent', { agent: 'claude' })).toMatch(/Missing required/);
    expect(validateToolArgs('delegate_to_agent', { agent: 5, prompt: 'x' })).toMatch(/Invalid type/);
  });

  it('does not require arguments on the read-only detector', () => {
    expect(validateToolArgs('list_peer_agents', {})).toBeNull();
  });
});

describe('delegate_to_agent behaviour', () => {
  const tool = () => peerAgentTools.find(t => t.id === 'delegate_to_agent')!;

  it('refuses an agent id that is not in the catalog', async () => {
    const res = await tool().execute({ agent: 'rm', prompt: 'do it' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Unknown agent/);
  });

  it('refuses to run when the agent is not installed, instead of surfacing a shell error', async () => {
    shell.mockImplementation(async () => ({ output: '', exitCode: 1 }));
    const res = await tool().execute({ agent: 'claude', prompt: 'do it' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not installed/);
  });

  it('reports an honest failure when the agent exits non-zero', async () => {
    shell.mockImplementation(async (cmd: string) =>
      cmd.includes('command -v') ? { output: '/usr/bin/claude', exitCode: 0 }
        : { output: 'error: auth required', exitCode: 1 });
    const res = await tool().execute({ agent: 'claude', prompt: 'do it' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/exited 1/);
    expect(res.content).toContain('auth required');
  });

  it('returns the agent output on success', async () => {
    shell.mockImplementation(async (cmd: string) =>
      cmd.includes('command -v') ? { output: '/usr/bin/claude', exitCode: 0 }
        : { output: 'refactored 4 files', exitCode: 0 });
    const res = await tool().execute({ agent: 'claude', prompt: 'refactor' });
    expect(res.success).toBe(true);
    expect(res.content).toContain('refactored 4 files');
  });

  it('lists nothing installed rather than inventing agents', async () => {
    const list = peerAgentTools.find(t => t.id === 'list_peer_agents')!;
    const res = await list.execute({});
    expect(res.success).toBe(true);
    expect(res.content).toMatch(/No peer agents are installed/);
  });
});