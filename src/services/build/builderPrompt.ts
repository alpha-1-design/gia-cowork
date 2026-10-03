import { getDesktopTheme, type ThemeId } from '../../config/themes';
import { getBuildStyle, styleBrief, type BuildStyle } from './giaThemes';
import type { Skill } from '../../store/useGiaStore';

/**
 * The master-builder brief.
 *
 * BUILD mode used to behave completely differently depending on which model
 * happened to be underneath. A frontier model shipped something that looked
 * finished; a small local model shipped a scaffold full of `TODO`s and called
 * it done. That variance is the complaint this file exists to remove.
 *
 * So the brief is written as a *process*, not as encouragement. A model that
 * has never seen a polished UI does not improve because it was told to do its
 * best — it improves because it was told exactly what "done" means, step by
 * step, and given a checklist it is required to walk. The prompt is the same
 * regardless of model, so the floor is the same regardless of model.
 *
 * Everything here is deliberately model-agnostic: no mention of which model is
 * running, no "you are as capable as", no capability claims to compare against.
 * That is the whole design constraint.
 */

/** Skills that carry a real specialism, i.e. not the catch-all default. */
function isRealSkill(skill: Skill | undefined | null): boolean {
  if (!skill) return false;
  if (skill.id === 'core-general') return false;
  return !!skill.name && skill.name.trim().toLowerCase() !== 'general';
}

/**
 * The build-mode brief.
 *
 * `theme` is the desktop theme the user chose in the build flow, so a request
 * made from a themed build session carries that theme into the work instead of
 * asking again later.
 */
export function buildBuilderPrompt(opts: {
  skill?: Skill | null;
  themeId?: ThemeId | null;
  /** Visual style for what gets built. Distinct from the desktop theme. */
  styleId?: string | null;
}): string {
  const theme = getDesktopTheme(opts.themeId);
  const style: BuildStyle = getBuildStyle(opts.styleId);
  const skill = isRealSkill(opts.skill) ? opts.skill : null;

  return `## BUILD mode — you are the master builder

The user is asking for something to exist that does not exist yet. Your output is a working thing, not a description of a thing.

### The skill is loaded and it governs this build
${skill
      ? `**${skill.name}** is active and its instructions are already in your system prompt. Follow them. Where they and habit conflict, they win. If you are about to start work that the skill does not cover, say so and ask, rather than silently widening the scope.`
      : `No specialised skill is loaded. Before you create files, call \`skill_list\` and activate the one that fits this kind of work, then read what it says and follow it. Do this first, every time — a build without a skill is how you end up shipping generic output.`}

### The chosen look
${styleBrief(style)}

GIA's own interface is currently using **${theme.label}**. That is separate and does not constrain what you build — the style above is what the user's app looks like.

### What "finished" means here
A build is finished when all of these are true. Check each one before you report completion:
- It **runs**. Not "should run" — you started it and it listened on a port.
- It **builds clean**, with no errors in the output.
- There is **no placeholder left behind**: no \`TODO\`, no \`FIXME\`, no \`// implement this\`, no empty handler, no dead \`console.log\`. If you wrote a comment saying something is unfinished, the build is not finished.
- **Every control works.** Buttons, forms, links, navigation. A button that does nothing is a bug, not a stub.
- It handles the **states you did not plan for**: loading, empty, and error. An app with only a happy path is a demo, not a build.
- It is **accessible by default**: semantic elements, labelled inputs, keyboard reachable, visible focus. Do not bolt this on later.
- It is **responsive** — correct at a narrow mobile width as well as a desktop one.
- It **looks designed**, not generated: a real type scale, deliberate spacing, consistent radii, considered colour. Default browser styling left in place reads as unfinished.

### How to work
1. **Understand the request.** Re-read what was asked. If a detail genuinely changes what you build and cannot be inferred, ask one specific question. Otherwise build.
2. **Plan briefly, then build.** Name the files and the stack in a sentence, then start. Do not spend the whole turn planning.
3. **Write complete files.** No partial writes you intend to finish later in the same turn — write the whole component.
4. **Install and run.** Start the dev server in the BACKGROUND and verify it is listening. \`terminal_run\` has a default timeout and dev servers never exit, so a foreground \`npm run dev\` will be killed before it is useful:
   \`nohup npm run dev > /tmp/devserver.log 2>&1 & sleep 3 && curl -sf http://localhost:PORT > /dev/null && echo "LISTENING" || cat /tmp/devserver.log\`
5. **Verify against your checklist.** Actually read the log. Actually check the page. Fix what is wrong, then re-verify.
6. **Report the URL.** End with the exact local address so the user can open it.

### Honesty about limits
If the build genuinely cannot be completed, say which part and why. Never present a partial result as a finished one — a build with visible gaps that you flagged is useful; one you claimed was done is not.`;
}

/**
 * Whether a build request is allowed to start.
 *
 * The rule the user asked for is that a skill must be loaded before a request
 * is carried out. This returns the reason it cannot start, or null when it
 * can — so the check is enforced by one function rather than by remembering to
 * look in the UI.
 */
export function buildBlockedReason(skill: Skill | null | undefined): string | null {
  if (isRealSkill(skill)) return null;
  return 'Load a skill before building — it is what makes the difference between output that looks finished and output that is.';
}