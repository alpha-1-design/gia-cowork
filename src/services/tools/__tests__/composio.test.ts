import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * composio_search / composio_execute — the agent-facing connector rail.
 * The tools are thin adapters over ComposioService; these tests pin the
 * contract the model actually sees: honest errors, slug discovery, and the
 * result envelope translated into ToolResult.
 */

vi.mock('../../../services/CredentialVault', () => ({
  default: {
    get: vi.fn(async () => 'cpk_test'),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('../../../platform', () => ({ isTauri: () => false }));

const service = vi.hoisted(() => ({
  searchTools: vi.fn(),
  executeTool: vi.fn(),
}));
vi.mock('../../composio/ComposioService', () => ({
  default: service,
  composioService: service,
}));

import { composioTools } from '../composio';

const search = composioTools[0]!;
const exec = composioTools[1]!;

beforeEach(() => {
  service.searchTools.mockReset();
  service.executeTool.mockReset();
});

describe('composio_search', () => {
  it('finds actions by use case and returns slugs with guidance', async () => {
    service.searchTools.mockResolvedValueOnce([
      { slug: 'SLACK_SEND_MESSAGE', description: 'Send a message to a channel', toolkit: 'slack' },
    ]);
    const res = await search.execute({ use_case: 'post to slack' });
    expect(res.success).toBe(true);
    expect(res.content).toContain('SLACK_SEND_MESSAGE');
    expect(res.content).toContain('composio_execute');
    expect(service.searchTools).toHaveBeenCalledWith('post to slack', 5);
  });

  it('empty results point at the connect step, not a dead end', async () => {
    service.searchTools.mockResolvedValueOnce([]);
    const res = await search.execute({ use_case: 'book a flight' });
    expect(res.success).toBe(true);
    expect(res.content).toContain('may not be connected');
  });

  it('service errors surface as ToolResult errors', async () => {
    service.searchTools.mockRejectedValueOnce(new Error('Composio 401: Invalid API key'));
    const res = await search.execute({ use_case: 'x' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('401');
  });
});

describe('composio_execute', () => {
  it('executes by slug and returns the action payload as content', async () => {
    service.executeTool.mockResolvedValueOnce({ ok: true, data: { issue_url: 'https://github.com/x/issues/1' }, logId: 'log_1' });
    const res = await exec.execute({ tool_slug: 'GITHUB_CREATE_AN_ISSUE', arguments: { title: 'hi' } });
    expect(res.success).toBe(true);
    expect(res.content).toContain('issue_url');
    expect(service.executeTool).toHaveBeenCalledWith('GITHUB_CREATE_AN_ISSUE', { title: 'hi' });
  });

  it('failed executions carry the action error, not a fake success', async () => {
    service.executeTool.mockResolvedValueOnce({ ok: false, error: 'Missing required argument: repo', logId: 'log_2' });
    const res = await exec.execute({ tool_slug: 'GITHUB_CREATE_AN_ISSUE', arguments: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain('repo');
  });

  it('oversized payloads truncate with the log id attached', async () => {
    service.executeTool.mockResolvedValueOnce({ ok: true, data: { blob: 'x'.repeat(20000) }, logId: 'log_3' });
    const res = await exec.execute({ tool_slug: 'X_BIG', arguments: {} });
    expect(res.success).toBe(true);
    expect(res.content.length).toBeLessThan(9000);
    expect(res.content).toContain('log_3');
  });
});
