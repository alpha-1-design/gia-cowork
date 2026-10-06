/**
 * `__APP_VERSION__` is replaced with a string literal at build time by the
 * `define` entry in vite.config.ts. It must be a bare identifier reference so
 * Vite's substitution actually reaches it.
 */
declare const __APP_VERSION__: string;

interface Window {
  __APP_VERSION__?: string;
}
