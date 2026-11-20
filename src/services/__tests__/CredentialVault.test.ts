import { describe, it, expect, beforeEach, vi } from 'vitest';
import CredentialVault from '../CredentialVault';

/**
 * The browser-session vault. Desktop (Tauri) goes to the Rust keychain and is
 * covered by the desktop contract; here we own the non-Tauri path: sessionStorage
 * persistence across reloads, memory caching, and delete clearing both layers.
 */

let tauri = false;
const session = new Map<string, string>();

vi.mock('../../platform', () => ({
  isTauri: () => tauri,
}));

beforeEach(() => {
  tauri = false;
  session.clear();
  // jsdom/happy-dom sessionStorage is real; mirror it into our map for asserts.
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => { session.set(k, v); },
    removeItem: (k: string) => { session.delete(k); },
  });
});

describe('CredentialVault — browser session path', () => {
  it('set stores in memory and sessionStorage; get returns it in the same session', async () => {
    await CredentialVault.set('gemini', 'test-key-123');
    expect(await CredentialVault.get('gemini')).toBe('test-key-123');
    expect(session.get('gia-key:gemini')).toBe('test-key-123');
  });

  it('a NEW vault instance still finds the key — the reload survival guarantee', async () => {
    await CredentialVault.set('gemini', 'test-key-123');
    const fresh = await import('../CredentialVault');
    // Re-import gives the same module singleton; simulate reload by clearing
    // the module's memory via delete+set dance is not possible — instead verify
    // the session layer directly serves a key the memory layer never saw.
    expect(session.get('gia-key:openai')).toBeUndefined();
    session.set('gia-key:openai', 'restored-key');
    expect(await CredentialVault.get('openai')).toBe('restored-key');
  });

  it('delete clears both the memory and the session layer', async () => {
    await CredentialVault.set('gemini', 'test-key-123');
    await CredentialVault.delete('gemini');
    expect(await CredentialVault.get('gemini')).toBe('');
    expect(session.get('gia-key:gemini')).toBeUndefined();
  });

  it('set with an empty value deletes — the clear-key path', async () => {
    await CredentialVault.set('gemini', 'test-key-123');
    await CredentialVault.set('gemini', '  ');
    expect(await CredentialVault.get('gemini')).toBe('');
  });

  it('load returns only providers that have keys', async () => {
    await CredentialVault.set('gemini', 'k1');
    await CredentialVault.set('openai', 'k2');
    const loaded = await CredentialVault.load(['gemini', 'openai', 'anthropic']);
    expect(loaded).toEqual({ gemini: 'k1', openai: 'k2' });
  });
});
