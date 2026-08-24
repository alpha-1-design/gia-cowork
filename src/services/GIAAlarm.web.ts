import type { GIAAlarmPlugin } from './GIAAlarm';

export class GIAAlarmWeb implements GIAAlarmPlugin {
  // Plain-web fallback: scheduling a real OS alarm is unavailable. The desktop
  // (Tauri) build uses a scheduled Notification instead, so this only runs in a
  // non-Tauri browser where we degrade gracefully.
  async setAlarm(options: { hour: number; minute: number; label?: string }): Promise<{ success: boolean; method: string; alarmId: number }> {
    return { success: false, method: 'unsupported-web', alarmId: -1 };
  }

  async cancelAlarm(options: { alarmId: number }): Promise<void> {
    void options;
    throw new Error('Alarm cancelling requires native Android app');
  }
}
