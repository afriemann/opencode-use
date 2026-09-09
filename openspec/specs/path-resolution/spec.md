# path-resolution Specification

## Purpose

Defines how the `use_cwd`, `use_direnv`, and `use_worktree` tools resolve the
`path` argument a caller supplies into a concrete filesystem path, before any
further validation (e.g. "must be a directory", "must exist") or use of that
path runs.

## Requirements

### Requirement: Absolute Path Passthrough

The path-resolution helper SHALL return an absolute input path unchanged,
without consulting any base directory.

#### Scenario: Input path is already absolute

- GIVEN a `path` argument that is an absolute filesystem path (e.g. `/home/user/project`)
- WHEN the tool resolves the path
- THEN the resolved path equals the input path exactly

### Requirement: Relative Path Resolution Against Base Directories

The path-resolution helper SHALL resolve a relative input path against the
invoking directory (`ctx.directory`) first, falling back to the session's
active working directory (`state.cwd`, set via a prior `use_cwd` call) when
`ctx.directory` is unavailable. If neither base directory is available, the
helper SHALL raise a clear error naming the unresolvable input path instead of
silently resolving against an arbitrary or empty base.

#### Scenario: Invoking directory is available

- GIVEN a relative `path` argument and a known `ctx.directory`
- WHEN the tool resolves the path
- THEN the resolved path is `ctx.directory` joined with the relative path

#### Scenario: Invoking directory is unavailable, session has an active working directory

- GIVEN a relative `path` argument, no `ctx.directory`, and a session with `state.cwd` set from a prior `use_cwd` call
- WHEN the tool resolves the path
- THEN the resolved path is `state.cwd` joined with the relative path

#### Scenario: No base directory is available

- GIVEN a relative `path` argument, no `ctx.directory`, and no `state.cwd`
- WHEN the tool resolves the path
- THEN the tool raises an error naming the unresolvable input path, instead of resolving against an arbitrary base
