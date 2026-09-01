## MODIFIED Requirements

### Requirement: Git Root Selection

The `use_worktree` tool SHALL select the working directory for git subprocess
operations by first checking, in priority order, the session's explicit
working directory (`state.cwd`, set via a prior `use_cwd` call), then the
session's initial git worktree (`ctx.worktree`), then the invoking directory
(`ctx.directory`). The tool SHALL validate the selected candidate by confirming
it is inside a git repository before running any other git subprocess command
against it; if the candidate is not inside a git repository, the tool SHALL
attempt to discover a git repository by walking up from the nearest existing
ancestor directory of the target worktree path. If neither the candidate nor
the path-derived discovery resolves to a git repository, the tool SHALL raise
a single clear error naming both failed candidates and instructing the caller
to call `use_cwd` first, instead of allowing a raw git subprocess error to
propagate.

#### Scenario: Session has an explicit working directory

- GIVEN a session where `use_cwd` was previously called with a path inside a git repository
- WHEN `use_worktree` is invoked
- THEN git operations run in the directory set by `use_cwd`, canonicalized to that repository's top-level directory

#### Scenario: Session was opened outside a git repository with no explicit working directory

- GIVEN a session with no prior `use_cwd` call, where `ctx.directory` is not a git repository and `ctx.worktree` is unset
- WHEN `use_worktree` is invoked with `create: true` and a `path` argument nested under a real git repository (e.g. `<repo-root>/.worktrees/<branch>`)
- THEN the tool discovers that repository by walking up from the target path and runs all git operations at its top-level directory, instead of failing with a raw git error

#### Scenario: Neither the session context nor the target path resolves to a git repository

- GIVEN a session with no prior `use_cwd` call, where `ctx.directory` is not a git repository, and the target `path` is not nested under any git repository either
- WHEN `use_worktree` is invoked with `create: true`
- THEN the tool raises a single clear error naming both failed candidates and instructing the caller to call `use_cwd` first, instead of surfacing a raw git subprocess error
