# Proposal

## Why

`opencode-use` tracks all session state (`cwd`, `env`, `worktree`, `agentsMd`) in a
plain in-process `Map` (`createSessionStore()` in `src/core.js`), documented in
`README.md` as "in-process only — it does not persist across opencode restarts."
In practice this causes a real, repeatedly-observed failure: after an opencode
server restart (or any event that causes the plugin process to re-initialize),
a session's `state.worktree` resets to `null`. If that session then calls
`use_clear`, the tool has no record that an owned worktree exists and reports
"Nothing to clear" even though the worktree is still registered with git and
present on disk — silently orphaning it.

opencode V2 plugins have access to `ctx.storage` — a durable, disk-backed,
per-plugin JSON key/value store (`get`/`set`/`remove`/`scan`) that survives
process restarts, confirmed against the current opencode V2 docs
(`https://opencode.ai/v2/docs/build/plugins/`,
`https://opencode.ai/v2/docs/build/plugins/migrate-v1`). This is a V2-only
capability — the legacy V1 runtime (`@opencode-ai/plugin`) has no equivalent.

An initial proposal to mirror the *entire* `SessionState` (including `env` and
`agentsMd`) into `ctx.storage` with lazy, on-`getState()` rehydration was
reviewed by `architect` and found to have material problems: three of the four
V2 hooks read the session `Map` directly and synchronously, never through
`getState()`, so lazy rehydration would not restore workdir injection, shell-env
injection, or the system-prompt context block after a restart; persisting raw
`env` values would put direnv-sourced secrets (AWS keys, tokens, DB URLs) into
plaintext JSON on disk indefinitely, with no filtering in the codebase for that
today; and an unvalidated rehydrated record can turn an operation that
succeeds today into a hard error (e.g. `use_worktree` requesting a different
path throws when `state.worktree` is stale-but-non-null). This proposal is
revised to a narrower, hardened scope that avoids all of these: **only worktree
ownership is persisted**, not the rest of session state.

## What Changes

- On the V2 runtime (`plugin.v2.js`) only: persist worktree ownership records
  — `{ path, owned, repoRoot }` — into `ctx.storage`, keyed by `sessionID`
  under a namespaced, schema-versioned key (e.g. `worktree/v1/<sessionID>`),
  written whenever `state.worktree` changes (created, reused, or cleared).
  `cwd`, `env`, `envSource`, and `agentsMd` are explicitly **not** persisted —
  they remain in-memory-only, as today; their loss on restart is an accepted,
  documented limitation, unchanged by this proposal.
- **Eager hydration at `setup()`**, not lazy-on-first-`getState()`: before
  registering any hook, scan `ctx.storage` for all persisted worktree records
  and populate the session `Map`'s `worktree` field for each `sessionID` found.
  This keeps `getState()` synchronous (no async ripple into the four tool
  bodies or the three hook consumers) and does not touch `cwd`/`env`, so it
  cannot degrade `resolveEnvSessionForShell`'s ambiguity ladder.
- **Ground-truth validation on hydration**: every rehydrated record is checked
  against `git worktree list --porcelain` (does the path still exist there,
  registered to the expected repo) before being trusted. A record that fails
  validation is dropped (treated as if it were never persisted) and its
  storage key is removed, rather than being surfaced as an active
  `state.worktree` that could cause `use_worktree`/`use_clear` to act on a
  path that no longer applies.
- `use_clear`'s owned-worktree removal continues to act on `state.worktree` as
  before; that field itself may now originate from a validated, rehydrated
  record rather than only from calls made within the current process — so a
  worktree created by an earlier process (before a restart) is still
  recognized as owned and removed from disk.
- **Retention**: the storage key for a session's worktree record is removed
  whenever `use_clear` clears the `worktree` field (owned or not), preventing
  unbounded key growth for sessions that clean up normally. Additionally, the
  key is removed when the *session itself* is deleted (via a `session.deleted`
  event on opencode V2's `ctx.event.subscribe()` stream) — this closes the
  remaining growth path for a session that is deleted without ever calling
  `use_clear`, since a deleted session's `sessionID` can never be reused to
  call `use_clear` again. Only the storage key is removed on session
  deletion — never the worktree on disk itself, since deleting a chat session
  does not imply the user wants an abandoned branch/worktree removed (this
  plugin lets a worktree be reattached from a new session). A key whose
  `session.deleted` event was itself missed (e.g. the plugin was disabled at
  the moment of deletion) is the one residual growth path left unsolved; no
  time-based sweep is added for it.
- **Capability detection, not assumption**: `ctx.storage` presence is checked
  (`typeof ctx.storage?.get === 'function'`, etc.) at `setup()`. If absent,
  the plugin degrades to today's in-memory-only behavior with no persistence
  and no error — unlike the existing `Bun.$` check, this one must not throw.
- V1 (`plugin.v1.js`) is unchanged: it keeps the current in-memory-only
  behavior, since V1 has no equivalent storage API. `README.md`'s "Session
  State" section is updated to describe worktree-ownership persistence as a
  V2-only exception to the "in-process only" statement — `cwd`/`env`/
  `agentsMd` remain accurately described as in-process-only for both runtimes.
- **Out of scope, named as a known limitation**: `use_worktree`'s existing
  "already exists → `owned: false`" reuse heuristic (core.js lines ~669–707)
  is unchanged. Persistence restores ownership only for the *same* `sessionID`
  that originally created the worktree; a *different* session (a new
  `sessionID` after a restart, or reused by a different agent turn) reusing an
  already-registered worktree via `create: false` still records `owned:
  false` and is not fixed by this change. A follow-up change would be needed
  to close that gap (e.g. by making ownership itself git-native rather than
  plugin-storage-native).

## Capabilities

### New Capabilities

- `worktree-ownership-persistence`: defines how V2 worktree-ownership records
  are persisted to and rehydrated from `ctx.storage` — key scheme, write
  timing, eager-hydration-at-`setup()` sequencing, ground-truth validation
  against `git worktree list`, retention on `use_clear` and on `session.deleted`,
  and graceful degradation when `ctx.storage` is unavailable.

### Modified Capabilities

- `worktree-cleanup`: the "Owned Worktree Removal" requirement's `GIVEN`
  preconditions are widened to include a worktree whose ownership record was
  rehydrated (and validated) from persisted storage after a process restart,
  not only one created earlier in the same in-memory session.

## Impact

- `src/core.js` — gains `createWorktreePersistence(storage)`, a factory over a
  raw JSON key/value adapter (`get`/`set`/`remove`/`scan`, structurally
  identical to `ctx.storage`) that owns the key scheme, record shape,
  hydration, and git-validation logic — core stays host-agnostic per
  design.md D1 (it imports no host API; a key prefix is a string constant,
  not a host coupling). `executeUseWorktree` and `executeUseClear` call
  `deps.persistWorktree.save(...)` / `.remove()` (bound per-session by
  `forSession(sessionID)`) after mutating `state.worktree`.
- `src/plugin.v2.js` — capability-detects `ctx.storage`, builds the
  persistence factory, awaits `hydrate()` before registering any tool or
  hook, binds `deps.persistWorktree` per tool call via `forSession`, and
  starts a background `ctx.event.subscribe()` loop that removes a session's
  storage key on `session.deleted`.
- `src/plugin.v1.js` — no functional change (continues passing no adapter).
- `test/` — new test coverage for hydration-and-validation-after-restart
  (using a fake in-memory storage adapter to simulate a second process over
  the same backing data), storage-unavailable fallback, retention on
  `use_clear`, and retention on a simulated `session.deleted` event; existing
  `use-clear-worktree-cleanup.test.js` extended for the widened precondition.
- `README.md` — "Session State" section updated to describe the V2-only
  worktree-ownership exception; `cwd`/`env`/`agentsMd` wording unchanged.
- No new dependencies. No change to any tool's public parameters or schema.
