# workdir-injection Specification

## Purpose

Defines how the plugin automatically propagates the session's active working
directory (set via `use_workdir` / `use_worktree`) and active environment (set via
`use_direnv`) into subsequent tool calls, without the agent needing to repeat
itself, and how it informs the agent of this behaviour via tool-schema
annotation and system-prompt injection.

## Requirements

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

### Requirement: Tool Workdir Injection

The plugin SHALL intercept every tool call via the runtime's tool-execution
hook (V1: `tool.execute.before`; V2: `ctx.tool.hook("execute.before", ...)`)
and, when the session has an active working directory (`state.cwd`), the
call's tool is either the built-in shell tool (`bash` on V1, `shell` on V2)
or cached as workdir-capable, and the call did not already specify a
`workdir` argument, set the call's `workdir` argument to `state.cwd`. A tool
other than the built-in shell tool SHALL be considered workdir-capable when
its schema, as observed by the runtime's tool-schema-annotation hook (V1:
`tool.definition`; V2: `ctx.tool.transform`'s `editor.add`/`editor.update`),
declares an optional, unconstrained `workdir` string parameter.

On V1, schema sources SHALL be consulted in this order, using the first
that carries a `workdir` property: (1) `output.jsonSchema` — a JSON
Schema, using JSON Schema rules (type `string`, no `enum` constraint, not
listed as `required`); (2) `output.parameters` treated as a raw Zod schema
object (exposing a `.shape`), classified by the wrapped inner type being a
string type not required (structural detection, no external library
dependency); (3) `output.parameters` itself treated as JSON Schema, using
the same JSON Schema rules as source (1).

On V2, tool schemas are always plain JSON Schema (`Tool.Info.input`) — the
V1 three-source ladder does not apply. The V2 adapter SHALL classify a
`workdir` property using the same JSON Schema rules as V1 source (1)
(type `string`, no `enum` constraint, not listed as `required`), applied
directly to `Tool.Info.input`.

If no source carries a `workdir` property, or the property is disqualified
by its source's rules, the tool is NOT workdir-capable. The built-in shell
tool SHALL always be treated as eligible for this injection, independent of
what the schema-annotation hook recorded for it, because its real,
live-converted schema does not reliably match any detection source. The
plugin SHALL NOT record any of its own tools (`use_workdir`, `use_direnv`,
`use_worktree`, `use_clear`) as workdir-capable.

#### Scenario: Session has an active working directory, an eligible tool, call omits workdir

- GIVEN a session where `use_workdir` was previously called and the session's `cwd` is set, and a tool cached as workdir-capable
- WHEN a call to that tool is made without an explicit `workdir` argument
- THEN the plugin sets the call's `workdir` argument to the session's active working directory before it executes

#### Scenario: Call explicitly specifies its own workdir

- GIVEN a session with an active working directory and a workdir-capable tool
- WHEN a call to that tool is made with an explicit `workdir` argument
- THEN the plugin does not overwrite the explicit value

#### Scenario: Tool's workdir parameter is eligible via its JSON Schema representation

- GIVEN a tool other than the built-in shell tool whose JSON Schema representation (V1: `output.jsonSchema`; V2: `Tool.Info.input`) declares an optional, unconstrained `workdir` string parameter (the shape produced by a plugin-authored tool's schema on current opencode)
- WHEN the schema-annotation hook observes that schema
- THEN the plugin records the tool as workdir-capable

#### Scenario: Tool's workdir parameter is eligible via a raw Zod schema representation

- GIVEN a V1 host and a tool other than `bash` whose `output.parameters` is a raw Zod schema object declaring an optional `workdir` string parameter (the shape `output.parameters` took on hosts predating opencode 1.14.49)
- WHEN the `tool.definition` hook observes that schema
- THEN the plugin records the tool as workdir-capable

#### Scenario: Tool's workdir parameter is enum-constrained, non-string, or required

- GIVEN a tool other than the built-in shell tool whose schema (in whichever source is consulted for that runtime) declares a `workdir` parameter that has an `enum` constraint, is not of type `string`, or is listed as `required`
- WHEN the schema-annotation hook observes that schema
- THEN the plugin does not record the tool as workdir-capable, and no injection occurs for calls to that tool

#### Scenario: Tool has no workdir parameter, or was never observed by tool.definition

- GIVEN a tool other than the built-in shell tool that was never observed by the schema-annotation hook, or whose schema has no `workdir` parameter in any consulted source
- WHEN a call to that tool is made
- THEN the plugin does not modify the call's arguments

#### Scenario: A call's arguments object is missing

- GIVEN a tool call whose input/arguments object is absent
- WHEN the tool-execution hook fires for that call
- THEN the plugin performs no injection and does not throw

#### Scenario: Bash tool call, session has an active working directory

- GIVEN a session with an active working directory
- WHEN a built-in shell tool call is made without an explicit `workdir` argument
- THEN the plugin sets the call's `workdir` argument to the session's active working directory

#### Scenario: Bash tool call injects workdir even when its live schema is not detected as eligible

- GIVEN a session with an active working directory, where the schema-annotation hook has recorded the built-in shell tool as NOT workdir-capable (or never observed it)
- WHEN a call to the built-in shell tool is made without an explicit `workdir` argument
- THEN the plugin still sets the call's `workdir` argument to the session's active working directory

### Requirement: Tool Workdir Schema Annotation

The plugin SHALL annotate, via the runtime's schema-annotation hook (V1:
`tool.definition`; V2: `ctx.tool.transform`'s `editor.update`), the
description of any tool's `workdir` parameter that satisfies the
workdir-capability predicate in any source applicable to that runtime,
explaining that the parameter is auto-populated by the plugin and does not
need to be set explicitly, and that setting it explicitly overrides the
injection for that one call only. The annotation SHALL be written back to
whichever source matched: a JSON-Schema property's `description` is
mutated in place; on V1, a raw Zod schema's `workdir` entry is replaced with
a new schema instance carrying the updated description (Zod schemas are
immutable — in-place mutation of a Zod schema's `description` MUST NOT be
attempted). The annotation text SHALL NOT reference any specific tool by
name. The plugin SHALL append the annotation at most once per definition
object; if the parameter's description already contains the annotation, the
plugin SHALL NOT append it again.

#### Scenario: An eligible tool's schema is requested

- GIVEN a tool whose schema declares an eligible `workdir` parameter
- WHEN the schema-annotation hook fires for that tool
- THEN the parameter's description is appended with tool-agnostic guidance explaining automatic injection and the per-call override

#### Scenario: The same definition object is annotated twice

- GIVEN a `workdir` parameter description that already contains the annotation
- WHEN the schema-annotation hook fires again for that parameter
- THEN the plugin does not append the annotation a second time

#### Scenario: A tool's workdir parameter is not eligible

- GIVEN a tool whose `workdir` parameter is enum-constrained, non-string, or required, or which has no `workdir` parameter at all
- WHEN the schema-annotation hook fires for that tool
- THEN the plugin does not modify that parameter's description

### Requirement: Workdir Injection Diagnostics

The plugin SHALL log, via the existing app-log helper, its workdir-capability
recording decisions and its per-call injection decisions, so that
generalization failures are diagnosable from opencode's normal app log
without a special build. The schema-annotation hook SHALL log a
capability-recorded line only the first time a toolID is recorded, or when
its recorded eligibility changes from a previously recorded value — not on
every firing. On V1, the logged line SHALL include which schema source
(`jsonSchema`, `parameters.shape`, or `parameters`) matched, or that none
matched; on V2, which of the single JSON Schema classification's outcomes
applied (matched or not matched), since only one source exists. When the
recorded eligibility is `false`, the logged line SHALL additionally include
the raw `workdir` property (if any) and the schema's `required` array, so
the exact disqualifying condition is visible directly in the log without a
further debug round-trip. The tool-execution hook SHALL log an
injection-decision line only when the session has an active working
directory (`state.cwd` truthy) — the only condition under which an injection
decision is meaningful — and SHALL NOT log anything when there is no active
working directory.

#### Scenario: A toolID's workdir-capability is recorded for the first time

- GIVEN a toolID that has never been recorded in the workdir-capability cache
- WHEN the schema-annotation hook fires for that toolID
- THEN the plugin logs a line reporting the toolID, its recorded eligibility, and which schema source matched (or that none matched)

#### Scenario: A toolID's recorded eligibility changes

- GIVEN a toolID previously recorded with one eligibility value
- WHEN the schema-annotation hook fires again for that toolID with a schema that yields a different eligibility value
- THEN the plugin logs a line reporting the toolID and its new eligibility

#### Scenario: A toolID's recorded eligibility is unchanged

- GIVEN a toolID previously recorded with a given eligibility value
- WHEN the schema-annotation hook fires again for that toolID with a schema that yields the same eligibility value
- THEN the plugin does not log a capability-recorded line for that firing

#### Scenario: A toolID is recorded as ineligible

- GIVEN a tool whose schema's `workdir` property (or absence, or `required` listing) disqualifies it from workdir-capability
- WHEN the schema-annotation hook records that toolID as ineligible for the first time or on a change from eligible
- THEN the plugin logs a line including the raw `workdir` property value and the schema's `required` array, in addition to the toolID and the `false` verdict

#### Scenario: Injection happens

- GIVEN a session with an active working directory and a call to an eligible tool that omits `workdir`
- WHEN the tool-execution hook injects the active working directory into the call
- THEN the plugin logs a line reporting the tool and the injected value

#### Scenario: Injection is skipped because the call already has an explicit workdir

- GIVEN a session with an active working directory and a call that already specifies `workdir`
- WHEN the tool-execution hook fires for that call
- THEN the plugin logs a line reporting that injection was skipped because an explicit value was already present

#### Scenario: Injection is skipped because the tool is not recorded as workdir-capable

- GIVEN a session with an active working directory and a call to a tool other than the built-in shell tool that is not recorded as workdir-capable
- WHEN the tool-execution hook fires for that call
- THEN the plugin logs a line reporting that injection was skipped because the tool was not recorded as workdir-capable

#### Scenario: No active working directory

- GIVEN a session with no active working directory
- WHEN the tool-execution hook fires for any call
- THEN the plugin logs no injection-decision line

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
