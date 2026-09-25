# Proposal

## Why

The plugin currently requires an explicit `use_direnv` call for every directory
whose `.envrc` should be loaded — even when the user has already run
`direnv allow` on that file — and never re-initializes at session start or on
a V2 `session.move`. This creates repeated manual work for a workflow the
user has already trusted. This change makes the direnv experience automatic
wherever it is already safe to do so, while never expanding beyond direnv's
own existing allow/deny trust model except in one narrow, explicitly
documented case.

This proposal was revised after an `architect` critique surfaced two
independently-verified, currently-accurate blockers and one real security
concern; each is resolved below by narrowing scope rather than proceeding as
originally drafted. See "Rejected / Descoped" for what was cut and why.

## What Changes

- **Auto-load on directory change**: `use_workdir` and `use_worktree` now
  auto-load the discovered `.envrc`'s environment via `direnv export json`
  whenever `direnv status --json` reports it is already allowed. If not yet
  allowed, behavior is unchanged (a note suggesting `use_direnv`/`direnv
  allow`). This never runs `direnv allow` itself. The allowed-check and the
  export both run anchored at the directory where discovery actually found
  the `.envrc` (which may be an ancestor of the resolved directory, bounded
  by the git root), not blindly at the resolved leaf directory, so the
  environment that loads is always the one discovery reported. Auto-load
  overwrites the session's current `state.env`/`state.envSource`; moving to a
  directory with no `.envrc`, or one that is not yet allowed, leaves the
  existing `state.env` untouched (matches today's manual `use_direnv`
  precedent — no implicit clearing).
- **Session-start auto-init (narrowed)**: on session creation — for every
  session, including subagent/child sessions — the plugin initializes
  `state.cwd` from the host's reported starting location (`join(directory,
  subpath ?? '')`, skipped entirely when the location carries a
  `workspaceID`, since the directory is then not a local filesystem path) and
  runs the same discovery pipeline used by `use_workdir`: AGENTS.md loading
  and the existing `.envrc`-found note. **It does NOT auto-load the
  environment at session start** — env auto-load (the point above) fires
  only in response to an explicit `use_workdir`/`use_worktree` call. This
  keeps the frequency of env-bearing sessions at today's baseline (a
  deliberate agent action), rather than making every session — including
  every concurrent one — env-bearing by default. This runs on both V1
  (`session.created` event, `properties.info.directory`) and V2
  (`session.created` event, `data.location`). Initialization is best-effort
  and asynchronous relative to the very first turn; it is not guaranteed to
  complete before the first system-prompt render or tool call.
- **V2 session-move listener**: subscribing to the V2 `session.moved` event,
  the plugin treats a `session_move` the same as a `use_workdir` call to the
  new location (`join(location.directory, subpath ?? '')`, same
  `workspaceID` skip rule) for the moved session's tracked state, routed
  through the same `applyDirectoryChange` choke point. V1 has no equivalent
  event; this feature is V2-only.
- **Worktree envrc auto-trust (narrowed to the create path only)**: when
  `use_worktree` **creates a brand-new worktree** (not when it reuses an
  existing one, owned or not), if the new worktree's `.envrc` is
  byte-identical to the repository root's `.envrc`, re-read at the moment of
  the check (not cached from earlier), AND the root's is `direnv allow`-ed at
  that same moment, the plugin runs `direnv allow` on the new worktree's
  `.envrc` unattended (no prompt). This is the only case in this change where
  the plugin runs `direnv allow` on the agent's behalf, and the spec
  explicitly states the plugin SHALL NOT do so in any other circumstance.
  The residual risk — byte-identical `.envrc` content can still behave
  differently in the new directory via relative directives (`source_up`,
  `dotenv .env`, `PATH_add ./bin`) resolving against untracked, potentially
  different files — is accepted and documented in `design.md`/the delta
  spec rather than mitigated further in this change.

## Rejected / Descoped (from the original draft, after review)

- **File-watcher stale-`.envrc` notification** (originally feature (d)):
  dropped entirely. Verified directly against the current opencode v2 source
  (`packages/core/src/filesystem/location-watcher.ts`, confirmed on the
  latest published `@opencode/plugin`/`@opencode/schema` 2.0.16) that V2's
  `filesystem.changed` event is wired to watch only the repository's VCS
  HEAD/branch file — it never fires for an arbitrary file such as `.envrc`.
  Building a plugin-owned watcher independent of host events was considered
  and rejected for this change as disproportionate scope; may be revisited as
  its own change.
- **Auto-loading env at session start**: originally part of feature (c),
  dropped. `ShellCreateBefore` (V2's shell-hook payload, re-verified against
  the current source, `packages/plugin/src/promise/shell.ts` on 2.0.16) has
  no `sessionID` field — only `cwd` — so the plugin's existing fail-closed
  `resolveEnvSessionForShell` ladder degrades to "inject nothing" whenever
  more than one env-bearing session shares a `cwd`. Auto-loading env into
  every session at creation would make this collision the common case for
  any project with concurrent sessions. Narrowing session-start to skip
  env auto-load keeps the collision rate at today's baseline.
- **Worktree envrc auto-trust on the reuse path**: dropped; auto-trust now
  applies only when `use_worktree` creates a new worktree, not when it
  attaches to an existing one (worktree not created by this action, whether
  plugin-owned or not).

## Capabilities

### New Capabilities

- `worktree-envrc-trust`: auto-trusting a newly-created worktree's `.envrc`
  when it is byte-identical (checked at the moment of trust) to an
  already-allowed repository-root `.envrc`, and the unattended `direnv allow`
  execution scoped to exactly that one case, with an explicit negative
  requirement that the plugin never runs `direnv allow` anywhere else.

### Modified Capabilities

- `context-autoload`: the `.envrc Detection Reminder` requirement becomes
  conditional auto-load on `use_workdir`/`use_worktree` (load when already
  allowed; otherwise keep today's note-only behavior); adds session-start
  auto-initialization of `state.cwd`/AGENTS.md/`.envrc`-note (env auto-load
  excluded) for every session including subagents; adds the V2 session-move
  listener.

## Impact

- `src/lib.js`: new `checkDirenvAllowed`, `runDirenvExportJson` (raw
  export/parse extracted from `core.js`, with a timeout budget that degrades
  to note-only rather than blocking a directory change indefinitely),
  `resolveRepoContext` extended to return the discovered `envrcPath`,
  `applyDirectoryChange` extended with conditional auto-load anchored at
  `envrcPath`'s directory, new `applyDirectoryChangeForWorktree` wrapper
  (wrapping, never bypassing, `applyDirectoryChange`) for the create-path
  auto-trust step.
- `src/core.js`: `executeUseWorktree` routes its create-path success return
  through the new worktree wrapper; `executeUseDirenv` reuses the extracted
  export/parse helper; new session-init helper shared by both adapters,
  routed through `applyDirectoryChange`.
- `src/plugin.v1.js`: new `session.created` branch in the existing `event`
  hook.
- `src/plugin.v2.js`: new `session.created` and `session.moved` branches in
  the existing `ctx.event.subscribe` loop.
- `openspec/specs/context-autoload/spec.md`, new
  `openspec/specs/worktree-envrc-trust/spec.md`.
- `test/*.test.js`: new/updated coverage for each new lib.js/core.js
  function and each new adapter event branch (mocking `$`/`direnv` subprocess
  calls and V1/V2 event payloads per verified SDK shapes), plus an update to
  the existing `context-autoload` test asserting "never invokes direnv,"
  which the conditional-auto-load behavior now falsifies for the
  already-allowed case.
- `README.md`: update the line describing `.envrc` handling as
  detect-never-execute to reflect the new conditional auto-load.
- No new dependencies. No breaking API change to existing tool signatures.
