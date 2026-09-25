# context-autoload Specification

## Purpose
Automatically discovers a target repository's `AGENTS.md` and `.envrc`
presence whenever `use_workdir` or `use_worktree` moves the session's active
directory to a genuinely new path, injecting the found `AGENTS.md` content
into the system prompt as clearly-labeled advisory context and reminding the
agent to load `.envrc` explicitly, without ever executing it automatically.

## Requirements

### Requirement: Directory-Change Detection Gate

The plugin SHALL perform repository-context discovery (`AGENTS.md` search and
`.envrc` detection) only when a call to `use_workdir`, or any of `use_worktree`'s
three success paths, resolves to a directory that differs from the session's
current `state.cwd` at the time of the call. When the resolved directory is
identical to the session's current `state.cwd`, the plugin SHALL still assign
`state.cwd` to that value but SHALL NOT run discovery, SHALL NOT invoke `git`
or read any file for this purpose, and SHALL NOT append any repository-context
note to the tool's return value.

#### Scenario: use_workdir moves to a genuinely new directory

- GIVEN a session whose current `state.cwd` differs from the path passed to `use_workdir`
- WHEN `use_workdir` resolves and validates the new path
- THEN the plugin runs repository-context discovery for the resolved directory

#### Scenario: use_workdir is called again with the same resolved directory

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
system prompt via the runtime's session-context hook (V1:
`experimental.chat.system.transform`; V2: `ctx.session.hook("context", ...)`)
whenever that content is present, as a distinct block appended after the
existing "Active Session Context (opencode-use)" block. This block SHALL
state the repository path (the discovered git root, or the resolved
directory itself when not in a git repository) and the file's path, SHALL
explicitly label the content as repository-provided, advisory context that
does not override the agent's own operating instructions and loses to them
on conflict, and SHALL caution that the content may originate from a branch
the agent itself navigated to rather than one the user chose, and so SHALL
be treated as untrusted input rather than as commands. The content SHALL be
wrapped in a fenced code region whose fence length is computed from the
content: the plugin SHALL scan the content for lines that, after stripping
leading whitespace, consist solely of backtick characters, take the length
of the longest such line (zero if none exist), and use a fence of at least
one character longer than that length, with a minimum of three characters,
so that no line within the content can terminate the fenced region. When the
session's stored `AGENTS.md` content is absent, the plugin SHALL NOT inject
this block. This requirement's behavior is identical on both runtimes; only
the underlying hook mechanism differs.

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
the `.envrc` file's contents, for this detection step itself. When such a
file is found, discovery SHALL report the file's path to its caller so the
caller can decide whether to load it.

When `use_workdir` or `use_worktree` resolves to a genuinely new directory
(per the Directory-Change Detection Gate) and discovery reports an `.envrc`
path, the plugin SHALL check, via `direnv status --json` anchored at the
directory containing the discovered `.envrc`, whether that file is already
allowed by `direnv`. If it is already allowed, the plugin SHALL load its
environment via `direnv export json`, anchored at the same directory, and
SHALL assign the resulting variables to the session's active environment,
overwriting any previously loaded environment. If the file is not yet
allowed, or if the allowed-check itself cannot be completed (`direnv` is
absent, times out, or returns an unparseable result), the plugin SHALL NOT
invoke `direnv export`, and SHALL instead append a non-blocking note to the
tool's return value suggesting that the agent call `use_direnv` explicitly to
load it — exactly today's behavior. A failure while loading an already-allowed
`.envrc` (a non-zero exit, a timeout, or an unparseable result) SHALL leave
the session's active environment and its source unchanged, and SHALL append a
note naming the failure and suggesting a manual `use_direnv` retry. This
auto-load behavior SHALL NOT alter the directory or ancestor boundary used to
detect the `.envrc` file's existence, and SHALL NOT cause discovery itself to
invoke a `direnv` subprocess — only the caller, once discovery has returned,
may do so.

#### Scenario: .envrc exists between the resolved directory and the git root

- GIVEN a resolved directory where an `.envrc` file exists at the directory itself or an ancestor up to the git root boundary, and that file is not yet allowed by `direnv`
- WHEN repository-context discovery runs for that directory and the caller checks whether to auto-load it
- THEN the tool's return value includes a note suggesting the agent call `use_direnv` to load it, and the session's active environment is unchanged

#### Scenario: No .envrc exists

- GIVEN a resolved directory where no `.envrc` file exists at the directory or any ancestor up to the git root boundary
- WHEN repository-context discovery runs for that directory
- THEN the tool's return value includes no `.envrc`-related note

#### Scenario: Detection never invokes a direnv subprocess

- GIVEN repository-context discovery running for any resolved directory
- WHEN the `.envrc` detection check executes
- THEN no `direnv` subprocess is invoked, regardless of whether an `.envrc` file is found

#### Scenario: Already-allowed .envrc is auto-loaded on a genuine directory change

- GIVEN a resolved directory whose discovered `.envrc` is already allowed by `direnv` (per `direnv status --json`)
- WHEN `use_workdir` or `use_worktree` resolves to that directory for the first time (a genuinely new `state.cwd`)
- THEN the plugin loads the file's environment via `direnv export json`, assigns it to the session's active environment and its source, and the tool's return value includes a note stating how many variables were loaded

#### Scenario: Already-allowed .envrc with no environment changes exported

- GIVEN a resolved directory whose discovered `.envrc` is already allowed by `direnv`, but its export produces no variables
- WHEN `use_workdir` or `use_worktree` resolves to that directory for the first time
- THEN the plugin still marks the environment as loaded from that source, and the tool's return value states that no environment changes were exported

#### Scenario: Auto-load anchors on the directory discovery reported, not the resolved leaf

- GIVEN a resolved directory whose `.envrc` was found at an ancestor directory rather than at the resolved directory itself
- WHEN the plugin checks whether the `.envrc` is allowed and, if so, loads it
- THEN both the allowed-check and the environment load run anchored at the ancestor directory that contains the discovered `.envrc`, never at the resolved leaf directory

#### Scenario: Auto-load never runs direnv allow

- GIVEN a resolved directory whose discovered `.envrc` is not yet allowed by `direnv`
- WHEN the plugin performs the allowed-check for that directory
- THEN the plugin does not run `direnv allow`, and falls back to the non-blocking suggestion note

#### Scenario: Failed load of an already-allowed .envrc leaves the environment unchanged

- GIVEN a resolved directory whose discovered `.envrc` is already allowed by `direnv`, but the `direnv export json` invocation fails or times out
- WHEN the plugin attempts to auto-load its environment
- THEN the session's active environment and its source are left unchanged, and the tool's return value includes a note naming the failure and suggesting a manual `use_direnv` retry

#### Scenario: Auto-load overwrites a previously loaded environment

- GIVEN a session with a previously loaded active environment
- WHEN `use_workdir` or `use_worktree` resolves to a new directory whose discovered `.envrc` is already allowed
- THEN the newly loaded environment replaces the previous one

#### Scenario: Moving to a directory with no or not-yet-allowed .envrc does not clear the existing environment

- GIVEN a session with a previously loaded active environment
- WHEN `use_workdir` or `use_worktree` resolves to a new directory that has no `.envrc`, or whose `.envrc` is not yet allowed
- THEN the session's previously loaded environment and its source remain unchanged

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

### Requirement: Session-Start Directory Initialization

When a new session is created, on either supported host runtime, the plugin
SHALL initialize the session's active directory (`state.cwd`) from the host's
reported starting location, for every session including subagent and child
sessions, without any special-casing based on parentage. The plugin SHALL
derive the starting directory by joining the host-reported directory with any
host-reported subpath. When the host-reported location indicates the
directory is not a local filesystem path (for example, it carries a
workspace identifier rather than a plain directory), the plugin SHALL skip
initialization entirely for that session. Once a starting directory is
resolved, the plugin SHALL run the same repository-context discovery used by
`use_workdir` — including `AGENTS.md` loading and the `.envrc`-found note —
but SHALL NOT auto-load the discovered `.envrc`'s environment as part of
session-start initialization, regardless of whether it is already allowed by
`direnv`. If, by the time session-start initialization would run, the
session's active directory has already been set by an explicit tool call,
the plugin SHALL skip initialization without altering the existing state.

#### Scenario: Session start initializes cwd and AGENTS.md without loading env

- GIVEN a new session created with a reported starting directory that resolves to a local filesystem path
- WHEN the plugin initializes the session
- THEN the session's active directory is set to that path, any discovered `AGENTS.md` is loaded, any discovered `.envrc` produces only the non-blocking suggestion note, and the session's active environment remains empty

#### Scenario: Session start is skipped for a non-local starting location

- GIVEN a new session whose reported starting location carries a workspace identifier rather than a plain local directory
- WHEN the plugin would otherwise initialize the session
- THEN the plugin performs no filesystem check, no discovery, and leaves the session's active directory unset

#### Scenario: Session start applies uniformly to subagent sessions

- GIVEN a new subagent or child session created with a reported starting directory
- WHEN the plugin initializes the session
- THEN initialization proceeds identically to a top-level session, with no special-casing based on the session's parentage

#### Scenario: An explicit directory change before initialization completes takes precedence

- GIVEN a new session whose start-of-session initialization has not yet completed
- WHEN an explicit `use_workdir` or `use_worktree` call sets the session's active directory before initialization runs
- THEN initialization does not overwrite the explicitly set directory or any state derived from it

### Requirement: V2 Session-Move Directory Synchronization

On the V2 host runtime only, when a session is moved to a new location, the
plugin SHALL treat the move identically to an explicit `use_workdir` call to
that new location for the moved session's tracked state: it SHALL derive the
target directory the same way as session-start initialization (joining the
reported directory with any reported subpath, skipping entirely when the
location is not a local filesystem path), run the same repository-context
discovery, and — unlike session-start initialization — SHALL auto-load the
discovered `.envrc`'s environment when it is already allowed by `direnv`,
under the same conditions and fallback behavior as an explicit `use_workdir`
call. This requirement applies only on the V2 host runtime; the V1 host
runtime has no equivalent session-move event and SHALL NOT be expected to
provide this behavior.

#### Scenario: Session move to a directory with an already-allowed .envrc auto-loads its environment

- GIVEN a V2 session that is moved to a new local-filesystem directory whose discovered `.envrc` is already allowed by `direnv`
- WHEN the plugin observes the move
- THEN the session's active directory is updated to the new location and its environment is auto-loaded exactly as an explicit `use_workdir` call would

#### Scenario: Session move to a non-local location is skipped

- GIVEN a V2 session that is moved to a location carrying a workspace identifier rather than a plain local directory
- WHEN the plugin observes the move
- THEN the plugin performs no filesystem check, no discovery, and does not alter the session's tracked directory

#### Scenario: V1 has no session-move equivalent

- GIVEN the V1 host runtime
- WHEN a session's working directory changes outside of an explicit `use_workdir`/`use_worktree` call
- THEN the plugin provides no equivalent automatic directory synchronization, since no V1 event reports such a move
