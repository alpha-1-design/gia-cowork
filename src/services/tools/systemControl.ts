import { z } from 'zod';
import { defineTool } from './defineTool';
import type { ToolResult } from './types';
import terminalService from '../TerminalService';

// ── System control (desktop only) ─────────────────────────────────────
//
// These give GIA real control over the host session via systemd-logind —
// the same stack the presence service already talks to. `system_lock` is
// safe to trigger from anywhere (including the phone, through Unimind).
// `system_unlock` is deliberately gated behind explicit local
// pre-authorization: no OS lets another device unlock a machine for a
// reason, and neither does GIA by default.

const LS_REMOTE_UNLOCK = 'gia:system:remoteUnlock';
const LS_FOLLOW_LOCK = 'gia:system:followLock';

/** Run a host command through the real terminal backend. */
async function run(cmd: string, timeout = 10_000): Promise<{ output: string; exitCode: number }> {
  const res = await terminalService.exec(cmd, undefined, undefined, timeout);
  return { output: (res.output || '').trim(), exitCode: res.exitCode };
}

/** Current session id for loginctl, or null if not on systemd-logind. */
async function sessionId(): Promise<string | null> {
  try {
    const res = await run('loginctl list-sessions --no-legend | awk \'{print $1; exit}\'', 5000);
    return res.exitCode === 0 && res.output ? res.output : null;
  } catch {
    return null;
  }
}

/**
 * Whether the desktop session is idle (no input) for longer than
 * `thresholdMs`, per systemd-logind's own IdleHint. Returns null when
 * loginctl isn't available.
 */
export async function isDesktopIdle(thresholdMs = 180_000): Promise<boolean | null> {
  try {
    const sid = await sessionId();
    if (!sid) return null;
    const res = await run(`loginctl show-session ${sid} -p IdleHint -p IdleSinceHint`, 5000);
    if (res.exitCode !== 0) return null;
    const idleHint = /IdleHint=yes/.test(res.output);
    if (!idleHint) return false;
    const m = res.output.match(/IdleSinceHint=(\d+)/);
    if (!m) return true; // idle but no timestamp — treat as idle
    const sinceMs = Number(m[1]) / 1000;
    return Date.now() - sinceMs >= thresholdMs;
  } catch {
    return null;
  }
}

export function isRemoteUnlockEnabled(): boolean {
  try {
    return localStorage.getItem(LS_REMOTE_UNLOCK) === 'on';
  } catch {
    return false;
  }
}

export function setRemoteUnlockEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LS_REMOTE_UNLOCK, enabled ? 'on' : 'off');
  } catch { /* best-effort */ }
}

export function isFollowLockEnabled(): boolean {
  try {
    return localStorage.getItem(LS_FOLLOW_LOCK) === 'on';
  } catch {
    return false;
  }
}

export function setFollowLockEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LS_FOLLOW_LOCK, enabled ? 'on' : 'off');
  } catch { /* best-effort */ }
}

const systemLockTool = defineTool({
  id: 'system_lock',
  name: 'system_lock',
  description:
    'Lock this computer\'s session immediately (systemd-logind). Safe to trigger remotely — e.g. from the phone via Unimind when the user walks away.',
  execute: async (): Promise<ToolResult> => {
    try {
      const res = await run('loginctl lock-session');
      if (res.exitCode === 0) return { success: true, content: '🔒 Session locked.' };
      // Fallback for non-logind desktops.
      const fb = await run('xdg-screensaver lock', 5000).catch(() => ({ output: '', exitCode: 1 }));
      if (fb.exitCode === 0) return { success: true, content: '🔒 Session locked.' };
      return { success: false, content: '', error: `lock failed (loginctl exit ${res.exitCode}): ${res.output}` };
    } catch (e) {
      return { success: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
});

const systemUnlockTool = defineTool({
  id: 'system_unlock',
  name: 'system_unlock',
  description:
    'Unlock this computer\'s session. Only works if remote unlock has been explicitly pre-authorized by the local user (system_remote_unlock on) — by default it refuses, because unlocking a machine from another device without local consent is a security hole.',
  execute: async (): Promise<ToolResult> => {
    if (!isRemoteUnlockEnabled()) {
      return {
        success: false,
        content: '',
        error:
          'Remote unlock is not authorized. Turn on "Allow unlock from phone" in GIA Settings (or run system_remote_unlock on) on the desktop itself first.',
      };
    }
    try {
      const res = await run('loginctl unlock-session');
      if (res.exitCode === 0) return { success: true, content: '🔓 Session unlocked.' };
      return { success: false, content: '', error: `unlock failed (exit ${res.exitCode}): ${res.output}` };
    } catch (e) {
      return { success: false, content: '', error: e instanceof Error ? e.message : String(e) };
    }
  },
});

const systemRemoteUnlockTool = defineTool({
  id: 'system_remote_unlock',
  name: 'system_remote_unlock',
  description:
    'Authorize or forbid unlocking this computer from another device (the phone via Unimind). Default is off. Turn it on only if you understand the trade-off: anyone holding your paired phone can then unlock this machine.',
  input: z.object({ action: z.enum(['on', 'off', 'status']).default('status').describe('on, off, or status') }),
  execute: async ({ action }) => {
    const act = String(action || 'status').toLowerCase();
    if (act === 'on') {
      setRemoteUnlockEnabled(true);
      return { success: true, content: 'Remote unlock is now **allowed** — the phone can unlock this computer.' };
    }
    if (act === 'off') {
      setRemoteUnlockEnabled(false);
      return { success: true, content: 'Remote unlock is now **forbidden**.' };
    }
    return {
      success: true,
      content: `Remote unlock is ${isRemoteUnlockEnabled() ? '**allowed**' : '**forbidden**'} (default: forbidden).`,
    };
  },
});

const followLockTool = defineTool({
  id: 'unimind_follow_lock',
  name: 'unimind_follow_lock',
  description:
    'Auto-lock rule: when the phone reports the user is active on mobile while this computer sits idle (no input for a few minutes), GIA locks the session — "follow the user". on/off/status. Off by default.',
  input: z.object({ action: z.enum(['on', 'off', 'status']).default('status').describe('on, off, or status') }),
  execute: async ({ action }) => {
    const act = String(action || 'status').toLowerCase();
    if (act === 'on') {
      setFollowLockEnabled(true);
      return { success: true, content: 'Follow-lock is **on** — GIA will lock this computer when it senses you\'ve moved to your phone while it sits idle.' };
    }
    if (act === 'off') {
      setFollowLockEnabled(false);
      return { success: true, content: 'Follow-lock is **off**.' };
    }
    return {
      success: true,
      content: `Follow-lock is ${isFollowLockEnabled() ? '**on**' : '**off**'} (default: off).`,
    };
  },
});

export const systemControlTools = [systemLockTool, systemUnlockTool, systemRemoteUnlockTool, followLockTool];
