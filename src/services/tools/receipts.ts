import { z } from 'zod';
import { defineTool } from './defineTool';
import { generateReceipt } from '../receipts';
import { useGiaStore } from '../../store/useGiaStore';
import type { Tool } from './types';

/**
 * receipt_generate — produce a shareable proof page for the current task.
 *
 * The receipt is a self-contained HTML file (rollout + tool calls + file
 * changes + gate decisions + spend) whose embedded record re-verifies its
 * own hash chain when opened in any browser, offline. Generation writes to
 * ~/gia-receipts on desktop; on web it returns the HTML for download.
 *
 * Gating: rides the normal tool gate (execution risk — asks first), like
 * every tool that produces an artifact outside the chat.
 */
export const receiptGenerate = defineTool({
  id: 'receipt_generate',
  name: 'receipt_generate',
  description:
    'Generate a verifiable task receipt — a self-contained HTML proof page for the current conversation: ' +
    'what was asked, which tools ran (with outcomes), which files changed, permission-gate decisions, and spend. ' +
    'The embedded rollout record re-verifies its tamper-evidence chain when the file is opened in any browser, offline.',
  category: 'testimony',
  input: z.object({
    session_id: z.string().optional().describe('Session to receipt (defaults to the active one)'),
  }),
  execute: async ({ session_id }) => {
    const store = useGiaStore.getState();
    const sessionId = session_id || store.activeSessionId;
    if (!sessionId) return { success: false, content: '', error: 'No active session to receipt.' };
    const session = store.sessions.find(s => s.id === sessionId);
    if (!session) return { success: false, content: '', error: `Session ${sessionId} not found.` };

    const { path, html } = await generateReceipt({ id: session.id, title: session.title, messages: session.messages });

    // Web (no host filesystem): hand the page back as a download.
    if (!path) {
      try {
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `receipt-${sessionId.slice(0, 12)}.html`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch {
        return { success: false, content: '', error: 'Could not produce the receipt download.' };
      }
      return { success: true, content: 'Task receipt generated — a download was started. Open the file in any browser to verify its record (works offline).' };
    }

    return {
      success: true,
      content: `Task receipt written to ${path}. Open it in any browser — the page re-verifies its own record offline.`,
    };
  },
});

export const receiptTools: Tool[] = [receiptGenerate];
