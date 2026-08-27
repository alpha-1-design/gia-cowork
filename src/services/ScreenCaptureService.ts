import { logger } from '../utils/logger';

export class ScreenCaptureService {
  static async captureScreen(): Promise<string> {
    try {
      const Capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; plugin?: (name: string) => { take?: () => Promise<Record<string, string>> } } }).Capacitor;
      if (Capacitor?.isNativePlatform?.()) {
        try {
          const Screenshot = Capacitor.plugin?.('Screenshot');
          if (Screenshot?.take) {
            const result = await Screenshot.take();
            return result.dataUrl || result.base64 || '';
          }
        } catch { /* ignore */ }

        try {
          const html2canvas = (window as unknown as { html2canvas?: (element: HTMLElement, options: { backgroundColor: null; scale: number; useCORS: boolean; logging: boolean }) => Promise<HTMLCanvasElement> }).html2canvas;
          if (typeof html2canvas === 'function') {
            const canvas = await html2canvas(document.body, {
              backgroundColor: null,
              scale: 2,
              useCORS: true,
              logging: false,
            });
            return canvas.toDataURL('image/png', 0.95);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    return this.captureDisplayMedia();
  }

  private static async captureDisplayMedia(): Promise<string> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen capture not supported in this browser');
    }

    // Hide the GIA window before capture so she doesn't appear in her own screenshot.
    // This is critical for use cases like interviews where GIA is helping the user
    // and should not be visible in screen shares or recordings.
    let wasHidden = false;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      wasHidden = await invoke<boolean>('hide_for_capture');
    } catch { /* not in Tauri — skip hiding */ }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor' },
        audio: false,
      });

      const track = stream.getVideoTracks()[0];
      const video = document.createElement('video');
      video.srcObject = stream;
      await video.play();

      // Brief delay to ensure the window is fully hidden before frame capture
      if (wasHidden) await new Promise(r => setTimeout(r, 200));

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0);

      track.stop();
      stream.getTracks().forEach(t => t.stop());
      video.remove();

      const dataUrl = canvas.toDataURL('image/png', 0.95);
      canvas.remove();
      return dataUrl;
    } catch (e) {
      if (stream) stream.getTracks().forEach(t => t.stop());
      if ((e as Error).name === 'NotAllowedError' || (e as Error).message?.includes('cancel')) {
        throw new Error('Screen capture cancelled');
      }
      logger.error('[ScreenCapture] Failed:', e);
      throw e;
    } finally {
      // Always restore the window, even if capture failed
      if (wasHidden) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('show_after_capture');
        } catch { /* best-effort restore */ }
      }
    }
  }
}
