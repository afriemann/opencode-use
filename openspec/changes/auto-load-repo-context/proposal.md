## Why

opencode's own AGENTS.md auto-loading (`Instruction.systemPaths`) is bound to
the session's real `ctx.directory`/`ctx.worktree` — fixed at session start,
wherever opencode was actually launched. It has no awareness of
`opencode-use`'s own virtual `state.cwd`. As a result, when an agent calls
`use_cwd` or `use_worktree` to move into a different repository mid-session,
opencode never surfaces that repository's `AGENTS.md` — the agent keeps
operating on the *original* launch directory's instructions (or none at all),
silently missing repo-specific conventions, build steps, and constraints for
every repository it switches into via this plugin. Similarly, the plugin
already supports loading a repository's `direnv` environment (`use_direnv`),
but only when the agent remembers to call it explicitly after switching
directories — an easy step to forget, leaving bash commands running without
the target repository's environment, with no signal that one is even
available.

## What Changes

- `use_cwd` and `use_worktree` automatically search upward from the resolved
  target directory for an `AGENTS.md` file, **only when the resolved
  directory actually differs from the session's current `state.cwd`**
  (skipped on idempotent no-op/reuse calls to the same path, avoiding
  redundant subprocess work and avoiding clobbering a deliberately different
  manual state). The search is bounded by that directory's git root (or the
  directory itself if it is not inside a git repository).
- The found file's content, together with the repository path it belongs to,
  is injected into the system prompt via the existing
  `experimental.chat.system.transform` hook, under its own clearly-scoped
  block distinct from the existing "Active Session Context" block. The block
  labels the content explicitly as **repository-provided, advisory
  context** — informational instructions from the target repository, not an
  override of the agent's own operating instructions — since it may
  originate from a branch the *agent* navigated to (e.g. an unreviewed PR
  branch via `use_worktree`) rather than a directory the *user* explicitly
  chose. Content replaces any previously loaded instructions on every actual
  directory change, so a session that moves between repositories always
  reflects the current one and never leaks a stale repository's instructions.
- `use_cwd` and `use_worktree` also perform a **detection-only** check —
  under the same "only when the directory actually changes" condition — for
  an `.envrc` file anywhere between the resolved directory and its git root
  boundary, using a plain filesystem check with **no `direnv` subprocess
  invocation and no execution of the `.envrc` itself**. If one is found, a
  non-blocking note is appended to the tool's return value telling the agent
  it may call `use_direnv` explicitly to load it — the agent must still take
  an explicit, visible action to actually execute any `.envrc` content, an
  intentional constraint distinct from the AGENTS.md case above because
  loading a `.envrc` can run arbitrary shell.
- `use_clear(fields: ["cwd"])` also clears the auto-detected `AGENTS.md`
  state, so a cleared session does not keep injecting a stale repository's
  instructions into the system prompt.
- **`use_direnv`'s `changeCwd` parameter is removed.** Since `use_cwd` now
  auto-detects `.envrc` presence and reminds the agent to call `use_direnv`
  explicitly, `changeCwd`'s combined "load env and move cwd in one call"
  behavior is redundant complexity: an agent that wants both calls `use_cwd`
  (which surfaces the `.envrc` reminder) and then `use_direnv` separately.
  Removing it keeps `use_direnv` a pure environment-loading tool with no
  session-directory side effect, and avoids adding a fifth `state.cwd`
  assignment site to reason about.
- Both tools' descriptions and the README are updated to document the new
  automatic behavior.

## Capabilities

### New Capabilities

- `context-autoload`: automatic discovery of a target repository's
  `AGENTS.md` (with advisory-framed system-prompt injection) and `.envrc`
  presence (detection + reminder only, no automatic execution) whenever
  `use_cwd` or `use_worktree` changes the session's active directory to a
  genuinely new path.

### Modified Capabilities

_None — `workdir-injection` and `worktree-git-root` are unaffected; this
change adds new behavior alongside them without altering their existing
requirements._

## Impact

- **Code**: `src/index.js` — a shared helper invoked from `use_cwd` and from
  **all three** success-return sites in `use_worktree` (idempotent same-path
  reuse, existing-worktree reuse, and newly-created), performing: git-root
  resolution for the resolved directory, upward `AGENTS.md` search bounded
  by that root, and upward `.envrc` existence check (no execution) bounded
  by the same root — all gated on the resolved directory actually differing
  from the session's current `state.cwd`. New system-prompt block in
  `experimental.chat.system.transform`, clearly scoped and separate from the
  existing "Active Session Context" block, with advisory-context framing.
- **Session state**: adds `state.agentsMd: { repoPath, filePath, content } |
  null` to the existing per-session state shape.
- **Tests**: new test coverage under `test/` for: AGENTS.md discovery and
  injection (found at target dir, found at an ancestor up to git root, not
  found, not in a git repo, no-op when directory unchanged), and `.envrc`
  detection (found, not found, no-op when directory unchanged) — with no
  test relying on an actual `direnv` subprocess invocation for detection.
- **Breaking change**: `use_direnv`'s `changeCwd` parameter is removed. Any
  caller currently passing it must instead call `use_cwd` and `use_direnv`
  as two separate calls.
- **Docs**: `README.md` updated to describe the new automatic behavior for
  both tools and the removal of `use_direnv`'s `changeCwd` parameter.
- **Dependencies**: none added.
