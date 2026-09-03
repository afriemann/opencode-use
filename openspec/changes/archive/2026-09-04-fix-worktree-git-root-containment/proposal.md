## Why

`use_worktree`'s git-root resolution (`resolveGitRoot` in `src/lib.js`) accepts the *first*
candidate directory (session's cached `state.cwd`, then `ctx.worktree`, then `ctx.directory`)
that resolves to **any** valid git repository — it never checks whether the repository it
found actually contains the *target worktree path* the caller asked for. When a session's
cached context still points at a repository from an earlier, unrelated task (e.g.
`infrastructure`), and `use_worktree` is later called with a path under a completely
different repository (e.g. `middle-earth/.worktrees/<branch>`), the tool silently accepts the
stale, unrelated repository as the git root. It then runs `git worktree add` there, creating
and registering the worktree against the wrong repository while the requested branch's
content is checked out at a path that lives under a different repo entirely — a form of
cross-repo contamination distinct from (and not caught by) the existing cross-repo guard,
which only checks worktrees *reused* via the path-already-exists idempotency path, not fresh
creations.

## What Changes

- `resolveGitRoot` gains a containment check: a candidate's resolved git toplevel is only
  accepted if the target worktree path is inside it (or equal to it). A candidate that
  resolves to a valid but unrelated repository is rejected and the function falls through to
  the next candidate.
- The path-derived candidate (the nearest existing ancestor of the target path) always
  satisfies containment by construction, so the existing two-candidate fallback chain and its
  final "neither resolves" error are otherwise unchanged.
- `use_worktree`'s success response message now names the repository root the operation ran
  against (e.g. `"... in repository <root>."`), so the calling agent can immediately see which
  repository was used and catch a wrong-repo selection without needing to separately inspect
  `git worktree list`.
- No change to `use_worktree`'s parameters or the overall shape of its return value (still a
  single descriptive string); only the wording of the success message gains this detail.

## Capabilities

### Modified Capabilities
- `worktree-git-root`: the "Git Root Selection" requirement gains a containment
  constraint — a session-context candidate is only used as the git root if the target
  worktree path is actually inside it. A new requirement is added: the tool's success
  response SHALL report the repository root that was used.


## Impact

- `src/lib.js` — `resolveGitRoot`.
- `test/resolve-git-root.test.js` — new regression test reproducing the cross-repo hijack.
- No dependency, infrastructure, or public API changes.
