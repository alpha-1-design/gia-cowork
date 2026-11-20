import { useEffect, useRef, useState, useCallback } from 'react';
import { useGiaStore } from '../store/useGiaStore';

/**
 * Patterns that look like credentials. Anything matching is never shown on
 * screen — the clipboard watcher once echoed the user's real API key into a
 * toast that stayed visible indefinitely.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bAIza[\w-]{20,}/,            // Google API key (legacy format)
  /\bAQ\.[\w-]{30,}/,            // Google API key (v2 format)
  /\bsk-[\w-]{16,}/,             // OpenAI-style
  /\bsk-or-[\w-]{10,}/,          // OpenRouter
  /\bgh[pousr]_[\w]{20,}/,       // GitHub tokens
  /\bxox[bpars]-[\w-]{10,}/,     // Slack tokens
  /\bAKIA[\w]{12,}/,             // AWS access key
  /\beyJ[\w-]+\.[\w-]+/,         // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY/, // PEM keys
  /\bBearer\s+[\w.-]{20,}/i,     // Auth headers
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some(p => p.test(text));
}

const SECRET_PLACEHOLDER = '[possible credential hidden — copied to clipboard]';

export function useClipboardMonitor() {
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [copiedIsSecret, setCopiedIsSecret] = useState(false);
  const lastClipboardRef = useRef('');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchingRef = useRef(false);

  useEffect(() => {
    if (!navigator.clipboard?.readText) return;

    const enabled = () => useGiaStore.getState().clipboardWatch;
    if (!enabled()) return;

    intervalRef.current = setInterval(async () => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      try {
        // Re-check every tick: the user can turn watching off mid-session.
        if (!enabled()) return;
        const text = await navigator.clipboard.readText();
        if (text && text !== lastClipboardRef.current && text.length > 20 && text.length < 5000) {
          lastClipboardRef.current = text;
          setCopiedIsSecret(looksLikeSecret(text));
          setCopiedText(text);
        }
      } catch {
        // Permission not granted or clipboard empty — silently skip
      } finally {
        fetchingRef.current = false;
      }
    }, 5000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const dismissCopied = useCallback(() => {
    setCopiedText(null);
  }, []);

  const pasteCopied = useCallback(() => {
    if (!copiedText) return;
    useGiaStore.getState().setPendingInput(copiedText);
    useGiaStore.getState().setModule('chat');
    setCopiedText(null);
  }, [copiedText]);

  return { copiedText, copiedIsSecret, dismissCopied, pasteCopied };
}
