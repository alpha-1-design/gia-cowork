import { App as CapacitorApp } from '@capacitor/app';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { GIAUpdate } from './GIAUpdate';
import { isTauri, isCapacitorNative } from '../platform';
import DesktopHostFS from './DesktopHostFS';
import terminalService from './TerminalService';
import { logger } from '../utils/logger';

// Desktop-first OTA. GIA Cowork is a Linux desktop (Tauri) app but reuses the
// gia-app (Android) codebase, so the original update path was hardcoded to the
// mobile repo + APK sideload — wrong and fragile on desktop. We now pick the
// correct repo per platform, and on desktop we surface the release for the user
// to install via their package manager / AppImage instead of installing an APK.

const OWNER = 'alpha-1-design';
const REPO = isTauri() ? 'gia-cowork' : 'gia-app';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const CACHE_TTL = 5 * 60 * 1000;

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  downloadUrl: string;
  releaseUrl: string;
  releaseName: string;
  publishedAt: string;
  body: string;
  size: number;
  platform: 'desktop' | 'mobile';
  /** True only on mobile, where we can download + sideload an APK in-app. */
  installableInApp: boolean;
}

export interface DownloadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export function formatSize(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function getCurrentVersion(): Promise<string> {
  try {
    if (isTauri()) {
      const { getVersion } = await import('@tauri-apps/api/app');
      return await getVersion();
    }
    const appInfo = await CapacitorApp.getInfo();
    return appInfo.version;
  } catch {
    return '0.0.0';
  }
}

class UpdateService {
  private checking = false;
  private cachedUpdate: UpdateInfo | null = null;
  private cacheTime = 0;
  private downloadedPath: string | null = null;

  getCachedUpdate(): UpdateInfo | null {
    if (this.cachedUpdate && Date.now() - this.cacheTime < CACHE_TTL) {
      return this.cachedUpdate;
    }
    return null;
  }

  async checkForUpdate(): Promise<UpdateInfo | null> {
    const cached = this.getCachedUpdate();
    if (cached) return cached;
    if (this.checking) return null;
    this.checking = true;

    // Plain-web sessions (e.g. a browser preview of the desktop app) have no
    // app store or release to update — checking would surface the *mobile*
    // repo's release ("GIA Android v2.4.x") as a confusing desktop toast.
    // Only check inside the Tauri shell or a real Capacitor app.
    if (!isTauri() && !isCapacitorNative()) return null;

    try {
      const currentVersion = await getCurrentVersion();

      const res = await fetch(API, {
        headers: { Accept: 'application/vnd.github.v3+json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;

      const release = await res.json();
      const tagVersion = (release.tag_name || '').replace(/^v/, '');
      if (!tagVersion || tagVersion === currentVersion) return null;

      const desktop = isTauri();
      const assets: { name: string; size: number; browser_download_url: string }[] =
        release.assets ?? [];
      const asset = desktop
        ? assets.find((a) => /\.(deb|appimage|rpm|msi|exe|tar\.gz|zip)$/i.test(a.name))
        : assets.find((a) => a.name === 'app-release.apk') ??
          assets.find((a) => a.name.endsWith('.apk'));

      // Newer release, but no platform-specific asset — still tell the user.
      if (!asset) {
        this.cachedUpdate = {
          version: tagVersion,
          currentVersion,
          downloadUrl: release.html_url,
          releaseUrl: release.html_url,
          releaseName: release.name || release.tag_name,
          publishedAt: release.published_at,
          body: release.body || '',
          size: 0,
          platform: desktop ? 'desktop' : 'mobile',
          installableInApp: false,
        };
        this.cacheTime = Date.now();
        return this.cachedUpdate;
      }

      this.cachedUpdate = {
        version: tagVersion,
        currentVersion,
        downloadUrl: asset.browser_download_url,
        releaseUrl: release.html_url,
        releaseName: release.name || release.tag_name,
        publishedAt: release.published_at,
        body: release.body || '',
        size: asset.size,
        platform: desktop ? 'desktop' : 'mobile',
        installableInApp: !desktop,
      };
      this.cacheTime = Date.now();
      return this.cachedUpdate;
    } catch (e) {
      logger.warn('[UpdateService] Check failed:', e);
      return null;
    } finally {
      this.checking = false;
    }
  }

  async downloadUpdate(
    url: string,
    onProgress?: (p: DownloadProgress) => void
  ): Promise<void> {
    if (isTauri()) {
      await this.downloadDesktopUpdate(url, onProgress);
      return;
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';

      xhr.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress({
            loaded: e.loaded,
            total: e.total,
            percent: Math.round((e.loaded / e.total) * 100),
          });
        }
      };

      xhr.onload = async () => {
        if (xhr.status !== 200) {
          reject(new Error(`Download failed: ${xhr.status}`));
          return;
        }
        try {
          const blob = xhr.response as Blob;
          const base64 = await blobToBase64(blob);
          await Filesystem.writeFile({
            path: 'update.apk',
            data: base64,
            directory: Directory.Cache,
          });
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      xhr.onerror = () => reject(new Error('Download failed'));
      xhr.send();
    });
  }

  async installUpdate(): Promise<void> {
    if (isTauri()) {
      await this.installDesktopUpdate();
      return;
    }
    try {
      await GIAUpdate.installApk({ fileName: 'update.apk' });
    } catch (e) {
      logger.error('[UpdateService] Install failed:', e);
      throw e;
    }
  }

  // ── Desktop (Tauri) update pipeline ─────────────────────────────────────
  // Real in-app updater: stream the release artifact to disk with live byte
  // progress, then apply it (AppImage relaunch / deb+rpm via polkit) and
  // restart. This replaces the old "open the release page and leave" flow.

  private async downloadDesktopUpdate(
    url: string,
    onProgress?: (p: DownloadProgress) => void,
  ): Promise<void> {
    // If the release has no desktop package yet, downloadUrl is the release
    // page itself — open that instead of "downloading" an HTML page.
    if (!/(\.deb|\.rpm|\.appimage|\.msi|\.exe|\.tar\.gz|\.zip)(\?|$)/i.test(url)) {
      await this.openReleasePage();
      return;
    }
    const fileName = decodeURIComponent(url.split('?')[0].split('/').pop() || 'gia-cowork-update');
    const targetPath = `~/Downloads/${fileName}`;
    this.downloadedPath = null;
    await this.downloadToHost(url, targetPath, this.cachedUpdate?.size || 0, onProgress);
    this.downloadedPath = targetPath;
    logger.log(`[UpdateService] Desktop update downloaded to ${targetPath}`);
  }

  private async downloadToHost(
    url: string,
    targetPath: string,
    expectedTotal: number,
    onProgress?: (p: DownloadProgress) => void,
  ): Promise<void> {
    const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
    if (!res.body) throw new Error('Download failed: no response body');

    const total = Number(res.headers.get('content-length')) || expectedTotal || 0;
    const reader = res.body.getReader();
    let received = 0;
    let queued: Uint8Array[] = [];
    let queuedLen = 0;
    let firstWrite = true;

    const flush = async () => {
      if (queuedLen === 0) return;
      const merged = new Uint8Array(queuedLen);
      let off = 0;
      for (const c of queued) {
        merged.set(c, off);
        off += c.length;
      }
      queued = [];
      queuedLen = 0;
      await DesktopHostFS.appendBytes(targetPath, uint8ToBase64(merged), !firstWrite);
      firstWrite = false;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      queued.push(value);
      queuedLen += value.length;
      received += value.length;
      if (queuedLen >= 4 * 1024 * 1024) await flush();
      onProgress?.({
        loaded: received,
        total,
        percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0,
      });
    }
    await flush();
    if (total > 0 && received !== total) {
      throw new Error(`Download incomplete: ${received}/${total} bytes`);
    }
  }

  private async installDesktopUpdate(): Promise<void> {
    const path = this.downloadedPath || '';
    this.downloadedPath = null;
    if (!path) {
      await this.openReleasePage();
      return;
    }
    const lower = path.toLowerCase();
    try {
      if (lower.endsWith('.appimage')) {
        await terminalService.exec(
          `chmod +x ${shQuote(path)} && setsid nohup ${shQuote(path)} >/dev/null 2>&1 &`,
          undefined,
          undefined,
          60000,
        );
        await delay(1500);
        await exitDesktopApp();
        return;
      }
      if (lower.endsWith('.deb')) {
        const installed = await terminalService.exec(
          `pkexec dpkg -i ${shQuote(path)}`,
          undefined,
          undefined,
          600000,
        );
        if (installed.exitCode !== 0) {
          throw new Error(`dpkg install failed (exit ${installed.exitCode})`);
        }
        await relaunchInstalledBinary();
        await delay(1500);
        await exitDesktopApp();
        return;
      }
      if (lower.endsWith('.rpm')) {
        const installed = await terminalService.exec(
          `pkexec rpm -Uvh ${shQuote(path)}`,
          undefined,
          undefined,
          600000,
        );
        if (installed.exitCode !== 0) {
          throw new Error(`rpm install failed (exit ${installed.exitCode})`);
        }
        await relaunchInstalledBinary();
        await delay(1500);
        await exitDesktopApp();
        return;
      }
      if (lower.endsWith('.msi') || lower.endsWith('.exe')) {
        const installer = lower.endsWith('.msi')
          ? `Start-Process msiexec.exe -ArgumentList ${psQuote(`/i "${path}"`)} -Verb RunAs -Wait`
          : `Start-Process -FilePath ${psQuote(path)} -Verb RunAs -Wait`;
        const installed = await terminalService.exec(installer, undefined, undefined, 600000);
        if (installed.exitCode !== 0) {
          throw new Error(`Windows installer failed (exit ${installed.exitCode})`);
        }
        await delay(1500);
        await exitDesktopApp();
        return;
      }
      // .tar.gz / .zip: reveal the archive and let the user unpack it.
      await terminalService.exec('xdg-open "$HOME/Downloads"', undefined, undefined, 30000);
    } catch (e) {
      throw new Error(`Update install failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async openReleasePage(): Promise<void> {
    const url = this.cachedUpdate?.releaseUrl;
    if (!url) return;
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } catch {
      if (typeof window !== 'undefined') window.open(url, '_blank');
    }
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function relaunchInstalledBinary(): Promise<void> {
  try {
    await terminalService.exec(
      'rel="$(command -v gia-cowork 2>/dev/null)"; [ -n "$rel" ] && { setsid nohup "$rel" >/dev/null 2>&1 & }; true',
      undefined,
      undefined,
      30000,
    );
  } catch {
    // Ignore — the user can reopen GIA from the app menu after it quits.
  }
}

async function exitDesktopApp(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('app_exit');
  } catch {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch {
      // ignore
    }
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export const updateService = new UpdateService();
