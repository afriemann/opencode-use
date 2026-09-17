# worktree-cleanup Specification

## Purpose

Defines how the `use_clear` tool removes an owned git worktree from disk and
reconciles the session's own worktree reference when `fields` includes
`"worktree"`.

## Requirements

### Requirement: Owned Worktree Removal

The `use_clear` tool SHALL, when clearing an owned worktree, run
`git worktree remove` (or `git worktree remove --force` when `force: true`)
against the worktree's path, using as the working directory the git
repository resolved by `resolveGitRoot` for that worktree's path — passing
`gitRoot(state, ctx)` (the session's explicit working directory, then the
session's initial git worktree, then the invoking directory, in that
priority order) as the candidate root and the worktree's own path as the
target. If `resolveGitRoot` cannot determine a containing repository, the
tool SHALL propagate its error instead of attempting removal against a
directory guessed from raw session context. On success, the tool SHALL clear
the session's worktree reference and, if the session's working directory
pointed at the removed worktree, clear that too.

#### Scenario: Owned worktree removed successfully

- GIVEN an owned worktree with no uncommitted changes or untracked files
- WHEN `use_clear` is called with `fields: ["worktree"]`
- THEN `git worktree remove` succeeds and the session's worktree reference is cleared

#### Scenario: Removal fails due to uncommitted or untracked content

- GIVEN an owned worktree with uncommitted changes or untracked files
- WHEN `use_clear` is called with `fields: ["worktree"]` and `force` is not set
- THEN the tool raises an error naming the worktree path and instructing the caller to pass `force: true` or clean up first

#### Scenario: Session context points at a different repository than the worktree

- GIVEN an owned worktree registered in repository A, while the session's current working directory and invoking directory both resolve to a different, unrelated repository B
- WHEN `use_clear` is called with `fields: ["worktree"]`
- THEN the tool resolves repository A (not B) as the working directory for `git worktree remove`, and the removal succeeds against the correct repository instead of failing with `"is not a working tree"`

#### Scenario: The worktree's containing repository can no longer be found

- GIVEN an owned worktree whose containing repository directory no longer exists on disk, and the session's current working directory and invoking directory do not resolve to any git repository either
- WHEN `use_clear` is called with `fields: ["worktree"]`
- THEN the tool raises `resolveGitRoot`'s own error describing that no containing repository could be determined, instead of attempting a `git worktree remove` call against a guessed directory

### Requirement: Force-Clearing An Unregistered Worktree Path

The `use_clear` tool SHALL, when `force: true` is set and `git worktree
remove --force` fails with an error containing `"is not a working tree"`,
clear the session's worktree reference without raising an error, reporting
that the reference was cleared and that the directory may still exist on
disk. The tool SHALL NOT attempt any further git operation to reconcile the
repository's own worktree administrative metadata for the affected path in
this case.

#### Scenario: Force-clearing a path git no longer recognizes as a worktree

- GIVEN the session's worktree reference points at a path that `git worktree remove` reports as `"is not a working tree"`
- WHEN `use_clear` is called with `fields: ["worktree"]` and `force: true`
- THEN the tool clears the session's worktree reference, reports that the reference was cleared, and takes no further git action
