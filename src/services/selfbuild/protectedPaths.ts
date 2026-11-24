/**
 * The self-edit deny-list — the paths GIA is never allowed to change about
 * herself, wherever a write or command aims.
 *
 * Lives in its own dependency-free module because TWO layers need it and
 * one of them cannot import the other: SelfBuilder.ts imports Guardian's
 * reviewAction (brain/guardian.ts), so guardian.ts importing SelfBuilder
 * would create a cycle. This file imports nothing, so both sides depend on
 * it and neither on each other for this fact.
 *
 * Enforcement lives in three places, all reading THIS list:
 *   - SelfBuilder.validateStep() refuses to run a step that targets one
 *     of these paths;
 *   - brain/guardian.ts escalates any tool call whose args aim at one to
 *     high risk with authorization 'unknown' (advisory, pre-gate);
 *   - the Rust gate is the last line of defense for shell commands.
 *
 * Case-insensitive and separator-agnostic on purpose: a Windows path or an
 * absolute path must not dodge the list by spelling.
 */

export const PROTECTED_PATHS: RegExp[] = [
  // The Rust enforcement layer and anything in it.
  /(^|\/)src-tauri\//i,
  // AI-provider plumbing, if/when it appears.
  /(^|\/)src\/ai\//i,
  // The four Rust files self-edits must never reach, wherever they live.
  /(^|\/)gate\.rs$/i,
  /(^|\/)codex_client\.rs$/i,
  /(^|\/)terminal\.rs$/i,
  /(^|\/)desktop_fs\.rs$/i,
  // The TS enforcement layer.
  /(^|\/)src\/components\/trustgate\.tsx$/i,
  /(^|\/)src\/components\/codexapprovalbridge\.tsx$/i,
  /(^|\/)src\/services\/permissions\.ts$/i,
  /(^|\/)src\/services\/credentialvault\.ts$/i,
  /(^|\/)src\/services\/untrusted\.ts$/i,
  /(^|\/)src\/services\/brain\/guardian\.ts$/i,
  /(^|\/)src\/services\/brain\/toolrunner\.ts$/i,
  /(^|\/)src\/services\/brain\/toolschemas\.ts$/i,
  /(^|\/)src\/services\/brain\/permissiongate\.ts$/i,
  /(^|\/)src\/store\/usetruststore\.ts$/i,
  /(^|\/)src\/services\/system\/compliance\.ts$/i,
  /(^|\/)src\/services\/inputguardrails\.ts$/i,
];

/** True when a candidate path or command argument aims at a protected file. */
export function isProtectedPath(raw: string): boolean {
  if (!raw) return false;
  // Backslashes to slashes, drive letters and leading './'/ '/' stripped —
  // so `./src-tauri/x`, `C:\...\src-tauri\x` and `src-tauri/x` all match.
  const norm = raw
    .replace(/["']/g, '') // REVIEW-2 S3-12: `rm "src-tauri/src/gate.rs"` must match —
                          // a leading quote would defeat the (^|/) anchor
    .replace(/\\/g, '/')
    .replace(/^\./, '')
    .replace(/^\//, '')
    .toLowerCase();
  return PROTECTED_PATHS.some(re => re.test(norm));
}
