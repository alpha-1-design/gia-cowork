import { registerPlugin } from '@capacitor/core';
import { isTauri } from '../platform';

export interface GIAAlarmPlugin {
  setAlarm(options: { hour: number; minute: number; label?: string }): Promise<{ success: boolean; method: string; alarmId: number }>;
  cancelAlarm(options: { alarmId: number }): Promise<void>;
}

// Desktop alternative to a native Android alarm: schedule a reminder that fires
// a system Notification at the requested time. Real OS-level alarms would need a
// Tauri scheduler command, but this makes the feature work on desktop today.
function desktopAlarmPlugin(): GIAAlarmPlugin {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;

  const fire = (label?: string) => {
    const title = label ? `⏰ ${label}` : '⏰ GIA alarm';
    try {
      if (typeof Notification !== 'undefined') new Notification(title);
    } catch {
      /* notifications unavailable in this context */
    }
  };

  return {
    async setAlarm({ hour, minute, label }) {
      const now = new Date();
      const target = new Date();
      target.setHours(hour, minute, 0, 0);
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
      const delay = target.getTime() - now.getTime();
      const id = nextId++;
      const timer = setTimeout(() => {
        fire(label);
        timers.delete(id);
      }, delay);
      timers.set(id, timer);
      return { success: true, method: 'desktop-timer', alarmId: id };
    },
    async cancelAlarm({ alarmId }) {
      const t = timers.get(alarmId);
      if (t) {
        clearTimeout(t);
        timers.delete(alarmId);
      }
    },
  };
}

const GIAAlarm = registerPlugin<GIAAlarmPlugin>('GIAAlarm', {
  web: () => {
    if (isTauri()) return Promise.resolve(desktopAlarmPlugin());
    return import('./GIAAlarm.web').then(m => m.GIAAlarmWeb);
  },
});

export { GIAAlarm };
