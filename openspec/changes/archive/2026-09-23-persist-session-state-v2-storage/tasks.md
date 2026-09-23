# Tasks

## 1. Core persistence primitives (`src/core.js`)

- [x] 1.1 Export `HYDRATION_TIMEOUT_MS` (5000) and the `WorktreeRecord` shape (`schema`, `sessionID`, `path`, `branch`, `repoRoot`, `owned`, `createdAt`) as documented JSDoc typedefs; verify `node --check src/core.js` passes
- [x] 1.2 Implement `createWorktreePersistence(storage)`: capability-detects all four methods (`get`/`set`/`remove`/`scan`) on `storage`, returns `null` if any is missing or `storage` is absent; verify a unit test asserts `null` for `undefined`, `{}`, and a partial adapter
- [x] 1.3 Implement the key scheme `worktree/v1/<sessionID>` as an internal helper (e.g. `worktreeKey(sessionID)`); verify a unit test asserts the exact key string
- [x] 1.4 Implement `forSession(sessionID)` returning `{ save(record), remove() }`, wrapping every underlying `storage` call so a rejection is caught and logged, never thrown to the caller; verify a unit test with a fault-injecting fake storage confirms `save`/`remove` resolve (not reject) on a storage failure
- [x] 1.5 Implement per-`sessionID` FIFO write serialization inside the persistence factory (a `Map<sessionID, Promise>` chain, entries dropped once settled); verify a unit test issues two interleaved `save`/`remove` calls for the same session and asserts the underlying storage sees them in issue order
- [x] 1.6 Export `isSamePath(a, b)` from `lib.js`, built on the existing private `realpathBestEffort` (do not duplicate its logic); verify a unit test covers an identical path, a symlinked-equivalent path, and a genuinely different path

## 2. Hydration and ground-truth validation (`src/core.js`, `src/lib.js`)

- [x] 2.1 Implement `hydrate({ sessions, $, log }, persistence)`: `scan({ prefix: 'worktree/v1/' })` (looping on `next` for pagination), validate each record's shape (`schema`/`path`/`repoRoot`/`owned` present and correctly typed) and `remove` any structurally invalid record; verify a unit test covers a malformed record being dropped and removed
- [x] 2.2 Group valid records by `repoRoot` and, per distinct root, call `listWorktrees($, repoRoot)` via `Promise.allSettled`; on a rejected result, drop and remove every record for that root; verify a unit test with two distinct repo roots (one readable, one deleted) confirms only the readable root's valid records are restored
- [x] 2.3 For each `listWorktrees` result, match a record's `path` (via `isSamePath`) and `branch` against a returned entry; on match, set `getState(sessionID).worktree = { path, owned }`; on no match, drop and remove the record; verify unit tests cover a matched restore, a path-only mismatch (worktree gone), and a branch mismatch (path re-registered under a different branch)
- [x] 2.4 Bound the whole `hydrate()` call with `HYDRATION_TIMEOUT_MS` via `Promise.race`; a record not validated within the budget is left un-restored and its persisted copy is NOT removed; wrap the entire function body in `try`/`catch` so it never rejects; verify a unit test with an artificially slow `listWorktrees` confirms hydration completes within the timeout, restores nothing for that repo, and leaves its keys intact
- [x] 2.5 Log one summary line per hydration run (`restored`/`dropped`/`skipped` counts); verify a unit test asserts the log call shape

## 3. Write-site integration (`src/core.js`)

- [x] 3.1 In `executeUseWorktree`, after each of the four `state.worktree = …` assignment sites (fresh creation, existing-branch recovery, and both `already exists` reuse returns), `await deps.persistWorktree?.save({ path, branch, repoRoot: root, owned, schema: 1, createdAt: new Date().toISOString() })` before `applyDirectoryChange` runs; verify existing `worktree-branch-reuse.test.js` and new tests confirm the save happens before the tool returns and before any further git/filesystem work
- [x] 3.2 On a `save()` failure (captured, not thrown — persistence layer already catches per 1.4), append a note via `withNotes` disclosing that the ownership record could not be persisted and will not survive a restart, without failing the tool call; verify a unit test with a fault-injecting fake storage confirms the tool still returns its normal success message plus the disclosure note
- [x] 3.3 In `executeUseClear`, at the single `state.worktree = null` site, `await deps.persistWorktree?.remove()` after a successful `git worktree remove` (or after the not-owned/force-cleared branches, matching every path that nulls `state.worktree`); verify a unit test confirms the persisted key is absent after `use_clear` in each of: owned-removed, not-owned-reference-cleared, and force-cleared-unregistered-path
- [x] 3.4 Confirm a failed `git worktree remove` (dirty worktree, no `force`) leaves the persisted record intact (no `remove()` call on the throw path); verify a unit test using the existing dirty-worktree scenario, now additionally asserting the persisted key still exists after the rejection

## 4. V2 host wiring (`src/plugin.v2.js`)

- [x] 4.1 At `setup(ctx)`, after `createSessionStore()` and before `ctx.tool.transform(...)`, capability-detect `ctx.storage` and build `createWorktreePersistence(ctx.storage)`; verify a unit test with a stubbed `ctx` lacking `storage` confirms `setup()` completes without throwing
- [x] 4.2 `await persistence?.hydrate({ sessions, $, log })` before any `ctx.tool.transform`/`ctx.tool.hook`/`ctx.shell.hook`/`ctx.session.hook` call; verify a unit test confirms hydration completes (and `sessions` is populated) strictly before the tool registration call is observed by a spy
- [x] 4.3 Bind `deps.persistWorktree` per tool call via `persistence?.forSession(toolCtx.sessionID)` inside each of the four tool `execute` closures (only `use_worktree`'s and `use_clear`'s bodies use it; the others pass it through inertly via shared `deps` or omit it — match whatever keeps `deps` construction simplest without dead code); verify a `plugin-v2-conformance.test.js` addition confirms a V2 `use_worktree` → restart-simulated-fresh-store → `use_clear` sequence removes the worktree from disk
- [x] 4.4 Extend the existing `ctx.event.subscribe({ signal: abortController.signal })` loop (currently handling only `mcp.tools.changed`) with an additional branch: on `event?.type === 'session.deleted'`, `await persistence?.forSession(event.sessionID).remove()` inside a `try`/`catch` that only logs on failure; do not create a second subscription or a second `AbortController`; verify a unit test with a stubbed `ctx.event.subscribe()` async-iterable confirms a `session.deleted` event removes exactly that session's storage key and no others, while an interleaved `mcp.tools.changed` event still triggers `ctx.tool.reload()` as before
- [x] 4.5 Confirm no new disposer wiring is needed: the existing `abortController.abort()` call in `setup()`'s returned cleanup function already stops this loop, so the `session.deleted` branch stops too; verify a unit test confirms no event is processed by either branch after the disposer runs

## 5. Test infrastructure (`test/helpers.js`)

- [x] 5.1 Implement `makeFakeStorage(backing = new Map())` returning `{ storage, backing }`, with an async `get`/`set`/`remove`, and a `scan({ prefix, after, limit })` that returns prefix-filtered, key-ordered, paginated entries; `set()` JSON round-trips its value; verify a unit test exercises pagination (`next`) across a `limit` boundary
- [x] 5.2 Implement `makeFailingStorage(backing, { failOn: [...] })` wrapping `makeFakeStorage` to reject specific methods on demand; verify a unit test confirms only the configured method(s) reject

## 6. Regression and new behavior tests (`test/`)

- [x] 6.1 New test: restart-then-`use_clear` removes a worktree owned by a prior "process" — construct a fresh `createSessionStore()` + fresh `createWorktreePersistence(storage)` over the *same* `backing` Map used by an earlier `use_worktree` call, simulating a second process; verify `use_clear` in the new store still removes the worktree from disk (the headline bug this change fixes)
- [x] 6.2 New test: a persisted record for a worktree that was manually removed from disk/git is dropped on hydration and not restored, and its key is removed from storage
- [x] 6.3 New test: a persisted record whose branch no longer matches the currently-registered branch at that path is dropped, not restored
- [x] 6.4 New test: hydration across two distinct `repoRoot`s only restores the valid one when the other's repository is unreadable
- [x] 6.5 New test: `ctx.storage` absent at V2 `setup()` — `use_worktree`/`use_clear` behave identically to the pre-change baseline (no error, no persistence attempted)
- [x] 6.6 Extend `test/use-clear-worktree-cleanup.test.js` (or add alongside it) to cover the new "owned worktree restored from a persisted record after a restart is removed normally" scenario from the `worktree-cleanup` delta spec
- [x] 6.7 New test: simulating a `session.deleted` event for a session with a persisted worktree ownership record removes exactly that session's storage key, leaves the worktree untouched on disk and in `git worktree list`, and does not affect any other session's persisted record
- [x] 6.8 New test: a `session.deleted` cleanup whose storage `remove()` rejects is caught and logged without throwing, and a subsequent `session.deleted` event for a different session is still processed by the same subscription loop
- [x] 6.9 Run the full existing suite (`npm test`) and confirm no regression in `worktree-branch-reuse.test.js`, `plugin-v2-conformance.test.js`, or any other existing file

## 7. Documentation

- [x] 7.1 Update `README.md`'s "Session State" section: state that on V2, worktree ownership (`path`, `branch`, `repoRoot`, `owned`) is persisted to `ctx.storage` and restored (after git validation) across restarts, and that the persisted record is also removed automatically when the owning session is deleted (not only on `use_clear`); state that `cwd`, `env`, and `agentsMd` remain in-process-only on both runtimes as before; verify the section reads correctly against the finalized behavior
- [x] 7.2 Scan `TOOL_TEXT.use_clear`/`TOOL_TEXT.use_worktree` in `src/core.js` for any wording that asserts state is purely in-memory/session-scoped and update if it would now be misleading on V2; verify by re-reading the final tool descriptions
