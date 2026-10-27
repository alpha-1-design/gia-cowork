/**
 * The build-injected application version (see `vite.config.ts`).
 *
 * `__APP_VERSION__` is replaced with the literal from `package.json` at build
 * time. The fallback only matters in environments that do not run the Vite
 * define step (for example a bare test runner).
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : '0.0.0';
