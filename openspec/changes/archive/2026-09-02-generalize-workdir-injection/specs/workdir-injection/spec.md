## REMOVED Requirements

### Requirement: Bash Tool Workdir and Environment Injection

**Reason**: Split into a generic "Tool Workdir Injection" requirement (workdir
injection now generalizes to any eligible tool) and a bash-only "Bash
Environment Injection" requirement (environment injection remains bash-only).
**Migration**: See ADDED "Tool Workdir Injection" and ADDED "Bash Environment
Injection" below.

### Requirement: Bash Tool Schema Annotation

**Reason**: Generalized and renamed to "Tool Workdir Schema Annotation" — the
annotation now applies to any eligible tool's `workdir` parameter, not only
bash's.
**Migration**: See ADDED "Tool Workdir Schema Annotation" below.

## ADDED Requirements

### Requirement: Tool Workdir Injection

The plugin SHALL intercept every tool call via the `tool.execute.before` hook
and, when the session has an active working directory (`state.cwd`), the
call's tool is cached as workdir-capable, and the call did not already
specify a `workdir` argument, set the call's `workdir` argument to
`state.cwd`. A tool SHALL be considered workdir-capable when its schema (as
reported to the `tool.definition` hook) declares a `workdir` parameter of
type `string`, with no `enum` constraint, that is not listed as `required`.
The plugin SHALL NOT record any of its own tools (`use_cwd`, `use_direnv`,
`use_worktree`, `use_clear`) as workdir-capable.

#### Scenario: Session has an active working directory, an eligible tool, call omits workdir

- GIVEN a session where `use_cwd` was previously called and the session's `cwd` is set, and a tool cached as workdir-capable
- WHEN a call to that tool is made without an explicit `workdir` argument
- THEN the plugin sets the call's `workdir` argument to the session's active working directory before it executes

#### Scenario: Call explicitly specifies its own workdir

- GIVEN a session with an active working directory and a workdir-capable tool
- WHEN a call to that tool is made with an explicit `workdir` argument
- THEN the plugin does not overwrite the explicit value

#### Scenario: Tool's workdir parameter is enum-constrained, non-string, or required

- GIVEN a tool whose schema declares a `workdir` parameter that has an `enum` constraint, is not of type `string`, or is listed in the schema's `required` array
- WHEN the `tool.definition` hook observes that schema
- THEN the plugin does not record the tool as workdir-capable, and no injection occurs for calls to that tool

#### Scenario: Tool has no workdir parameter, or was never observed by tool.definition

- GIVEN a tool that was never observed by the `tool.definition` hook, or whose schema has no `workdir` parameter
- WHEN a call to that tool is made
- THEN the plugin does not modify the call's arguments

#### Scenario: A call's arguments object is missing

- GIVEN a tool call whose `output.args` is absent
- WHEN the `tool.execute.before` hook fires for that call
- THEN the plugin performs no injection and does not throw

#### Scenario: Bash tool call, session has an active working directory

- GIVEN a session with an active working directory
- WHEN a `bash` tool call is made without an explicit `workdir` argument
- THEN the plugin sets the call's `workdir` argument to the session's active working directory, exactly as for any other workdir-capable tool

### Requirement: Bash Environment Injection

The plugin SHALL intercept every `bash` tool call via the
`tool.execute.before` hook and, when the session has a non-empty active
environment (`state.env`), prepend an `export K=V && ...` prefix built from
that environment to the call's `command` argument. This injection SHALL
apply only to the `bash` tool.

#### Scenario: Session has active environment variables

- GIVEN a session where `use_direnv` previously loaded environment variables
- WHEN a `bash` tool call is made
- THEN the plugin prepends `export K=V && ...` for each active variable to the call's `command` argument

#### Scenario: A non-bash tool call is made

- GIVEN a session with active environment variables
- WHEN a tool call is made to a tool other than `bash`
- THEN the plugin does not prepend any environment export prefix to that call

### Requirement: Tool Workdir Schema Annotation

The plugin SHALL annotate, via the `tool.definition` hook, the description
of any tool's `workdir` parameter that satisfies the workdir-capability
predicate (`string`, no `enum`, not `required`), explaining that the
parameter is auto-populated by the plugin and does not need to be set
explicitly, and that setting it explicitly overrides the injection for that
one call only. The annotation text SHALL NOT reference any specific tool by
name. The plugin SHALL append the annotation at most once per definition
object; if the parameter's description already contains the annotation, the
plugin SHALL NOT append it again.

#### Scenario: An eligible tool's schema is requested

- GIVEN a tool whose schema declares an eligible `workdir` parameter
- WHEN the `tool.definition` hook fires for that tool
- THEN the parameter's description is appended with tool-agnostic guidance explaining automatic injection and the per-call override

#### Scenario: The same definition object is annotated twice

- GIVEN a `workdir` parameter description that already contains the annotation
- WHEN the `tool.definition` hook fires again for that parameter
- THEN the plugin does not append the annotation a second time

#### Scenario: A tool's workdir parameter is not eligible

- GIVEN a tool whose `workdir` parameter is enum-constrained, non-string, or required, or which has no `workdir` parameter at all
- WHEN the `tool.definition` hook fires for that tool
- THEN the plugin does not modify that parameter's description

## MODIFIED Requirements

### Requirement: System Prompt Session Context

The plugin SHALL inject a system-prompt section, via the
`experimental.chat.system.transform` hook, describing the session's active
working directory, active environment, and active worktree (when any of
these are set), so the agent can construct correct absolute paths for tools
that have no `workdir` parameter of their own (for example `read`, `write`,
`edit`, `glob`, `grep`), and understands that any tool call which accepts a
`workdir` parameter — not only `bash` — receives it automatically.

#### Scenario: Session has active context to report

- GIVEN a session with at least one of: an active working directory, active environment, or active worktree
- WHEN the system prompt is being assembled
- THEN the plugin injects a "## Active Session Context (opencode-use)" section listing the active values and instructing the agent to build absolute paths from them for tools with no `workdir` parameter

#### Scenario: Session has no active context to report

- GIVEN a session with no active working directory, environment, or worktree
- WHEN the system prompt is being assembled
- THEN the plugin injects no session-context section
