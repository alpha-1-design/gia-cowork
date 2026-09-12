// Desktop host filesystem bridge for GIA Cowork (Tauri / Linux).
//
// GIA Desktop is a real desktop app with a real shell, so the agent's
// filesystem should be the host filesystem -- not a sandboxed app directory.
// These wrappers call the Rust `fs_read` / `fs_write` / `fs_list` commands
// (see src-tauri/src/desktop_fs.rs) and are only used inside the Tauri shell.
// On web and Android the shared code keeps using the Capacitor Filesystem
// plugin and sandbox paths.

import { isTauri } from '../platform';

export interface HostFileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modifiedMs: number | null;
}

export interface HostListResult {
  currentDir: string;
  entries: HostFileEntry[];
}

export interface HostFsAccess {
  isAvailable: boolean;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<number>;
  appendBytes: (path: string, chunkB64: string, append: boolean) => Promise<number>;
  listDir: (path?: string) => Promise<HostListResult>;
}

class DesktopHostFS implements HostFsAccess {
  get isAvailable(): boolean {
    return isTauri();
  }

  private async invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    if (!isTauri()) {
      throw new Error('Host filesystem is only available in the GIA Cowork desktop app.');
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }

  async readFile(path: string): Promise<string> {
    const res = await this.invoke<{ content: string; size: number }>('fs_read', { path });
    return res.content;
  }

  async writeFile(path: string, content: string): Promise<number> {
    const res = await this.invoke<{ size: number }>('fs_write', { path, content });
    return res.size;
  }

  async appendBytes(path: string, chunkB64: string, append: boolean): Promise<number> {
    const res = await this.invoke<{ size: number }>('fs_write_bytes', { path, chunkB64, append });
    return res.size;
  }

  async listDir(path?: string): Promise<HostListResult> {
    return this.invoke<HostListResult>('fs_list', path?.trim() ? { path } : {});
  }
}

export default new DesktopHostFS();