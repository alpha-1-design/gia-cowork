import { logger } from '../utils/logger';
import type { SystemInfo } from './SystemService';

interface Contact {
  id: string;
  name: string;
  phones: { number: string; label: string }[];
  emails: { address: string; label: string }[];
  photo?: string;
}

interface DeviceInfoResult {
  platform: string;
  os: string;
  osVersion: string;
  model: string;
  manufacturer: string;
  batteryLevel: number | null;
  isCharging: boolean | null;
  networkOnline: boolean;
  networkType: string | null;
  language: string;
  timezone: string;
  screenWidth: number;
  screenHeight: number;
  cpuCores: number | null;
  memoryGB: number | null;
  container: string;
}

function validatePhone(phone: string): string {
  if (!phone || typeof phone !== 'string') {
    throw new Error('Phone number is required');
  }
  const cleaned = phone.replace(/[\s\-()]/g, '');
  if (!cleaned) throw new Error('Phone number is empty after cleaning');
  return cleaned;
}

function validateString(v: unknown, name: string): string {
  if (!v || typeof v !== 'string') throw new Error(`${name} is required`);
  return v;
}

class DeviceIntegration {
  private static instance: DeviceIntegration;

  static getInstance(): DeviceIntegration {
    if (!this.instance) this.instance = new DeviceIntegration();
    return this.instance;
  }

  private isCapacitor(): boolean {
    try {
      const w = window as { Capacitor?: { isNativePlatform?: () => boolean } };
      return typeof w.Capacitor?.isNativePlatform === 'function' &&
        w.Capacitor.isNativePlatform();
    } catch {
      logger.warn('[DeviceIntegration] isCapacitor check failed');
      return false;
    }
  }

  async sendWhatsApp(phone: string, message: string): Promise<{ method: string }> {
    const cleaned = validatePhone(phone);
    const text = encodeURIComponent(validateString(message, 'Message'));

    try {
      if (this.isCapacitor()) {
        const { Share } = await import('@capacitor/share');
        await Share.share({
          text: message,
          title: 'Share via WhatsApp',
          dialogTitle: 'Share with',
          url: `https://wa.me/${cleaned}?text=${text}`,
        });
        return { method: 'capacitor_share' };
      }
    } catch (e) {
      logger.warn('[DeviceIntegration] Capacitor share failed, falling back to wa.me:', e);
    }

    window.open(`https://wa.me/${cleaned}?text=${text}`, '_blank');
    return { method: 'wa.me_link' };
  }

  async sendEmail(to: string, subject: string, body: string): Promise<{ method: string }> {
    const encodedTo = encodeURIComponent(validateString(to, 'Recipient'));
    const encodedSubject = encodeURIComponent(validateString(subject, 'Subject'));
    const encodedBody = encodeURIComponent(validateString(body, 'Body'));

    try {
      const mailto = `mailto:${encodedTo}?subject=${encodedSubject}&body=${encodedBody}`;
      window.location.href = mailto;
      return { method: 'mailto_link' };
    } catch (e) {
      logger.warn('[DeviceIntegration] sendEmail failed:', e);
      throw new Error('Failed to open email client');
    }
  }

  async shareContent(title: string, text: string, url?: string): Promise<{ method: string }> {
    try {
      if (this.isCapacitor()) {
        const { Share } = await import('@capacitor/share');
        await Share.share({
          title,
          text,
          url: url || undefined,
          dialogTitle: 'Share via',
        });
        return { method: 'capacitor_share' };
      }
    } catch (e) {
      logger.warn('[DeviceIntegration] Capacitor share failed:', e);
    }

    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
        return { method: 'web_share_api' };
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          throw new Error('Share was cancelled by user');
        }
        logger.warn('[DeviceIntegration] Web share failed:', e);
      }
    }

    if (navigator.clipboard?.writeText) {
      try {
        const shareText = url ? `${title}\n${text}\n${url}` : `${title}\n${text}`;
        await navigator.clipboard.writeText(shareText);
        return { method: 'clipboard_fallback' };
      } catch (e) {
        logger.warn('[DeviceIntegration] Clipboard fallback failed:', e);
      }
    }

    throw new Error('No sharing method available on this device');
  }

  async clipboardRead(): Promise<string> {
    try {
      if (this.isCapacitor()) {
        const { Clipboard } = await import('@capacitor/clipboard');
        const result = await Clipboard.read();
        return result.value ?? '';
      }
    } catch (e) {
      logger.warn('[DeviceIntegration] Capacitor clipboard read failed:', e);
    }

    if (navigator.clipboard?.readText) {
      try {
        return await navigator.clipboard.readText();
      } catch (e) {
        logger.warn('[DeviceIntegration] Web clipboard read failed:', e);
      }
    }

    throw new Error('Clipboard reading not available');
  }

  async clipboardWrite(text: string): Promise<void> {
    const content = validateString(text, 'Clipboard text');

    try {
      if (this.isCapacitor()) {
        const { Clipboard } = await import('@capacitor/clipboard');
        await Clipboard.write({ string: content });
        return;
      }
    } catch (e) {
      logger.warn('[DeviceIntegration] Capacitor clipboard write failed:', e);
    }

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(content);
        return;
      } catch (e) {
        logger.warn('[DeviceIntegration] Web clipboard write failed:', e);
      }
    }

    throw new Error('Clipboard writing not available');
  }

  async vibrate(durationMs: number): Promise<{ method: string }> {
    const ms = typeof durationMs !== 'number' || isNaN(durationMs) || durationMs < 0 ? 500 : durationMs;
    const clamped = Math.min(ms, 5000);

    try {
      if (this.isCapacitor()) {
        const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
        if (clamped < 500) {
          await Haptics.impact({ style: ImpactStyle.Light });
        } else if (clamped < 1000) {
          await Haptics.impact({ style: ImpactStyle.Medium });
        } else {
          await Haptics.impact({ style: ImpactStyle.Heavy });
        }
        return { method: 'capacitor_haptics' };
      }
    } catch (e) {
      logger.warn('[DeviceIntegration] Haptics failed:', e);
    }

    if (navigator.vibrate) {
      navigator.vibrate(clamped);
      return { method: 'vibration_api' };
    }

    throw new Error('Vibration not available on this device');
  }

  async getBrightness(): Promise<number> {
    try {
      if (this.isCapacitor()) {
        const { ScreenBrightness } = await import('@capacitor-community/screen-brightness');
        const result = await ScreenBrightness.getBrightness();
        if (typeof result.brightness === 'number' && !isNaN(result.brightness)) {
          return result.brightness;
        }
      }
    } catch (e) {
      logger.warn('[DeviceIntegration] getBrightness failed:', e);
    }

    return 0.5;
  }

  async setBrightness(value: number): Promise<void> {
    const clamped = typeof value === 'number' && !isNaN(value)
      ? Math.max(0, Math.min(1, value))
      : 0.5;

    try {
      if (this.isCapacitor()) {
        const { ScreenBrightness } = await import('@capacitor-community/screen-brightness');
        await ScreenBrightness.setBrightness({ brightness: clamped });
        return;
      }
    } catch (e) {
      logger.warn('[DeviceIntegration] setBrightness failed:', e);
    }

    throw new Error('Screen brightness control not available on web');
  }

  async getDeviceInfo(): Promise<DeviceInfoResult> {
    let platform = '';
    let os = '';
    let osVersion = '';
    let model = '';
    let manufacturer = '';

    try {
      if (this.isCapacitor()) {
        const { Device } = await import('@capacitor/device');
        const info = await Device.getInfo();
        platform = info.platform;
        os = info.operatingSystem;
        osVersion = info.osVersion || '';
        model = info.model || '';
        manufacturer = info.manufacturer || '';
      }
    } catch (e) {
      logger.warn('[DeviceIntegration] Device info failed:', e);
    }

    let sysInfo: SystemInfo;
    try {
      sysInfo = await this.getSystemInfo();
    } catch (e) {
      logger.warn('[DeviceIntegration] System info failed:', e);
      sysInfo = {
        platform: 'web', os: 'unknown', language: 'en', timezone: 'UTC',
        userAgent: '', timezoneOffset: 0, isMobile: false, isDesktop: true,
        isNativeApp: false, container: 'browser',
        screen: { width: 0, height: 0, colorDepth: 24, pixelRatio: 1 },
        network: { online: true, type: 'unknown', downlink: null, rtt: null },
        hardware: { cpuCores: null, memoryGB: null, touchScreen: false },
        battery: { level: null, charging: null, dischargingTime: null },
      };
    }

    return {
      platform: platform || sysInfo.platform,
      os: os || sysInfo.os,
      osVersion,
      model,
      manufacturer,
      batteryLevel: sysInfo.battery?.level ?? null,
      isCharging: sysInfo.battery?.charging ?? null,
      networkOnline: sysInfo.network.online,
      networkType: sysInfo.network.type,
      language: sysInfo.language,
      timezone: sysInfo.timezone,
      screenWidth: sysInfo.screen.width,
      screenHeight: sysInfo.screen.height,
      cpuCores: sysInfo.hardware.cpuCores,
      memoryGB: sysInfo.hardware.memoryGB,
      container: sysInfo.container,
    };
  }

  private async getSystemInfo(): Promise<SystemInfo> {
    const { default: systemService } = await import('./SystemService');
    return await systemService.getInfo();
  }

  async openUrl(url: string): Promise<{ method: string }> {
    if (!url || typeof url !== 'string') {
      throw new Error('URL is required');
    }

    const lower = url.toLowerCase().trim();
    if (lower.startsWith('javascript:')) {
      throw new Error('Opening javascript: URLs is not allowed');
    }

    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'tel:', 'mailto:', 'sms:', 'intent:'].includes(parsed.protocol)) {
        throw new Error(`Protocol "${parsed.protocol}" is not allowed`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Protocol')) throw e;
      throw new Error(`Invalid URL: ${url}`);
    }

    const win = window.open(url, '_blank');
    if (!win || win.closed) {
      throw new Error('Popup was blocked. Please allow popups for this site.');
    }
    return { method: 'window_open' };
  }

  async setAlarm(hour: number, minute: number, label?: string, days?: number[]): Promise<{ method: string; batteryOptimized?: boolean }> {
    if (typeof hour !== 'number' || typeof minute !== 'number' ||
        isNaN(hour) || isNaN(minute) ||
        hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error('Invalid alarm time: hour 0-23, minute 0-59');
    }

    try {
      if (this.isCapacitor()) {
        const { GIAAlarm } = await import('./GIAAlarm');
        const result = await GIAAlarm.setAlarm({ hour, minute, label });
        if (result.success) return { method: 'alarm_manager', batteryOptimized: result.batteryOptimized };
      }
    } catch (e) {
      logger.warn('[DeviceIntegration] Native alarm failed:', e);
    }

    {
      let url = `intent://alarm/#Intent;action=android.intent.action.SET_ALARM;` +
        `I.android.intent.extra.alarm.HOUR=${hour};` +
        `I.android.intent.extra.alarm.MINUTES=${minute}`;
      if (label) url += `;S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(label)}`;
      if (days && days.length > 0) {
        url += `;S.android.intent.extra.alarm.DAYS=${days.join(',')}`;
      }
      url += `;end`;
      try {
        window.open(url, '_blank');
        return { method: 'android_intent' };
      } catch (e) {
        logger.warn('[DeviceIntegration] Android intent alarm failed:', e);
      }
    }

    throw new Error('Alarm setting not available on this device');
  }

  formatDeviceInfo(info: DeviceInfoResult): string {
    const lines = [
      `**Device Info**`,
      `- Platform: ${info.platform} ${info.os} ${info.osVersion}`,
      ``,
      `**Hardware**`,
      `- Model: ${info.model || 'Unknown'}`,
      `- Manufacturer: ${info.manufacturer || 'Unknown'}`,
      `- CPU Cores: ${info.cpuCores || 'Unknown'}`,
      `- Memory: ${info.memoryGB || 'Unknown'} GB`,
      `- Screen: ${info.screenWidth}x${info.screenHeight}`,
      ``,
      `**Power**`,
      `- Battery: ${info.batteryLevel !== null ? `${Math.round(info.batteryLevel * 100)}%` : 'Unknown'}`,
      `- Charging: ${info.isCharging !== null ? (info.isCharging ? 'Yes' : 'No') : 'Unknown'}`,
      ``,
      `**Connectivity**`,
      `- Online: ${info.networkOnline ? 'Yes' : 'No'}`,
      `- Network: ${info.networkType || 'Unknown'}`,
      ``,
      `**System**`,
      `- Language: ${info.language}`,
      `- Timezone: ${info.timezone}`,
      `- Container: ${info.container}`,
    ];
    return lines.join('\n');
  }
}

export default DeviceIntegration.getInstance();
