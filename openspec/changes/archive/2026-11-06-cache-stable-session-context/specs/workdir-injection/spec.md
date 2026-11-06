# Spec Delta

## MODIFIED Requirements

### Requirement: System Prompt Session Context

The plugin SHALL describe the session's active working directory, environment
source and variable count, and active worktree through the runtime's
session-context hook, so the agent can construct correct absolute paths for
tools that have no `workdir` parameter of their own (for example `read`, `write`,
`edit`, `glob`, `grep`), and understands that any tool call accepting `workdir`,
not only the shell tool (`bash` on V1, `shell` on V2), receives it automatically.
V1 SHALL retain system-prompt delivery through
`experimental.chat.system.transform`, omitting the section when no context is
active. V2 SHALL deliver complete replacement snapshots through
`ctx.session.hook("context", ...)` messages, explicitly marking absent cwd,
environment, worktree, and concurrency warning. A loaded environment exporting
zero variables SHALL remain distinguishable from no loaded environment.

#### Scenario: Session has active context to report

- **GIVEN** a session with an active working directory, loaded environment, or active worktree
- **WHEN** model context is assembled
- **THEN** the plugin supplies an "Active Session Context (opencode-use)" section with current metadata and absolute-path/automatic-workdir guidance using the transport for that runtime
- **AND** an environment source exporting zero variables is reported as loaded with count zero

#### Scenario: Session has no active context to report

- **GIVEN** a session with no active working directory, loaded environment, or worktree
- **WHEN** model context is assembled
- **THEN** V1 supplies no session-context section
- **AND** V2's applicable snapshot explicitly reports absence rather than leaving earlier values applicable

### Requirement: Shell Environment Injection

The plugin SHALL register a shell-environment hook (V1: `shell.env`; V2:
`ctx.shell.hook("create.before", ...)`) that populates the shell call's
environment (V1: `output.env`; V2: `event.env`) with a session's active
environment (`state.env`), resolved as described below, for every shell
invocation opencode triggers. This mechanism SHALL NOT modify the
`command`/`shell` invocation string of any tool call, under any
circumstance.

**V1 session resolution.** The `shell.env` hook payload carries a
`sessionID`. The plugin SHALL inject the named session's active environment
when the `sessionID` is known; when the invocation carries no `sessionID`,
or an unrecognized one, the plugin SHALL NOT modify `output.env`.

**V2 session resolution.** The `ShellCreateBefore` payload carries no
`sessionID`, so the V1 resolution rule above cannot be applied as written.
The plugin SHALL instead resolve which session's environment to inject using
this fail-closed ladder, evaluated in order:

1. If exactly one tracked session has a non-empty active environment, use
   that session's environment.
2. Otherwise, if exactly one env-bearing session's `state.cwd` equals the
   invocation's `cwd`, or is an ancestor of it, use that session's
   environment.
3. Otherwise, inject nothing, and log once naming the candidate sessions.

This ladder SHALL NEVER inject one session's environment into a shell
invocation resolved (by rule 2) or attributable (by rule 1) to a different
session; an ambiguous case SHALL always resolve to "inject nothing" (rule
3), never to a guessed session. The applicable V2 context snapshot SHALL
state, when more than one session is concurrently tracked with a non-empty
environment, that shell-environment injection is best-effort and may be
suppressed in that situation. Warning freshness follows Settled V2 Session
Context.

Only environment variable keys that are POSIX-portable identifiers
(matching `[A-Za-z_][A-Za-z0-9_]*`) SHALL be injected; other keys are
silently excluded. The keys `PWD` and `OLDPWD`, and any key starting with
`DIRENV_`, SHALL also be excluded from injection regardless of whether
they are POSIX-portable, since they are owned by the shell itself or by
direnv's own bookkeeping and would otherwise conflict with the
independently-set working directory or confuse a direnv-hooked child
shell. Key matching SHALL be exact-case.

The hook SHALL NOT throw or reject under any internal fault; any error
SHALL be caught and logged, leaving the shell call's environment unmodified
by the failed operation.

#### Scenario: Session has active environment variables

- **WHEN** the shell-environment hook fires and a session's environment can be resolved (V1: by its `sessionID`; V2: by the fail-closed ladder) to a session where `use_direnv` previously loaded `FOO=bar` and `BAZ=qux`
- **THEN** the shell call's environment contains exactly `FOO: 'bar'` and `BAZ: 'qux'`

#### Scenario: Command string is never modified

- **WHEN** a built-in shell tool call is made for a session with active environment variables
- **THEN** the call's command/invocation string is unchanged from what the caller supplied

#### Scenario: Invocation carries no session ID

- **WHEN** the `shell.env` hook fires on V1 with `sessionID` undefined
- **THEN** `output.env` is not modified

#### Scenario: Invocation carries an unknown session ID

- **WHEN** the `shell.env` hook fires on V1 with a `sessionID` that no tool has ever executed under
- **THEN** `output.env` is not modified

#### Scenario: Exactly one session has a non-empty environment (V2)

- **GIVEN** on V2, exactly one tracked session has a non-empty active environment
- **WHEN** the `create.before` hook fires for a shell invocation
- **THEN** the plugin injects that session's environment, regardless of the invocation's `cwd`

#### Scenario: Multiple sessions have non-empty environments, one matches by cwd (V2)

- **GIVEN** on V2, two or more tracked sessions have a non-empty active environment, and exactly one of their `state.cwd` values equals or is an ancestor of the invocation's `cwd`
- **WHEN** the `create.before` hook fires for that invocation
- **THEN** the plugin injects only the cwd-matching session's environment

#### Scenario: Multiple sessions have non-empty environments, none resolvable by cwd (V2)

- **GIVEN** on V2, two or more tracked sessions have a non-empty active environment, and none of their `state.cwd` values equals or is an ancestor of the invocation's `cwd`
- **WHEN** the `create.before` hook fires for that invocation
- **THEN** the plugin injects no environment and logs the candidate sessions once

#### Scenario: Malformed variable names are excluded

- **WHEN** the shell-environment hook fires for a session whose active environment contains both a well-formed key and keys that are not POSIX-portable identifiers (e.g. starting with a digit, containing a space, containing a hyphen, or empty)
- **THEN** only the well-formed key appears in the shell call's environment

#### Scenario: Shell- and direnv-owned keys are excluded

- **WHEN** the shell-environment hook fires for a session whose active environment contains `PWD`, `OLDPWD`, and a `DIRENV_`-prefixed key alongside an ordinary key
- **THEN** the shell call's environment contains the ordinary key only, and not `PWD`, `OLDPWD`, or the `DIRENV_`-prefixed key

#### Scenario: Session has an empty environment

- **WHEN** the shell-environment hook fires for a session where `use_direnv` loaded no variables
- **THEN** the shell call's environment is not modified and the hook resolves normally

#### Scenario: An internal fault never propagates

- **WHEN** the shell-environment hook encounters an internal error while applying a session's active environment
- **THEN** the hook resolves without throwing or rejecting, and the error is logged

## ADDED Requirements

### Requirement: Cache-Stable V2 Context Delivery

The plugin SHALL preserve its already-delivered V2 context messages at their
original surviving transcript boundaries, adding a snapshot only when applicable
context changes. Its system contribution SHALL be constant trust framing with no
live session data. Structural prefix preservation is not a provider cache-hit or
billing guarantee.

#### Scenario: Unchanged tool loops preserve delivered context positions

- **GIVEN** a V2 session whose context has already been delivered
- **WHEN** additional unchanged-context tool continuations are assembled
- **THEN** the system contribution remains identical and each existing snapshot appears once at its original boundary before the new continuation
- **AND** no new snapshot is added

#### Scenario: Context transitions append replacement snapshots

- **GIVEN** an existing V2 transcript with delivered context
- **WHEN** cwd, worktree, environment metadata, advisory selection, or warning changes
- **THEN** one complete replacement snapshot is appended after the current host transcript
- **AND** earlier surviving messages and snapshot positions remain unchanged

### Requirement: Settled V2 Session Context

The plugin SHALL derive V2 context at the hook's final settled snapshot after
pending context mutations and host-location reconciliation, using the current
env-bearing count across all tracked sessions. Reconciliation SHALL preserve
explicit directory overrides when the host location has not changed. Transitions
after that snapshot SHALL be reflected on the following request.

#### Scenario: Other sessions change the environment concurrency warning

- **GIVEN** the requesting session's own context is unchanged
- **WHEN** another tracked session loads or clears a nonempty environment before the settled snapshot, including after native instruction preparation
- **THEN** the next applicable snapshot adds or removes the concurrency warning according to the current count
- **AND** the shell-environment resolution ladder remains unchanged

#### Scenario: Pending discovery and delayed host moves settle coherently

- **GIVEN** context discovery or a native host move is pending, or an explicit directory override is active
- **WHEN** a V2 request is assembled, including a state transition during journal persistence
- **THEN** the applicable snapshot contains one settled directory/advisory/environment selection rather than mixed discovery results
- **AND** an unprocessed host move is reconciled without treating an unchanged host location as permission to overwrite the explicit override

### Requirement: V2 Context Replay Lifecycle

The plugin SHALL preserve eligible context replay across plugin restart/resume
without restoring execution state from snapshots, and SHALL isolate each session's
journal from other sessions and forks.

#### Scenario: Plugin reload replays context without restoring execution state

- **GIVEN** stored snapshots and surviving host history for a session
- **WHEN** the plugin reloads and the session resumes
- **THEN** eligible snapshots retain their bytes and boundaries
- **AND** a replacement reflects current live state without restoring loaded environment values or worktree ownership from the journal

#### Scenario: Forks do not inherit another session's journal

- **GIVEN** a session with stored context snapshots
- **WHEN** a fork assembles its context
- **THEN** it starts its own context journal and receives its own current snapshot
- **AND** neither session replays records belonging to the other

### Requirement: V2 Context History Windows

The plugin SHALL replay a snapshot only against its exact surviving host-prefix
anchor and history generation. Unmatched records SHALL remain ineligible rather
than being relocated; records belonging to potentially reversible history windows
SHALL remain available for exact replay while that history survives.

#### Scenario: Reversible history windows retain dormant snapshots

- **GIVEN** context snapshots belonging to a host transcript
- **WHEN** staged revert, textual compaction, native-window compaction, or model-dependent fallback changes the visible history window
- **THEN** only exact eligible anchors are replayed, including protection for empty-prefix anchors across generations
- **AND** returning to an eligible window restores its historical snapshot bytes and positions without making a retired snapshot the current context

#### Scenario: Invalidated transcript suffixes never relocate snapshots

- **GIVEN** snapshots anchored after a host prefix that is deleted or replaced
- **WHEN** the surviving transcript is assembled, including after committed revert
- **THEN** unmatched suffix snapshots are not replayed at similar-looking messages or at the tail
- **AND** unaffected-prefix snapshots retain their positions and a current replacement is appended when needed

### Requirement: V2 Context Journal Privacy

The plugin SHALL retain only rendered context snapshots, prefix fingerprints, and
minimal ordering/version/generation metadata for replayable host-session history.
It SHALL NOT persist environment maps or values, host conversation text, raw
requests, execution state, or errors in that journal. Clearing context withdraws
current applicability rather than erasing already-transmitted history.

#### Scenario: Persisted journal excludes execution and host conversation data

- **GIVEN** a session containing environment values and host-message content not present in the approved context rendering
- **WHEN** context is journaled and replayed
- **THEN** storage contains only snapshots, fingerprints, and minimal structural metadata
- **AND** neither environment values nor host-message excerpts are copied into journal records

#### Scenario: Clearing context does not silently rewrite retained history

- **GIVEN** previously delivered advisory and environment metadata
- **WHEN** current context is cleared or a corrected advisory is selected
- **THEN** historical copies remain immutable while their host history is replayable
- **AND** the applicable replacement explicitly withdraws obsolete values and guidance

### Requirement: V2 Context Journal Erasure

The plugin SHALL remove journal and replay state after observed session deletion
without recreation by its own queued work after cleanup completes. It SHALL
recover orphan journals through authoritative existence reconciliation at startup,
before replay, and periodically while loaded. Confirmed absence permits removal;
indeterminate checks do not prove erasure. This is not globally atomic erasure
across independent writers.

#### Scenario: Session deletion drains pending writes before final erasure

- **GIVEN** a session journal with pending rendering or persistence
- **WHEN** session deletion is observed and cleanup completes
- **THEN** journal records and in-memory replay state are removed
- **AND** work queued under the deleted lifecycle cannot recreate them

#### Scenario: Missed deletion events are reconciled authoritatively

- **GIVEN** an orphan journal whose deletion event was missed
- **WHEN** startup, pre-replay, or periodic reconciliation confirms that its host session does not exist
- **THEN** the orphan is removed and not replayed
- **AND** an API failure is not misclassified as confirmed absence

### Requirement: V2 Context Delivery Failure

The plugin SHALL prevent provider dispatch when safe journal reconstruction,
persistence, or session existence cannot be established, reporting a sanitized
failure rather than silently sending stale context, dropping warnings, changing
system delivery, or logging sensitive prompts or environment values.

#### Scenario: Unsafe context delivery fails before provider dispatch

- **GIVEN** unreadable or invalid journal state, rejected persistence, storage exhaustion, or an indeterminate host-session check
- **WHEN** a V2 request needs context delivery
- **THEN** request preparation fails before provider dispatch with a sanitized diagnostic
- **AND** no mutable-system fallback or incomplete-context request is sent
