import { logger } from '../../utils/logger';
import { z } from 'zod';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { isNativePlatform } from '../../utils/helpers';
import { isTauri } from '../../platform';
import DesktopHostFS from '../DesktopHostFS';
import { fileSnapshots } from '../FileSnapshots';
import { isPathSafe, blobToBase64, triggerDownload, MAX_FILE_SIZE } from './helpers';
import { useGiaStore } from '../../store/useGiaStore';
import type { Tool, ToolContext } from './types';

const isNative = isNativePlatform;

const filesystemRead: Tool = {
  id: 'filesystem_read',
  name: 'filesystem_read',
  description: 'Read the content of a file from the local filesystem.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' }
    },
    required: ['path']
  },
  execute: async ({ path }) => {
    const fileSchema = z.object({
      path: z.string().min(1, "File path is required").max(500, "File path too long")
    });

    const validationResult = fileSchema.safeParse({ path });
    if (!validationResult.success) {
      return {
        success: false,
        content: '',
        error: `Invalid file path: ${validationResult.error.issues.map((e: z.ZodIssue) => (e instanceof Error ? e.message : String(e))).join(', ')}`
      };
    }

    if (isTauri()) {
      try {
        const content = await DesktopHostFS.readFile(path as string);
        if (content.length > MAX_FILE_SIZE) return { success: false, content: '', error: `File exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` };
        return { success: true, content };
      } catch (e: unknown) {
        return { success: false, content: '', error: (e instanceof Error ? e.message : String(e)) };
      }
    }

    if (!isNative()) return { success: false, content: '', error: 'Filesystem access requires the GIA mobile app (Android) or the GIA Cowork desktop app.' };
    const pathErr = isPathSafe(path as string);
    if (pathErr) return { success: false, content: '', error: pathErr };
    try {
      const result = await Filesystem.readFile({ path: path as string, directory: Directory.Documents, encoding: Encoding.UTF8 });
      const content = result.data as string;
      if (content.length > MAX_FILE_SIZE) return { success: false, content: '', error: `File exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` };
      return { success: true, content };
    } catch (e: unknown) {
      return { success: false, content: '', error: (e instanceof Error ? e.message : String(e)) };
    }
  }
};

const filesystemWrite: Tool = {
  id: 'filesystem_write',
  name: 'filesystem_write',
  description: 'Write or update a file on the local filesystem.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'File content' }
    },
    required: ['path', 'content']
  },
  execute: async ({ path, content }) => {
    const fileWriteSchema = z.object({
      path: z.string().min(1, "File path is required").max(500, "File path too long"),
      content: z.string().max(10 * 1024 * 1024, "Content exceeds 10MB limit")
    });

    const validationResult = fileWriteSchema.safeParse({ path, content });
    if (!validationResult.success) {
      return {
        success: false,
        content: '',
        error: `Invalid file write parameters: ${validationResult.error.issues.map((e: z.ZodIssue) => (e instanceof Error ? e.message : String(e))).join(', ')}`
      };
    }

    if (!isTauri()) {
      const pathErr = isPathSafe(path as string);
      if (pathErr) return { success: false, content: '', error: pathErr };
    }
    if ((content as string) && (content as string).length > MAX_FILE_SIZE) return { success: false, content: '', error: `Content exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` };

    const ext = (path as string).split('.').pop()?.toLowerCase() || 'txt';
    const isPdf = ext === 'pdf';
    const mimeMap: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', html: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python', json: 'application/json', csv: 'text/csv', xml: 'text/xml', yaml: 'text/yaml', yml: 'text/yaml', pdf: 'application/pdf' };

    const editState = useGiaStore.getState().liveFileEdit;
    const isEditingExisting = editState && editState.path === path;
    if (!isEditingExisting) {
      useGiaStore.getState().setLiveFileEdit({
        path: path as string,
        name: (path as string).split('/').pop() || 'file.txt',
        type: mimeMap[ext] || 'text/plain',
        oldContent: editState?.newContent || '',
        newContent: content as string,
        isPdf,
        timestamp: Date.now(),
      });
    } else {
      useGiaStore.getState().setLiveFileEdit({
        ...editState,
        newContent: content as string,
        timestamp: Date.now(),
      });
    }

    if (isTauri()) {
      // Snapshot the previous content BEFORE overwriting. GIA writes to the
      // real host filesystem on desktop, so without this an agent mistake is
      // unrecoverable — there is no sandbox to throw away.
      const snapshot = await fileSnapshots.capture(path as string, content as string, 'filesystem_write');
      try {
        const size = await DesktopHostFS.writeFile(path as string, content as string);
        const undoHint = snapshot
          ? ` — undo available in Settings → Undo`
          : ' (no previous version to restore)';
        return { success: true, content: `File written to ${path as string} (verified, ${size} bytes)${undoHint}` };
      } catch (e: unknown) {
        return { success: false, content: '', error: (e instanceof Error ? e.message : String(e)) };
      }
    }

    if (isNative()) {
      try {
        await Filesystem.writeFile({ path: path as string, data: content as string, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
        await Filesystem.stat({ path: path as string, directory: Directory.Documents });
        return { success: true, content: `File written to ${path as string} (verified)` };
      } catch (e: unknown) {
        return { success: false, content: '', error: (e instanceof Error ? e.message : String(e)) };
      }
    }
    const blob = new Blob([content as string], { type: mimeMap[ext] || 'text/plain' });
    triggerDownload(blob, (path as string).split('/').pop() || 'file.txt');
    return { success: true, content: `File "${path}" ready for download.` };
  }
};

const listFiles: Tool = {
  id: 'list_files', name: 'list_files',
  description: 'List files in a directory.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path (optional, default root)' }
    }
  },
  execute: async ({ path = '' }) => {
    const listSchema = z.object({
      path: z.string().max(500, "Path too long").optional().default('')
    });

    const validationResult = listSchema.safeParse({ path });
    if (!validationResult.success) {
      return {
        success: false,
        content: '',
        error: `Invalid list files parameters: ${validationResult.error.issues.map((e: z.ZodIssue) => (e instanceof Error ? e.message : String(e))).join(', ')}`
      };
    }

    const validatedPath = validationResult.data.path;

    if (isTauri()) {
      try {
        const result = await DesktopHostFS.listDir(validatedPath || undefined);
        const lines = result.entries.map(e => e.isDir ? `${e.name}/` : e.name);
        return { success: true, content: lines.join('\n') || `(empty: ${result.currentDir})` };
      } catch (e: unknown) {
        return { success: false, content: '', error: (e instanceof Error ? e.message : String(e)) };
      }
    }

    if (!isNative()) return { success: false, content: '', error: 'Filesystem access requires the GIA mobile app (Android) or the GIA Cowork desktop app.' };
    if (validatedPath) {
      const pathErr = isPathSafe(validatedPath);
      if (pathErr) return { success: false, content: '', error: pathErr };
    }
    try {
      const result = await Filesystem.readdir({ path: validatedPath, directory: Directory.Documents });
      return { success: true, content: result.files.map(f => f.name).join('\n') };
    } catch (e: unknown) {
      return { success: false, content: '', error: (e instanceof Error ? e.message : String(e)) };
    }
  }
};

const zipProject: Tool = {
  id: 'zip_project', name: 'zip_project',
  description: 'Create a ZIP bundle of files. Provide "files" as [{path, content}] OR "paths" as string[] to read from device.',
  execute: async ({ filename = 'project.zip', files, paths }, ctx?: ToolContext) => {
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      ctx?.onThought?.('📦 Creating archive...');
      ctx?.onProgress?.(0.05, 'Adding files...');
      if (files && Array.isArray(files)) {
        files.forEach((f: { path: string; content: string | Record<string, unknown> }) => {
          const name = f.path.replace(/\\/g, '/');
          zip.file(name, typeof f.content === 'string' ? f.content : JSON.stringify(f.content), { binary: false });
        });
      }

      if (paths && Array.isArray(paths)) {
        for (const p of paths) {
          try {
            ctx?.onProgress?.(0.1, `Reading ${p}...`);
            ctx?.onThought?.(`  Reading ${p}...`);
            let text: string;
            if (isTauri()) {
              text = await DesktopHostFS.readFile(p);
            } else if (isNative()) {
              const pathErr = isPathSafe(p);
              if (pathErr) continue;
              const res = await Filesystem.readFile({ path: p, directory: Directory.Documents, encoding: Encoding.UTF8 });
              text = res.data as string;
            } else {
              return { success: false, content: '', error: 'Reading files from paths requires the GIA mobile or desktop app.' };
            }
            zip.file(p, text);
          } catch (e) { logger.error('[filesystem] Skipping unreadable file:', e); }
        }
      }

      useGiaStore.getState().addNotification(`📦 Packaging ${filename}...`);
      ctx?.onProgress?.(0.3, 'Compressing...');
      ctx?.onThought?.('Compressing...');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }, (meta) => {
        ctx?.onProgress?.(0.3 + meta.percent / 100 * 0.6, `Compressing... ${Math.round(meta.percent)}%`);
      });
      ctx?.onProgress?.(0.95, 'Finalizing...');
      ctx?.onThought?.('✅ Archive ready');
      useGiaStore.getState().addNotification(`✅ ${filename} ready`);

      if (isNative()) {
        try {
          const base64 = await blobToBase64(blob);
          await Filesystem.writeFile({ path: filename as string, data: base64, directory: Directory.Documents });
          useGiaStore.getState().addNotification(`✅ ${filename as string} saved to Documents`);
          return { success: true, content: `Created ${filename as string} and saved to your Documents folder.` };
        } catch (e: unknown) {
          return { success: false, content: '', error: `Native save failed: ${(e as Error).message}` };
        }
      }

      triggerDownload(blob, filename as string);
      return { success: true, content: `Created ${filename} — check your downloads.` };
    } catch (e: unknown) {
      return { success: false, content: '', error: (e instanceof Error ? e.message : String(e)) };
    }
  }
};

const undoFileChange: Tool = {
  id: 'undo_file_change',
  name: 'undo_file_change',
  description: 'Restore a file GIA previously overwrote to its earlier contents. Use undo_last_file_change for the most recent change, or pass a snapshot ID to undo a specific one. List available changes with list_file_changes.',
  schema: {
    type: 'object',
    properties: {
      snapshotId: { type: 'string', description: 'Snapshot ID to restore (omit to undo the most recent change)' },
    },
  },
  execute: async ({ snapshotId }) => {
    if (!isTauri()) {
      return { success: false, content: '', error: 'Undo is only available in the GIA Cowork desktop app.' };
    }
    const pending = fileSnapshots.listPending();
    if (pending.length === 0) {
      return { success: false, content: '', error: 'No file changes available to undo.' };
    }
    const target = snapshotId
      ? pending.find(s => s.id === snapshotId)
      : pending[0];
    if (!target) {
      return { success: false, content: '', error: `No matching change for snapshot ${snapshotId}. Use list_file_changes to see available snapshots.` };
    }
    const res = await fileSnapshots.revert(target.id);
    if (!res.success) return { success: false, content: '', error: res.error || 'Undo failed' };
    return {
      success: true,
      content: `Restored ${target.path} to its previous version.`,
    };
  },
};

const listFileChanges: Tool = {
  id: 'list_file_changes',
  name: 'list_file_changes',
  description: 'List file changes GIA made that can be undone, newest first, with snapshot IDs for undo_file_change.',
  schema: {
    type: 'object',
    properties: {},
  },
  execute: async () => {
    if (!isTauri()) {
      return { success: false, content: '', error: 'File change history is only available in the GIA Cowork desktop app.' };
    }
    const pending = fileSnapshots.listPending();
    if (pending.length === 0) {
      return { success: true, content: 'No file changes to undo.' };
    }
    const lines = pending.map(s => {
      const kind = s.previousContent === null ? 'created' : 'overwrote';
      return `${s.id} | ${kind} | ${s.path} | ${new Date(s.timestamp).toLocaleString()}`;
    });
    return { success: true, content: lines.join('\n') };
  },
};

export const filesystemTools: Tool[] = [filesystemRead, filesystemWrite, listFiles, zipProject, undoFileChange, listFileChanges];
