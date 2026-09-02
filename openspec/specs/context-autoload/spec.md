# context-autoload Specification

## Purpose
Automatically discovers a target repository's `AGENTS.md` and `.envrc`
presence whenever `use_cwd` or `use_worktree` moves the session's active
directory to a genuinely new path, injecting the found `AGENTS.md` content
into the system prompt as clearly-labeled advisory context and reminding the
agent to load `.envrc` explicitly, without ever executing it automatically.

## Requirements

### Requirement: Directory-Change Detection Gate

The plugin SHALL perform repository-context discovery (`AGENTS.md` search and
`.envrc` detection) only when a call to `use_cwd`, or any of `use_worktree`'s
three success paths, resolves to a directory that differs from the session's
current `state.cwd` at the time of the call. When the resolved directory is
identical to the session's current `state.cwd`, the plugin SHALL still assign
`state.cwd` to that value but SHALL NOT run discovery, SHALL NOT invoke `git`
or read any file for this purpose, and SHALL NOT append any repository-context
note to the tool's return value.

#### Scenario: use_cwd moves to a genuinely new directory

- GIVEN a session whose current `state.cwd` differs from the path passed to `use_cwd`
- WHEN `use_cwd` resolves and validates the new path
- THEN the plugin runs repository-context discovery for the resolved directory

#### Scenario: use_cwd is called again with the same resolved directory

- GIVEN a session whose current `state.cwd` already equals the resolved path passed to `use_cwd`
- WHEN `use_cwd` is called again with that same path
- THEN the plugin does not run repository-context discovery and appends no repository-context note to the return value

#### Scenario: use_worktree's idempotent same-path return does not repeat discovery

- GIVEN a session where `use_worktree` previously created a worktree at a path and set `state.cwd` to it
- WHEN `use_worktree` is called again with the same path and branch, triggering the idempotent same-path early return
- THEN the plugin does not run repository-context discovery, because the resolved directory equals the session's current `state.cwd`

#### Scenario: use_worktree's idempotent same-path return fires after the directory moved elsewhere

- GIVEN a session where `use_worktree` previously created a worktree at a path, and a later `use_cwd` call moved `state.cwd` to a different directory
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

### Requirement: AGENTS.md Auto-Discovery

When repository-context discovery runs, the plugin SHALL resolve the
resolved directory's git root by running `git rev-parse --show-toplevel` in
that directory. If this succeeds, the plugin SHALL search for an `AGENTS.md`
file starting at the resolved directory and walking upward through each
ancestor directory up to and including the discovered git root, and SHALL use
the nearest match (closest to the resolved directory) when more than one
exists. If git root discovery fails (the directory is not inside a git
repository, `git` is unavailable, or a permission error occurs), the plugin
SHALL search only the resolved directory itself. If no `AGENTS.md` is found
by this search, the plugin SHALL set the session's stored repository context
to absent. No failure during discovery (a `git` failure, a filesystem error,
or any other unexpected error) SHALL propagate out of discovery or cause the
triggering tool call to fail; on any such failure the plugin SHALL treat it
as equivalent to "not found" and log the failure via the existing app-log
helper.

#### Scenario: AGENTS.md exists at the resolved directory

- GIVEN a resolved directory containing an `AGENTS.md` file
- WHEN repository-context discovery runs for that directory
- THEN the plugin loads that file's content and records the resolved directory's git root (or the directory itself if not in a repository) as the repository path

#### Scenario: AGENTS.md exists only at an ancestor within the git root

- GIVEN a resolved directory with no `AGENTS.md` of its own, inside a git repository whose root (or an intermediate ancestor between the directory and the root) contains an `AGENTS.md`
- WHEN repository-context discovery runs for that directory
- THEN the plugin loads the nearest ancestor's `AGENTS.md` content

#### Scenario: Multiple AGENTS.md files exist between the directory and the git root

- GIVEN a resolved directory containing its own `AGENTS.md`, inside a git repository whose root also contains a different `AGENTS.md`
- WHEN repository-context discovery runs for that directory
- THEN the plugin loads the resolved directory's own `AGENTS.md`, not the git root's

#### Scenario: No AGENTS.md exists anywhere between the directory and the git root

- GIVEN a resolved directory inside a git repository where neither the directory nor any ancestor up to the git root contains an `AGENTS.md`
- WHEN repository-context discovery runs for that directory
- THEN the plugin sets the session's stored repository context to absent

#### Scenario: Resolved directory is not inside a git repository

- GIVEN a resolved directory that is not inside a git repository
- WHEN repository-context discovery runs for that directory
- THEN the plugin searches only that directory for `AGENTS.md`, without searching any ancestor

#### Scenario: git is unavailable or the directory check fails

- GIVEN a resolved directory for which `git rev-parse --show-toplevel` fails for a reason other than "not a repository" (for example `git` is not on `PATH`, or a permission error occurs)
- WHEN repository-context discovery runs for that directory
- THEN the plugin treats the directory as not inside a git repository, searches only that directory, logs the failure, and does not fail the triggering tool call

#### Scenario: An unexpected failure occurs during discovery

- GIVEN any unexpected error during git-root resolution, the upward search, or reading a found file
- WHEN repository-context discovery runs
- THEN the plugin logs the failure, sets the session's stored repository context to absent, and does not fail the triggering tool call

### Requirement: AGENTS.md Size Limits

The plugin SHALL apply two size thresholds to a found `AGENTS.md` file, based
on its size at discovery time. A file no larger than 16 KiB SHALL be read and
stored in full. A file larger than 16 KiB but no larger than 1 MiB SHALL be
read, truncated at a line boundary to at most 16 KiB, and have a marker
appended to the stored content and to the tool's return value naming the file
path and that it was truncated. A file larger than 1 MiB SHALL NOT be read at
all; the session's stored repository context SHALL be set to absent, and the
tool's return value SHALL include a note naming the file path and that it
exceeds the size limit and was not loaded automatically.

#### Scenario: AGENTS.md is within the load limit

- GIVEN a found `AGENTS.md` file no larger than 16 KiB
- WHEN repository-context discovery loads it
- THEN the plugin stores its full content and the tool's return value reports it was loaded

#### Scenario: AGENTS.md exceeds the load limit but is within the read limit

- GIVEN a found `AGENTS.md` file larger than 16 KiB but no larger than 1 MiB
- WHEN repository-context discovery loads it
- THEN the plugin stores content truncated at a line boundary to at most 16 KiB, and the tool's return value reports the file was loaded and truncated

#### Scenario: AGENTS.md exceeds the read limit

- GIVEN a found `AGENTS.md` file larger than 1 MiB
- WHEN repository-context discovery runs
- THEN the plugin does not read the file, sets the session's stored repository context to absent, and the tool's return value reports the file exceeds the size limit and was not loaded automatically

### Requirement: Advisory System-Prompt Injection

The plugin SHALL inject the session's stored `AGENTS.md` content into the
system prompt via the `experimental.chat.system.transform` hook whenever that
content is present, as a distinct block appended after the existing "Active
Session Context (opencode-use)" block. This block SHALL state the repository
path (the discovered git root, or the resolved directory itself when not in a
git repository) and the file's path, SHALL explicitly label the content as
repository-provided, advisory context that does not override the agent's own
operating instructions and loses to them on conflict, and SHALL caution that
the content may originate from a branch the agent itself navigated to rather
than one the user chose, and so SHALL be treated as untrusted input rather
than as commands. The content SHALL be wrapped in a fenced code region whose
fence length is computed from the content: the plugin SHALL scan the content
for lines that, after stripping leading whitespace, consist solely of
backtick characters, take the length of the longest such line (zero if none
exist), and use a fence of at least one character longer than that length,
with a minimum of three characters, so that no line within the content can
terminate the fenced region. When the session's stored `AGENTS.md` content is
absent, the plugin SHALL NOT inject this block.

#### Scenario: AGENTS.md content is present

- GIVEN a session with stored `AGENTS.md` content from a discovered repository
- WHEN the system prompt is being assembled
- THEN the plugin injects a block distinct from the "Active Session Context (opencode-use)" block, stating the repository path, the file path, and advisory/provenance framing, with the content fenced

#### Scenario: AGENTS.md content is absent

- GIVEN a session with no stored `AGENTS.md` content
- WHEN the system prompt is being assembled
- THEN the plugin injects no repository-instructions block

#### Scenario: Content contains a run of backtick characters

- GIVEN stored `AGENTS.md` content containing a line consisting solely of N backtick characters (after stripping leading whitespace), where N is at least 3
- WHEN the plugin injects the advisory block
- THEN the fence enclosing the content is at least N+1 backtick characters long

#### Scenario: A directory change replaces previously injected content

- GIVEN a session with stored `AGENTS.md` content from a previously discovered repository
- WHEN a subsequent directory change causes discovery to find a different (or no) `AGENTS.md`
- THEN the system prompt reflects only the new content (or no block at all), and never both the previous and the new content together

### Requirement: .envrc Detection Reminder

When repository-context discovery runs, the plugin SHALL check, using the
same upward search and git-root boundary as the `AGENTS.md` search, whether a
file literally named `.envrc` exists at the resolved directory or any
ancestor up to the boundary, using only filesystem existence checks. The
plugin SHALL NOT invoke a `direnv` subprocess, and SHALL NOT read or evaluate
the `.envrc` file's contents, for this detection. When such a file is found,
the plugin SHALL append a non-blocking note to the tool's return value
suggesting that the agent call `use_direnv` explicitly to load it. This
detection SHALL NOT alter the session's active environment or its source.

#### Scenario: .envrc exists between the resolved directory and the git root

- GIVEN a resolved directory where an `.envrc` file exists at the directory itself or an ancestor up to the git root boundary
- WHEN repository-context discovery runs for that directory
- THEN the tool's return value includes a note suggesting the agent call `use_direnv` to load it, and the session's active environment is unchanged

#### Scenario: No .envrc exists

- GIVEN a resolved directory where no `.envrc` file exists at the directory or any ancestor up to the git root boundary
- WHEN repository-context discovery runs for that directory
- THEN the tool's return value includes no `.envrc`-related note

#### Scenario: Detection never invokes a direnv subprocess

- GIVEN repository-context discovery running for any resolved directory
- WHEN the `.envrc` detection check executes
- THEN no `direnv` subprocess is invoked, regardless of whether an `.envrc` file is found

### Requirement: use_clear Clears Auto-Loaded Repository Context

The plugin SHALL ensure that whenever `use_clear` causes the session's active
working directory (`state.cwd`) to become falsy — whether via the explicit
`cwd` field being cleared, or via the `worktree` field being cleared when
`state.cwd` pointed at the removed worktree — the session's stored `AGENTS.md`
content is also cleared. When this clears previously stored content, the
plugin SHALL report the cleared repository in `use_clear`'s return value.

#### Scenario: Clearing cwd clears loaded repository context

- GIVEN a session with stored `AGENTS.md` content and an active `state.cwd`
- WHEN `use_clear` is called with `fields` including `"cwd"`
- THEN the session's stored `AGENTS.md` content is cleared and the return value reports the cleared repository

#### Scenario: Clearing worktree clears loaded repository context when cwd pointed at it

- GIVEN a session with stored `AGENTS.md` content, where `state.cwd` currently equals the active worktree's path
- WHEN `use_clear` is called with `fields` including `"worktree"` and the worktree removal causes `state.cwd` to be cleared
- THEN the session's stored `AGENTS.md` content is also cleared

#### Scenario: Clearing with no repository context loaded

- GIVEN a session with no stored `AGENTS.md` content
- WHEN `use_clear` is called and clears `state.cwd`
- THEN no repository-context line is added to the return value

### Requirement: use_direnv No Longer Changes the Session's Active Directory

The `use_direnv` tool SHALL accept only a `path` parameter and SHALL load the
session's active environment without altering `state.cwd`. The plugin SHALL
NOT accept or act upon any parameter that changes the session's active
directory as part of `use_direnv`.

#### Scenario: use_direnv loads environment without moving the active directory

- GIVEN a session with an active working directory
- WHEN `use_direnv` is called with a `path` pointing at a different directory
- THEN the session's environment is loaded from that path and the session's active working directory (`state.cwd`) is unchanged
