## MODIFIED Requirements

### Requirement: Directory-Change Detection Gate

The plugin SHALL perform repository-context discovery (`AGENTS.md` search and
`.envrc` detection) only when a call to `use_workdir`, or any of `use_worktree`'s
three success paths, resolves to a directory that differs from the session's
current `state.cwd` at the time of the call. When the resolved directory is
identical to the session's current `state.cwd`, the plugin SHALL still assign
`state.cwd` to that value but SHALL NOT run discovery, SHALL NOT invoke `git`
or read any file for this purpose, and SHALL NOT append any repository-context
note to the tool's return value.

#### Scenario: use_cwd moves to a genuinely new directory

- GIVEN a session whose current `state.cwd` differs from the path passed to `use_workdir`
- WHEN `use_workdir` resolves and validates the new path
- THEN the plugin runs repository-context discovery for the resolved directory

#### Scenario: use_cwd is called again with the same resolved directory

- GIVEN a session whose current `state.cwd` already equals the resolved path passed to `use_workdir`
- WHEN `use_workdir` is called again with that same path
- THEN the plugin does not run repository-context discovery and appends no repository-context note to the return value

#### Scenario: use_worktree's idempotent same-path return does not repeat discovery

- GIVEN a session where `use_worktree` previously created a worktree at a path and set `state.cwd` to it
- WHEN `use_worktree` is called again with the same path and branch, triggering the idempotent same-path early return
- THEN the plugin does not run repository-context discovery, because the resolved directory equals the session's current `state.cwd`

#### Scenario: use_worktree's idempotent same-path return fires after the directory moved elsewhere

- GIVEN a session where `use_worktree` previously created a worktree at a path, and a later `use_workdir` call moved `state.cwd` to a different directory
- WHEN `use_worktree` is called again with the original worktree's path and branch, triggering the idempotent same-path early return
- THEN the plugin runs repository-context discovery for the worktree path, because it now differs from the session's current `state.cwd`

#### Scenario: use_worktree reuses an existing worktree via the already-exists recovery path

- GIVEN a session with no prior worktree tracked in session state, and a git worktree already registered on disk for the requested path and branch
- WHEN `use_worktree` is invoked and reuses the existing worktree via its already-exists recovery path
- THEN the plugin runs repository-context discovery for the reused worktree's path

#### Scenario: use_worktree creates a new worktree

- GIVEN a session where the requested worktree path is not yet registered with git
- WHEN `use_worktree` successfully creates the worktree
- THEN the plugin runs repository-context discovery for the newly-created worktree's path
