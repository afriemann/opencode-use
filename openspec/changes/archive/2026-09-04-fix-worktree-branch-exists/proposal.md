## Why

`use_worktree` with `create: true` fails when the requested branch already exists locally
but is not checked out as a worktree anywhere. `git worktree add -b <branch> <path>` errors
with `fatal: a branch named '<branch>' already exists`, and the tool's existing idempotency
recovery only recognizes the "destination path already exists" failure mode (it looks up a
registered worktree at the *resolved path*). Since no worktree is registered at that path in
this failure mode, the recovery check finds nothing and the raw git error is rethrown,
forcing the caller to manually retry with `create: false`. `create: true` should be safe to
call unconditionally — if the branch exists, the tool should just use it.

## What Changes

- When `create: true` fails specifically because the *branch* already exists (not the
  destination path), detect this failure mode distinctly from the existing path-exists case.
- If the branch is not checked out as a worktree anywhere else, retry as a plain
  `git worktree add <path> <branch>` (check out the existing branch) and succeed, returning
  the same "worktree created" response shape (noting the branch was reused, not created).
- If the branch is already checked out at a different worktree path, raise a clear error
  naming that existing path and instructing the caller to call `use_worktree` there instead
  (with `create: false`), rather than surfacing the raw git error.
- No change to the `create: false` path, the path-already-exists idempotency path, or the
  cross-repo contamination guard.

## Capabilities

### New Capabilities
- `worktree-branch-reuse`: defines `use_worktree`'s behavior when `create: true` is requested
  for a branch that already exists but has no worktree registered at the target path.

### Modified Capabilities
(none — `worktree-git-root` is unaffected; this proposal only adds new branch-exists
recovery behavior alongside it)

## Impact

- `src/index.js` — the `use_worktree` tool's `catch` block around `git worktree add -b`.
- `test/` — a new or extended test file covering the branch-already-exists recovery paths.
- No public tool signature change; `create`, `path`, `branch` parameters and the tool's
  return-value shape are unchanged. Purely an added recovery path for an existing failure.
