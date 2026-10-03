import { useTrustStore, type PermissionOutcome } from '../../store/useTrustStore';
import DesktopHostFS from '../DesktopHostFS';
import { isTauri } from '../../platform';
import { logger } from '../../utils/logger';

/**
 * The gate the tool runner actually calls.
 *
 * Its job is narrow: turn a tool call into a decision, and never let the tool
 * run unless the answer is yes. The interesting part is the read that happens
 * first — for a file write we fetch the current on-disk contents so the prompt
 * can show a real diff instead of asking you to trust a blob of JSON. That
 * read is safe, bounded, and best-effort: a failure here must degrade to "no
 * preview", never to "no permission check".
 */

/** Tool ids whose `path` argument names a file we can diff. */
const DIFFABLE_TOOLS = new Set(['filesystem_write', 'file_write', 'write_file']);

/** Never read more than this to build a preview. */
const MAX_READ_BYTES = 512 * 1024;

async function readCurrentContent(path: string): Promise<string | null | undefined> {
  if (!path || !isTauri()) return undefined;
  try {
    const content = await DesktopHostFS.readFile(path);
    if (content.length > MAX_READ_BYTES) {
      // Too big to diff usefully. Report "unknown" rather than reading a
      // partial file, which would render a diff of the wrong thing.
      return undefined;
    }
    return content;
  } catch (e) {
    // Almost always "file does not exist", which is a real and common case
    // for a create — the prompt labels it as a new file rather than a diff.
    logger.debug('[permissionGate] could not read current contents:', e);
    return null;
  }
}

export async function gateToolCall(
  toolId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<PermissionOutcome> {
  let beforeContent: string | null | undefined;
  if (DIFFABLE_TOOLS.has(toolId)) {
    beforeContent = await readCurrentContent(String(args.path ?? args.file ?? ''));
  }
  return useTrustStore.getState().checkTool(toolId, toolName, args, { beforeContent });
}
