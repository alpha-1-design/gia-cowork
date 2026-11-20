# FX-E final 4 — root causes, fixes, verification

Repo: gia-cowork. Scope: the last 4 failing tests across 3 files. No commits.

## 1. BotAvatar.test.tsx — 'prefers-reduced-motion disables ALL idle motion, even with animate=true'

**Diagnosis.** Two stacked fixture bugs, both in the test; the component is clean:

- motion-dom's `initPrefersReducedMotion()` queries `window.matchMedia("(prefers-reduced-motion)")` — **without** `: reduce`. The test stub answered `matches: reduce && query.includes('prefers-reduced-motion: reduce')`, i.e. `false` for the one query motion actually makes. Even with the stub armed, the hook saw "no preference".
- After fixing that, the test still failed: the suite relied on `vi.resetModules()` + a dynamic re-import of BotAvatar to get a fresh module. But vitest never re-evaluates **externalized node_modules deps**, so `motion-dom` stayed a single shared instance; its `prefersReducedMotion` cache had already been initialized by earlier tests in the file (real happy-dom matchMedia → `false`), and `hasReducedMotionListener.current === true` meant the init never re-ran. Module state is cached by design in the library (it does register a `change` listener, so the component does read the real preference at render time — no product bug).

**Fix** (`src/components/avatars/__tests__/BotAvatar.test.tsx`): stub now matches the `prefers-reduced-motion` family prefix; `beforeEach`/`afterEach` reset `motion-dom`'s exported `prefersReducedMotion.current = null` and `hasReducedMotionListener.current = false` (typed exports), which makes the next `useReducedMotion()` re-init against the stub — exactly what a fresh page load does. Dropped the ineffective `resetModules`/dynamic-import machinery. Determinism pin, byte-identical SVG, and the `animate={false}` off-switch tests untouched and passing.

## 2+3. buildGiaSystem.test.ts — the two governor trim-ORDER boundary tests

**Diagnosis.** Three independent wiring bugs; the governor's order (table first, then examples) is correct:

- **Fixture shape:** the mocked model entry used `context: { length: 8000 }`. The real store (`ModelOption.context?: string`, e.g. `'200k'`) never stores that shape, and `parseContextWindow` accepts `string | number` only — `String({length:8000})` → `'[object object]'` → `null` → the governor's `budgetChars` was `Infinity`, so nothing was ever trimmed. The tests were asserting trim behavior at a window the fixture never actually delivered.
- **Probe collision:** both tests probed for `'| \`web_search\` | Search the web'`. The deferred compact index *legitimately still lists* `web_search` with a row starting with that exact prefix, so the probe matched even when the hand table was dropped — the binary search in test 3 could never converge and the negative assertion in test 2 was unsatisfiable. Swapped to the hand table's unique header `| Tool | What it does | Args | Notes |` (compact index ends in `Category`).
- **Boundary arithmetic:** test 3's binary search leaves the provider mock at the *last evaluated mid* — by the loop's convergence that mid is `lo`, the largest window where the table is already dropped — so the final `buildGiaSystem()` ran on the trimmed side of the boundary. Now `setContext(hi)` rebuilds exactly at the converged boundary; the slack between `budget(hi)` and `estimate+table` is provably ≤ 3 chars (budget steps by 4), far below the examples block's length, so the examples are necessarily trimmed there while the table is not.

Also: the "desktop execution paragraph survives trimming" assertion targets the `isTauri()` branch, but the test env is the web branch — armed `window.__TAURI_INTERNALS__` for that one assertion (same pattern as PresenterMode.test.ts), deleted in `finally`.

**Fix:** test-only, in `src/services/__tests__/buildGiaSystem.test.ts` (`fixture: context: '8000'` / `String(ctxLength)`; header probe; rebuild at `hi`; Tauri flag). No product-side change to the governor; contract (table before examples, notice names what was cut) intact — both tests now genuinely pin the order at the real boundary.

## 4. deferredTools.test.ts — 'finds the database tool for a SQL query'

**Diagnosis (product bug in scoring, measured with a scratch harness against the real 296-tool registry):** `db_query` ranked **45th of 296** scored tools and fell off the 12-result page. The scoring took each query token *with duplicates* and did raw substring matching: `"a"` appears twice in the query, so every id containing the letter "a" scored +6 and every description with "a" +2 (neura_query scored 16 on pure stopword noise; 296 of 296 tools scored > 0). `db_query` — whose id contains no "a" — scored 7 and drowned.

**Fix** (`src/services/tools/deferred.ts`, `searchToolSchemas`): dedupe query tokens and match whole words (id/category/description word lists) with a minimum-weight prefix fallback (`"term"` → `"terminal"`) so recall doesn't collapse. Weights unchanged (id 3 / category 2 / description 1; ties alphabetical). Measured ranks after the fix: `db_query` 1st, `messaging_send` 2nd, `neura_query` 1st for its exact-id query, `web_search` 1st, `ssh_connect` 1st — all other tests in the file pass unmodified.

## Verification

- `vitest run` on the three files: **3 passed (3), 76/76 tests** (BotAvatar 20, buildGiaSystem 37, deferredTools 19).
- `NODE_OPTIONS=--max-old-space-size=4096 node node_modules/typescript/bin/tsc -b --noEmit`: **exit 0** (single run, clean).
- Full suite not rerun (per budget); the 151 previously-green files were not touched except the three above.
- Scratch diagnostic files deleted; no temporary artifacts left in the repo.

## Product-side changes summary (the only one)

- `src/services/tools/deferred.ts — searchToolSchemas`: scoring hardened (deduped tokens, word-boundary matching with prefix fallback). Behavior change: stopword/substring noise no longer outranks real matches; result ordering for multi-word natural-language queries improves. `CORE_TOOL_IDS`, `DEFERRED_THRESHOLD`, index shape, prompt block, and the 12-result cap are untouched.
