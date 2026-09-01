# worktree-git-root Specification

## Purpose

Defines how the `use_worktree` tool selects the working directory in which it runs
git subprocess operations (`git ls-remote`, `git fetch`, `git worktree add`,
`git worktree list`) when creating or reusing a git worktree.

## Requirements

### Requirement: Git Root Selection

The `use_worktree` tool SHALL select the working directory for git subprocess
operations by checking, in priority order, the session's explicit working
directory (`state.cwd`, set via a prior `use_cwd` call), then the session's
initial git worktree (`ctx.worktree`), then the invoking directory
(`ctx.directory`).

#### Scenario: Session has an explicit working directory

- GIVEN a session where `use_cwd` was previously called with a path inside a git repository
- WHEN `use_worktree` is invoked
- THEN git operations run in the directory set by `use_cwd`

#### Scenario: Session was opened outside a git repository with no explicit working directory

- GIVEN a session with no prior `use_cwd` call and no `ctx.worktree`
- WHEN `use_worktree` is invoked with `create: true` and a `path` argument pointing into a real git repository
- THEN git operations run in `ctx.directory`, even when `ctx.directory` is not a git repository, causing git subprocess commands (e.g. `git ls-remote --symref origin HEAD`) to fail with a raw, misleading error such as "fatal: 'origin' does not appear to be a git repository"
