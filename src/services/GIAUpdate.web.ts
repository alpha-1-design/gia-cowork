import type { GIAUpdatePlugin } from './GIAUpdate';
import { isTauri } from '../platform';

export class GIAUpdateWeb implements GIAUpdatePlugin {
  async installApk(): Promise<void> {
    // Honest, platform-aware error: the desktop app updates through the OS
    // package manager (AppImage/deb/rpm), not APK sideloads.
    throw new Error(
      isTauri()
        ? 'Desktop updates are delivered by your OS package manager (AppImage/deb/rpm) — see Settings → Update for the release page.'
        : 'APK install is only available on Android.'
    );
  }
}
