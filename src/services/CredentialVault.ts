import { isTauri } from '../platform';

const SERVICE = 'gia-cowork';
const memoryVault = new Map<string, string>();

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

class CredentialVault {
  async get(providerId: string): Promise<string> {
    if (memoryVault.has(providerId)) return memoryVault.get(providerId) ?? '';
    if (!isTauri()) return '';
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
    }
  }

  async delete(providerId: string): Promise<void> {
    memoryVault.delete(providerId);
    if (isTauri()) {
      await invoke('credential_delete', { service: SERVICE, account: providerId });
    }
  }

  async load(providerIds: string[]): Promise<Record<string, string>> {
    const entries = await Promise.all(providerIds.map(async (id) => [id, await this.get(id)] as const));
    return Object.fromEntries(entries.filter(([, value]) => value));
  }
}

export default new CredentialVault();
