## MODIFIED Requirements

### Requirement: Relative Path Resolution Against Base Directories

The path-resolution helper SHALL resolve a relative input path against the
invoking directory (`ctx.directory`) first, falling back to the session's
active working directory (`state.cwd`, set via a prior `use_workdir` call) when
`ctx.directory` is unavailable. If neither base directory is available, the
helper SHALL raise a clear error naming the unresolvable input path instead of
silently resolving against an arbitrary or empty base.

#### Scenario: Invoking directory is available

- GIVEN a relative `path` argument and a known `ctx.directory`
- WHEN the tool resolves the path
- THEN the resolved path is `ctx.directory` joined with the relative path

#### Scenario: Invoking directory is unavailable, session has an active working directory

- GIVEN a relative `path` argument, no `ctx.directory`, and a session with `state.cwd` set from a prior `use_workdir` call
- WHEN the tool resolves the path
- THEN the resolved path is `state.cwd` joined with the relative path

#### Scenario: No base directory is available

- GIVEN a relative `path` argument, no `ctx.directory`, and no `state.cwd`
- WHEN the tool resolves the path
- THEN the tool raises an error naming the unresolvable input path, instead of resolving against an arbitrary base
