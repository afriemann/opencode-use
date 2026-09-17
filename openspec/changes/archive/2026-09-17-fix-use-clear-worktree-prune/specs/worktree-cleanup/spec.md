## MODIFIED Requirements

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
