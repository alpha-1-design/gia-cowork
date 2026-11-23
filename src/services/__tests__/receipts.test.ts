import { describe, it, expect, vi } from 'vitest';
import { buildReceipt, renderReceiptHtml, fileChangesForRange, RECEIPT_VERIFIER_JS, type ReceiptSession } from '../receipts';
import { rolloutVerify } from '../brain/rollout';
import type { FileSnapshot } from '../FileSnapshots';

/**
 * Task receipts — the proof-page contract:
 *  - every card number derives from the real records handed in;
 *  - the embedded rollout survives HTML embedding EXACTLY (a corrupted
 *    record would make the page's own verifier lie, which is the one
 *    failure this feature must never have);
 *  - the page is self-contained: no CDN, no remote font, no network.
 */

const snap = (over: Partial<FileSnapshot>): FileSnapshot => ({
  id: over.id ?? `s${over.seq ?? 0}`,
  path: over.path ?? 'a.ts',
  previousContent: over.previousContent ?? null,
  newContent: over.newContent ?? 'x',
  timestamp: over.timestamp ?? 1000,
  seq: over.seq ?? 0,
  source: 'filesystem_write',
  reverted: over.reverted ?? false,
});

const session: ReceiptSession = {
  id: 'sess-rcpt-1',
  title: 'Session',
  messages: [
    { id: 'm1', role: 'user', content: 'Fix the failing login test\ntwo', timestamp: 5000 },
    {
      id: 'm2', role: 'assistant', content: 'done', timestamp: 6000,
      segments: [
        { id: 't1', type: 'tool', toolName: 'filesystem_write', content: '🧠 filesystem_write → tests/login.test.ts\n⚡ Executing\n✅ Wrote 10 lines', toolStatus: 'done' },
        { id: 't2', type: 'tool', toolName: 'terminal_run', content: '🧠 terminal_run → npm test\n⚡ Executing\n❌ 1 test failed', toolStatus: 'done' },
      ],
    },
  ],
};

describe('buildReceipt', () => {
  const { receipt, rolloutJsonl } = buildReceipt(session, {
    snapshots: [
      snap({ seq: 1, path: 'tests/login.test.ts', previousContent: 'a\nb', newContent: 'a\nb\nc\nd', timestamp: 5100 }),
      snap({ seq: 2, path: 'src/other.ts', newContent: 'x', timestamp: 99_000 }), // outside span → excluded
    ],
    costUsd: 0.0123,
    audit: [{ toolName: 'filesystem_write', risk: 'low', choice: 'once', headline: 'Overwrites tests/login.test.ts.', at: 5050 }],
  });

  it('extracts tool calls with outcomes from the record', () => {
    expect(receipt.toolCalls).toHaveLength(2);
    expect(receipt.toolCalls[0]).toMatchObject({ tool: 'filesystem_write', outcome: 'ok' });
    expect(receipt.toolCalls[1]).toMatchObject({ tool: 'terminal_run', outcome: 'fail' });
  });

  it('counts only file changes inside the session span', () => {
    expect(receipt.fileChanges).toHaveLength(1);
    expect(receipt.fileChanges[0]).toMatchObject({ path: 'tests/login.test.ts', additions: 2, deletions: 0, created: false });
  });

  it('carries gate decisions and cost from the records given', () => {
    expect(receipt.gateDecisions[0]?.headline).toContain('Overwrites tests/login.test.ts');
    expect(receipt.costUsd).toBeCloseTo(0.0123);
  });

  it('titles from the first user ask, first line only', () => {
    expect(receipt.title).toBe('Fix the failing login test');
  });

  it('the embedded record is chain-verified', () => {
    expect(receipt.verification).toEqual({ verified: true, brokenAt: null, unchained: false });
    expect(rolloutVerify(rolloutJsonl).verified).toBe(true);
  });
});

describe('fileChangesForRange', () => {
  it('marks created files and reverts honestly', () => {
    const out = fileChangesForRange([
      snap({ seq: 1, path: 'new.ts', previousContent: null, newContent: 'one', timestamp: 100 }),
      snap({ seq: 2, path: 'new.ts', previousContent: 'one', newContent: 'one\ntwo', timestamp: 200, reverted: true }),
    ], 90, 210);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ created: true, additions: 1 });
    expect(out[1]).toMatchObject({ reverted: true });
  });
});

describe('renderReceiptHtml', () => {
  const generatedAt = 7_000;
  const { receipt, rolloutJsonl } = buildReceipt(session, {
    snapshots: [snap({ seq: 1, path: 'tests/login.test.ts', previousContent: 'a\nb', newContent: 'a\nb\nc\nd', timestamp: 5100 })],
    costUsd: 0.0123,
    audit: [],
  });
  const html = renderReceiptHtml({ ...receipt, generatedAt }, rolloutJsonl, generatedAt);

  it('is self-contained: no CDN, no remote URLs beyond the title', () => {
    expect(html).not.toMatch(/https?:\/\/(?!dashboard)/);
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('escapes the record for script embedding — and the extracted record still verifies', () => {
    const marker = '<script type="application/json" id="rollout-data">';
    const start = html.indexOf(marker) + marker.length;
    const end = html.indexOf('</script>', start);
    const embedded = html.slice(start, end).replace(/\\u003c/g, '<');
    // Embedding must be lossless: the page's own verifier runs on exactly this.
    expect(rolloutVerify(embedded).verified).toBe(true);
    expect(embedded).toBe(rolloutJsonl);
  });

  it('never lets message content inject HTML', () => {
    const evil: ReceiptSession = {
      id: 'sess-evil',
      title: 'x',
      messages: [{ id: 'm1', role: 'user', content: '<script>alert(1)</script>', timestamp: 1000 }],
    };
    const evilBuilt = buildReceipt(evil, { snapshots: [], costUsd: 0, audit: [] });
    const evilHtml = renderReceiptHtml({ ...evilBuilt.receipt, generatedAt }, evilBuilt.rolloutJsonl, 1000);
    expect(evilHtml).not.toContain('<script>alert(1)</script>');
    expect(evilHtml).toContain('&lt;script&gt;');
  });

  it('the SHIPPED verifier (executed, not reimplemented) verifies the real record', () => {
    const el = { textContent: rolloutJsonl };
    const stub = { getElementById: (id: string) => (id === 'rollout-data' ? el : { textContent: '', className: '' }) } as unknown as Document;
    const globalDoc = globalThis as { document?: Document };
    const prevDoc = globalDoc.document;
    globalDoc.document = stub;
    try {
      const fn = new Function(RECEIPT_VERIFIER_JS + '; return typeof verifyRollout === "function" ? verifyRollout() : null;') as () => { verified: boolean; brokenAt: number | null };
      expect(fn()).toEqual({ verified: true, brokenAt: null });
    } finally {
      if (prevDoc === undefined) delete globalDoc.document; else globalDoc.document = prevDoc;
    }
  });

  it('the SHIPPED verifier catches tampering (edited content breaks the chain)', () => {
    const lines = rolloutJsonl.split('\n');
    const victim = JSON.parse(lines[2]) as { content: string; h: string; [k: string]: unknown };
    victim.content = victim.content + ' TAMPERED';
    lines[2] = JSON.stringify(victim);
    const el = { textContent: lines.join('\n') };
    const stub = { getElementById: (id: string) => (id === 'rollout-data' ? el : { textContent: '', className: '' }) } as unknown as Document;
    const globalDoc = globalThis as { document?: Document };
    const prevDoc = globalDoc.document;
    globalDoc.document = stub;
    try {
      const fn = new Function(RECEIPT_VERIFIER_JS + '; return verifyRollout();') as () => { verified: boolean; brokenAt: number | null };
      const res = fn();
      expect(res.verified).toBe(false);
      expect(res.brokenAt).toBe(3);
    } finally {
      if (prevDoc === undefined) delete globalDoc.document; else globalDoc.document = prevDoc;
    }
    // And the canonical verifier agrees on the same tampered file.
    expect(rolloutVerify(lines.join('\n')).brokenAt).toBe(3);
  });

  it('embeds the verifier that recomputes the same chain constants', () => {
    expect(html).toContain('0x811c9dc5');       // FNV offset basis
    expect(html).toContain('0x01000193');       // FNV prime
    expect(html).toContain("'|rollout'");       // chain domain separation
    expect(html).toContain('id="verify-badge"');
  });
});
