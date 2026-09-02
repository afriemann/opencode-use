# workdir-injection Specification

## Purpose

Defines how the plugin automatically propagates the session's active working
directory (set via `use_cwd` / `use_worktree`) and active environment (set via
`use_direnv`) into subsequent tool calls, without the agent needing to repeat
itself, and how it informs the agent of this behaviour via tool-schema
annotation and system-prompt injection.

## Requirements

### Requirement: Bash Tool Workdir and Environment Injection

The plugin SHALL intercept every `bash` tool call via the `tool.execute.before`
hook and, when the session has an active working directory (`state.cwd`) and
the call did not already specify a `workdir` argument, set the call's
`workdir` argument to `state.cwd`. The plugin SHALL also prepend an
`export K=V && ...` prefix built from the session's active environment
(`state.env`) to the call's `command` argument, when the session has a
non-empty active environment.

#### Scenario: Session has an active working directory, call omits workdir

- GIVEN a session where `use_cwd` was previously called and the session's `cwd` is set
- WHEN a `bash` tool call is made without an explicit `workdir` argument
- THEN the plugin sets the call's `workdir` argument to the session's active working directory before it executes

#### Scenario: Call explicitly specifies its own workdir

- GIVEN a session with an active working directory
- WHEN a `bash` tool call is made with an explicit `workdir` argument
- THEN the plugin does not overwrite the explicit value

#### Scenario: Session has active environment variables

- GIVEN a session where `use_direnv` previously loaded environment variables
- WHEN a `bash` tool call is made
- THEN the plugin prepends `export K=V && ...` for each active variable to the call's `command` argument

### Requirement: Bash Tool Schema Annotation

The plugin SHALL annotate the `bash` tool's `workdir` parameter description,
via the `tool.definition` hook, to inform the agent that the parameter is
auto-populated by the plugin and does not need to be set explicitly, and that
setting it explicitly overrides the injection for that one call only.

#### Scenario: Bash tool schema is requested

- GIVEN the `bash` tool's schema includes a `workdir` parameter
- WHEN the `tool.definition` hook fires for the `bash` tool
- THEN the `workdir` parameter's description is appended with guidance explaining automatic injection and the per-call override

### Requirement: System Prompt Session Context

The plugin SHALL inject a system-prompt section, via the
`experimental.chat.system.transform` hook, describing the session's active
working directory, active environment, and active worktree (when any of
these are set), so the agent can construct correct absolute paths for
non-`bash` tools (`read`, `write`, `edit`, `glob`, `grep`) that have no
`workdir` parameter of their own.

#### Scenario: Session has active context to report

- GIVEN a session with at least one of: an active working directory, active environment, or active worktree
- WHEN the system prompt is being assembled
- THEN the plugin injects a "## Active Session Context (opencode-use)" section listing the active values and instructing the agent to build absolute paths from them for `read`, `write`, `edit`, `glob`, and `grep`

#### Scenario: Session has no active context to report

- GIVEN a session with no active working directory, environment, or worktree
- WHEN the system prompt is being assembled
- THEN the plugin injects no session-context section
