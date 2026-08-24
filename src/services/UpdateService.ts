import { App as CapacitorApp } from '@capacitor/app';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { GIAUpdate } from './GIAUpdate';
import { isTauri } from '../platform';
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
        ? assets.find((a) => /\.(deb|appimage|rpm|tar\.gz|zip)$/i.test(a.name))
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
    // Desktop updates ship as .deb/.AppImage/.rpm — not something we sideload
    // in-app. The UI should link the user to downloadUrl / releaseUrl instead.
    if (isTauri()) {
      logger.log('[UpdateService] Desktop update handled via package manager / release page.');
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
      // Desktop: open the release page so the user can grab the package.
      const url = this.cachedUpdate?.releaseUrl;
      try {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        if (url) await openUrl(url);
      } catch {
        if (url && typeof window !== 'undefined') window.open(url, '_blank');
      }
      return;
    }
    try {
      await GIAUpdate.installApk({ fileName: 'update.apk' });
    } catch (e) {
      logger.error('[UpdateService] Install failed:', e);
      throw e;
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
