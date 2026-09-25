# Tasks

## 1. Direnv status/allow primitives (`src/lib.js`)

- [x] 1.1 Add `DIRENV_TIMEOUT_MS` exported constant, mirroring the existing `HYDRATION_TIMEOUT_MS` convention.
- [x] 1.2 Implement pure `isDirenvStatusAllowed(status, envrcPath)` per D2; add `test/direnv-status.test.js` with the four pinned real-direnv fixtures (allowed / not-yet-allowed / denied / no-RC) plus a different-RC-path case and an unrecognised-shape case, all asserting the exact boolean per fixture. Verify it passes: `node --test test/direnv-status.test.js`.
- [x] 1.3 Implement `checkDirenvAllowed($, { anchorDir, envrcPath }, log)` per D2 (never throws, timeout-bounded, delegates to 1.2's predicate); extend `test/helpers.js` with `makeFakeDirenvShell({ status, exportJson, allow, hang })`; add the fail-closed matrix (non-zero exit, `ENOENT`, timeout via the hanging shell, empty stdout, malformed JSON) to `test/direnv-status.test.js`, asserting `false` and no throw in every case. Verify: `node --test test/direnv-status.test.js`.

## 2. Export/load extraction (`src/lib.js`, `src/core.js`)

- [x] 2.1 Extract `runDirenvExportJson($, dir)` into `src/lib.js` per D4 — exactly today's run/trim/parse/null-filter/`String()` sequence, throwing the raw `$` rejection unwrapped.
- [x] 2.2 Update `executeUseDirenv` in `src/core.js` to call `runDirenvExportJson`, keeping its existing try/catch translation (blocked, `ENOENT`, fallback) and both return strings verbatim. Verify: existing `use_direnv` tests pass unmodified (`node --test test/*.test.js` filtered to direnv-related files, or the full suite).
- [x] 2.3 Implement private `loadDirenvEnvSafe($, dir, log)` in `src/lib.js` per D4 — never-throwing, timeout-bounded wrapper around 2.1 returning the env delta or `null`. Add unit coverage in `test/direnv-autoload.test.js` (new) for success, failure, and timeout cases.

## 3. `resolveRepoContext` and `applyDirectoryChange` auto-load (`src/lib.js`)

- [x] 3.1 Extend `resolveRepoContext` to return `{ agentsMd, envrcPath, notes }`, dropping the `.envrc` note (D1); ensure the `catch` path returns `envrcPath: null`; keep it invoking no `direnv` subprocess. Update `test/context-autoload.test.js`: remove the two `.envrc`-note assertions from this layer, add an `envrcPath`-returned assertion, and confirm "detection never invokes a direnv subprocess" still passes at this layer.
- [x] 3.2 Extend `applyDirectoryChange` with a fifth `options = {}` parameter (`autoLoadEnv` default `false`) per D5's stage order and note table; on load failure leave `state.env`/`state.envSource` untouched; a no-op (`changed === false`) call must still run zero direnv subprocesses. Add `test/direnv-autoload.test.js` (new) covering the full `autoLoadEnv` × `.envrc`-present × allowed × export-ok/failed matrix, note-text assertions per D5's table, the no-op-runs-nothing case, and the D3 anchor-directory assertion (plant `.envrc` at an ancestor, assert every direnv invocation received `dirname(envrcPath)` as cwd). Verify: `node --test test/context-autoload.test.js test/direnv-autoload.test.js`.
- [x] 3.3 Update all existing call sites of `applyDirectoryChange` in `src/lib.js`/`src/core.js` (six today) to pass an explicit `{ autoLoadEnv: ... }` per the design's host-wiring/worktree tables (`use_workdir` → `true`; worktree reuse/idempotent paths → `true`; see group 5 for the worktree-create path).
- [x] 3.4 Add or extend a source-guard test asserting (a) no `state.cwd =` assignment exists outside `applyDirectoryChange`/`executeUseClear` in `src/*.js`, and (b) every `applyDirectoryChange(` call site in `src/*.js` passes an explicit fifth argument — each failure names the offending file and line. Verify: `node --test` on the guard file.

## 4. Session-start initialization and V2 session-move (`src/core.js`, `src/plugin.v1.js`, `src/plugin.v2.js`)

- [x] 4.1 Implement pure `resolveSessionLocation(location)` in `src/core.js` per D6 (returns `null` for `workspaceID`-bearing or directory-less input; otherwise `join(directory, subpath ?? '')`).
- [x] 4.2 Implement `initSessionDirectory(state, resolvedDir, deps, { autoLoadEnv })` in `src/core.js` per D6 — never throws, skips a missing/non-directory path, skips when `state.cwd` is already set (race guard), routes through `applyDirectoryChange`, never assigns `state.cwd` itself, logs notes instead of returning them. Add `test/session-init.test.js` (new) covering `resolveSessionLocation`'s four cases and `initSessionDirectory`'s skip/race-guard/never-auto-loads-env/routes-through-choke-point behaviors. Verify: `node --test test/session-init.test.js`.
- [x] 4.3 Add a new `event` hook to `src/plugin.v1.js` (none exists today) with a `session.created` branch reading `event.properties.info.directory`, calling `initSessionDirectory` with `autoLoadEnv: false`, wrapped so it can never reject on a malformed payload. Add `test/plugin-v1-events.test.js` (new): `session.created` sets `state.cwd` and loads AGENTS.md without env; a malformed payload is swallowed; assert no `session.moved` branch exists. Verify: `node --test test/plugin-v1-events.test.js`.
- [x] 4.4 Add `session.created` (`autoLoadEnv: false`) and `session.moved` (`autoLoadEnv: true`) branches to the existing `ctx.event.subscribe` loop in `src/plugin.v2.js`, ahead of the `mcp.tools.changed` check, each reading `event.data.location` via `resolveSessionLocation` and skipping on `null`; leave the existing `session.deleted`/reload branches unaffected. Extend `test/plugin-v2-conformance.test.js`: fake `ctx.event.subscribe` emitting `session.created`/`session.moved` (with and without `workspaceID`, and with a `subpath`); assert `state.cwd` set, created never auto-loads env while moved does, a `workspaceID` payload is skipped, and existing `session.deleted`/`mcp.tools.changed` branches still fire. Verify: `node --test test/plugin-v2-conformance.test.js`.

## 5. Worktree envrc auto-trust (`src/lib.js`, `src/core.js`)

- [x] 5.1 Implement `maybeAutoTrustWorktreeEnvrc($, { repoRoot, worktreePath }, log)` in `src/lib.js` per D7 — TOCTOU-safe fresh reads, directory-level-only comparison (no upward search), ordered bytes-compare → root-allowed-check → `direnv allow` → post-allow re-read verification; never throws; returns `{ notes, contentVerified }`.
- [x] 5.2 Implement `applyDirectoryChangeForWorktree($, state, resolvedDir, log, { repoRoot, created })` in `src/lib.js` per D7 — wraps (never bypasses) `applyDirectoryChange`; `created !== true` delegates directly with `{ autoLoadEnv: true }`; `created === true` runs 5.1 first, then delegates with `autoLoadEnv` false only on post-allow mismatch; returns trust notes ahead of change notes.
- [x] 5.3 Rewire `executeUseWorktree` in `src/core.js` so only the two create-path success returns (primary return and the "existing branch checked out" recovery return) use `applyDirectoryChangeForWorktree` with `created: true` and the already-resolved `repoRoot`; the two reuse returns and the idempotent same-path return keep calling `applyDirectoryChange` directly with `{ autoLoadEnv: true }`.
- [x] 5.4 Add `test/worktree-envrc-trust.test.js` (new): real temp repo plus real `git worktree add`, fake direnv — identical+allowed root `.envrc` triggers `direnv allow` against the worktree file and auto-loads env; differing bytes → no allow; root not allowed → no allow; reuse path and idempotent path → no allow; `allow` failing → note, no throw; post-allow re-read mismatch → warning note and no env load; assert the TOCTOU read/allow ordering via the fake shell's call log. Verify: `node --test test/worktree-envrc-trust.test.js`.

## 6. Tool descriptions and documentation

- [x] 6.1 Update `use_workdir` and `use_worktree` tool descriptions in `TOOL_TEXT` (`src/core.js`) to describe conditional auto-load (allowed → loaded; not allowed → suggestion only) and, for `use_worktree`, the create-path auto-trust with its residual-risk caveat.
- [x] 6.2 Update `README.md`'s `.envrc` handling line (currently "detect, never execute") to describe the new conditional auto-load behavior and the V2-only session-move listener.
- [ ] 6.3 After `openspec archive` completes (not before — the main spec must stay untouched pre-archive), edit `openspec/specs/context-autoload/spec.md`'s `## Purpose` paragraph to drop "without ever executing it automatically" and describe the conditional auto-load behavior. Verify: re-read the file and confirm the paragraph no longer contradicts the merged requirements.

## 7. Full verification and review

- [x] 7.1 Run the full test suite (`npm test` per `package.json`'s script, or `node --test` across `test/`) and confirm all tests pass, including every new file added above.
- [x] 7.2 Run `node --check` on all three `src/*.js` files (per the project's existing test script) and fix any syntax/lint issue.
- [x] 7.3 Self-review the full diff for duplication, code smells, overengineering, and redundant comments per the `refactor` skill's checklist; fix inline or record an explicit one-line reason for anything left as-is.
- [x] 7.4 Spawn `code-reviewer` against `proposal.md` → delta `specs/` → diff; resolve every `[BLOCKER]`; explicitly accept or reject every `[WARNING]` with a stated reason.
