# worktree-branch-reuse Specification

## Purpose
Defines how `use_worktree` recovers when `create: true` is requested for a branch that
already exists locally but has no worktree registered at the requested target path — instead
of surfacing the raw git error for `git worktree add -b`.

## Requirements

### Requirement: Recover From An Existing Branch On Create

The `use_worktree` tool SHALL, when `create: true` is requested and `git worktree add -b
<branch>` fails because a branch named `<branch>` already exists (rather than because the
destination path already exists), check whether that branch is already registered to a
worktree at a different path. If the branch is not registered to any worktree, the tool
SHALL retry by checking out the existing branch into the requested path (equivalent to
`git worktree add <path> <branch>`) and SHALL succeed, treating this as a successful
worktree creation. If the branch is already registered to a worktree at a different path,
the tool SHALL raise a clear error naming that existing path and instructing the caller to
call `use_worktree` at that path with `create: false`, instead of surfacing the raw git
error.

#### Scenario: Branch exists but is not checked out anywhere

- GIVEN a branch `<branch>` exists in the repository but no worktree is currently checked out on it
- WHEN `use_worktree` is invoked with `create: true`, `branch: <branch>`, and a `path` with no worktree registered there
- THEN the tool checks out `<branch>` into `path` and returns a successful worktree-created response, with the active working directory set to `path`

#### Scenario: Branch already checked out at a different worktree path

- GIVEN a branch `<branch>` is already checked out in an existing worktree at `<other-path>`
- WHEN `use_worktree` is invoked with `create: true`, `branch: <branch>`, and a `path` different from `<other-path>` with no worktree registered there
- THEN the tool raises an error naming `<other-path>` and instructing the caller to call `use_worktree` there with `create: false`, instead of surfacing the raw git "already exists" error

#### Scenario: Destination path already exists as a registered worktree (unaffected)

- GIVEN a worktree is already registered for `<branch>` at the requested `path`
- WHEN `use_worktree` is invoked with `create: true`, `branch: <branch>`, and that same `path`
- THEN the tool follows the existing path-already-exists idempotency behavior unchanged, reusing that worktree
