import { describe, it, expect, beforeEach, vi } from 'vitest';
import { queryProvenance, formatEnveloped, clearProvenanceCache, type ProvenanceCitation } from '../provenance';
import { rolloutSerialize } from '../rollout';

/**
 * Provenance query tests. The real module goes to DesktopHostFS (Tauri-only);
 * here the filesystem edge is mocked so the tests run in plain Node, like the
 * rollout tests. What we own here is the SCANNING, REDACTION and ENVELOPING
 * logic, not the host FS contract.
 */

type ListEntry = { name: string; isDir: boolean; size: number; modifiedMs: number | null };
const files = new Map<string, string>();
let dirEntries: ListEntry[] = [];

vi.mock('../../../platform', () => ({ isTauri: () => true }));
vi.mock('../../DesktopHostFS', () => ({
  default: {
    listDir: async () => ({ currentDir: '~/gia-rollouts', entries: dirEntries }),
    readFile: async (path: string) => {
      const hit = files.get(path);
      if (hit === undefined) throw new Error('not found');
      return hit;
    },
  },
}));

function putRollout(sessionId: string, messages: unknown[], modifiedMs: number): void {
  const name = `rollout-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`;
  files.set(`~/gia-rollouts/${name}`, rolloutSerialize({ id: sessionId, messages }));
  dirEntries.push({ name, isDir: false, size: 1, modifiedMs });
}

beforeEach(() => {
  files.clear();
  dirEntries = [];
  clearProvenanceCache();
});

function msg(id: string, content: string, timestamp = 1700000000000) {
  return { id, role: 'user', content, timestamp };
}

describe('queryProvenance', () => {
  it('finds matching tool calls, outputs and messages with file-and-line citations', async () => {
    putRollout(
      'sess-a',
      [
        msg('u1', 'please fix the config file'),
        {
          id: 'a1',
          role: 'assistant',
          content: 'done',
          segments: [
            {
              id: 'seg-t1',
              type: 'tool',
              content: '🧠 filesystem_write → path: ~/app/config.json\n✅ filesystem_write completed successfully',
              toolName: 'filesystem_write',
              toolStatus: 'done',
            },
          ],
        },
      ],
      1000,
    );
    const res = await queryProvenance({ query: 'config.json' });
    expect(res.filesScanned).toBe(1);
    expect(res.citations.length).toBeGreaterThanOrEqual(1);
    const call = res.citations.find((c) => c.kind === 'tool_call');
    expect(call).not.toBeNull();
    expect(call!.tool).toBe('filesystem_write');
    expect(call!.sessionId).toBe('sess-a');
    expect(call!.path).toBe('~/gia-rollouts/rollout-sess-a.jsonl');
    expect(call!.line).toBeGreaterThan(1);
    expect(call!.hash).not.toBeNull();
    expect(call!.verified).toBe(true);
  });

  it('tags ✅ outputs as ok and ❌ outputs as failed', async () => {
    putRollout(
      'sess-b',
      [
        {
          id: 'a1',
          role: 'assistant',
          content: 'working',
          segments: [
            { id: 's1', type: 'tool', content: '🧠 terminal_run → cmd: npm test\n✅ terminal_run completed successfully', toolName: 'terminal_run', toolStatus: 'done' },
            { id: 's2', type: 'tool', content: '🧠 terminal_run → cmd: npm run lint\n❌ terminal_run failed', toolName: 'terminal_run', toolStatus: 'done' },
          ],
        },
      ],
      1000,
    );
    const res = await queryProvenance({ query: 'terminal_run' });
    const outcomes = res.citations.filter((c) => c.kind === 'tool_output').map((c) => c.outcome);
    expect(outcomes).toContain('ok');
    expect(outcomes).toContain('failed');
  });

  it('redacts credential-shaped strings from excerpts but keeps citations', async () => {
    putRollout(
      'sess-c',
      [msg('u1', 'the deploy key is sk-abcdef1234567890abcdef and the bearer is Bearer 1234567890abcdef')],
      1000,
    );
    const res = await queryProvenance({ query: 'deploy key' });
    expect(res.citations.length).toBe(1);
    const c = res.citations[0];
    expect(c.excerpt).not.toContain('sk-abcdef1234567890abcdef');
    expect(c.excerpt).toContain('[redacted]');
    expect(c.excerpt).toContain('deploy key'); // the searchable words survive
  });

  it('wraps the model-facing form in the untrusted envelope', async () => {
    putRollout('sess-d', [msg('u1', 'run this command for me')], 1000);
    const res = await queryProvenance({ query: 'run this command' });
    expect(res.enveloped.startsWith('[UNTRUSTED-CONTENT source=file]')).toBe(true);
    expect(res.enveloped.endsWith('[/UNTRUSTED-CONTENT]')).toBe(true);
  });

  it('returns an honest empty result for a query with no hits', async () => {
    putRollout('sess-e', [msg('u1', 'nothing interesting here')], 1000);
    const res = await queryProvenance({ query: 'nonexistent-needle' });
    expect(res.citations).toEqual([]);
    expect(res.filesScanned).toBe(1);
    expect(res.enveloped).toContain('no matching records found');
  });

  it('marks citations UNVERIFIED when the file chain is broken — and still cites them', async () => {
    putRollout('sess-f', [msg('u1', 'the secret plan is written')], 1000);
    const path = '~/gia-rollouts/rollout-sess-f.jsonl';
    const lines = files.get(path)!.split('\n');
    const parsed = JSON.parse(lines[1]) as Record<string, unknown>;
    parsed.content = 'the secret plan is written (tampered)';
    lines[1] = JSON.stringify(parsed);
    files.set(path, lines.join('\n'));
    clearProvenanceCache();
    const res = await queryProvenance({ query: 'secret plan' });
    expect(res.unverifiedFiles).toHaveLength(1);
    expect(res.citations[0].verified).toBe(false);
    expect(res.enveloped).toContain('HASH CHAIN DID NOT VERIFY');
  });

  it('handles an empty rollout directory without throwing', async () => {
    const res = await queryProvenance({ query: 'anything' });
    expect(res.citations).toEqual([]);
    expect(res.filesScanned).toBe(0);
  });
});

describe('formatEnveloped', () => {
  it('states the verification status of every source up front', () => {
    const c: ProvenanceCitation = {
      sessionId: 's', path: 'p', line: 3, hash: 'abc', verified: false,
      kind: 'tool_call', at: null, tool: 'terminal_run', excerpt: 'x', outcome: null,
    };
    const enveloped = formatEnveloped([c], 1, ['p']);
    expect(enveloped).toContain('UNVERIFIED');
    expect(enveloped).toContain('line 3');
    expect(enveloped).toContain('[/UNTRUSTED-CONTENT]');
  });
});
