import { isTauri } from '../platform';

const SERVICE = 'gia-cowork';
const memoryVault = new Map<string, string>();

/**
 * Browser-session vault (non-Tauri only).
 *
 * On desktop, keys belong in the OS keychain (Rust `credential_set`) and the
 * persisted store deliberately strips apiKey — the right security story. But
 * the plain browser preview had NO persistence at all: a key entered in the
 * UI worked until the page reloaded and then vanished (the store blanks keys,
 * this vault was memory-only), leaving the status pill stuck on "Awaiting a
 * key" and every send failing. sessionStorage fixes the session without
 * weakening the desktop story: per-tab, survives reloads, dies with the tab,
 * never touches persistent disk. Keys in a web browser were never safe
 * storage; sessionStorage is a scoping improvement over memory-only, not a
 * claim otherwise.
 */
const SESSION_VAULT_PREFIX = 'gia-key:';

function sessionGet(providerId: string): string {
  try {
    return sessionStorage.getItem(SESSION_VAULT_PREFIX + providerId) ?? '';
  } catch {
    return ''; // storage unavailable (privacy mode) — degrade to memory-only
  }
}

function sessionSet(providerId: string, value: string): void {
  try {
    if (value) sessionStorage.setItem(SESSION_VAULT_PREFIX + providerId, value);
    else sessionStorage.removeItem(SESSION_VAULT_PREFIX + providerId);
  } catch {
    /* degrade to memory-only */
  }
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

class CredentialVault {
  async get(providerId: string): Promise<string> {
    if (memoryVault.has(providerId)) return memoryVault.get(providerId) ?? '';
    if (!isTauri()) {
      const value = sessionGet(providerId);
      if (value) memoryVault.set(providerId, value);
      return value;
    }
    const value = await invoke<string | null>('credential_get', { service: SERVICE, account: providerId });
    const key = value ?? '';
    if (key) memoryVault.set(providerId, key);
    return key;
  }

  async set(providerId: string, value: string): Promise<void> {
    const key = value.trim();
    if (!key) {
      await this.delete(providerId);
      return;
    }
    memoryVault.set(providerId, key);
    if (isTauri()) {
      await invoke('credential_set', { service: SERVICE, account: providerId, secret: key });
    } else {
      sessionSet(providerId, key);
    }
  }

  async delete(providerId: string): Promise<void> {
    memoryVault.delete(providerId);
    if (isTauri()) {
      await invoke('credential_delete', { service: SERVICE, account: providerId });
    } else {
      sessionSet(providerId, '');
    }
  }

  async load(providerIds: string[]): Promise<Record<string, string>> {
    const entries = await Promise.all(providerIds.map(async (id) => [id, await this.get(id)] as const));
    return Object.fromEntries(entries.filter(([, value]) => value));
  }
}

export default new CredentialVault();
