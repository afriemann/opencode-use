# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
