## MODIFIED Requirements

### Requirement: Tool Workdir Injection

The plugin SHALL intercept every tool call via the `tool.execute.before` hook
and, when the session has an active working directory (`state.cwd`), the
call's tool is either `bash` or cached as workdir-capable, and the call did
not already specify a `workdir` argument, set the call's `workdir` argument
to `state.cwd`. A tool other than `bash` SHALL be considered workdir-capable
when its schema (as reported to the `tool.definition` hook) declares a
`workdir` parameter of type `string`, with no `enum` constraint, that is not
listed as `required`. The `bash` tool SHALL always be treated as eligible for
this injection, independent of what the `tool.definition` hook recorded for
it, because its real, live-converted schema does not reliably match the
eligibility predicate's assumed shape. The plugin SHALL NOT record any of its
own tools (`use_cwd`, `use_direnv`, `use_worktree`, `use_clear`) as
workdir-capable.

#### Scenario: Session has an active working directory, an eligible tool, call omits workdir

- GIVEN a session where `use_cwd` was previously called and the session's `cwd` is set, and a tool cached as workdir-capable
- WHEN a call to that tool is made without an explicit `workdir` argument
- THEN the plugin sets the call's `workdir` argument to the session's active working directory before it executes

#### Scenario: Call explicitly specifies its own workdir

- GIVEN a session with an active working directory and a workdir-capable tool
- WHEN a call to that tool is made with an explicit `workdir` argument
- THEN the plugin does not overwrite the explicit value

#### Scenario: Tool's workdir parameter is enum-constrained, non-string, or required

- GIVEN a tool other than `bash` whose schema declares a `workdir` parameter that has an `enum` constraint, is not of type `string`, or is listed in the schema's `required` array
- WHEN the `tool.definition` hook observes that schema
- THEN the plugin does not record the tool as workdir-capable, and no injection occurs for calls to that tool

#### Scenario: Tool has no workdir parameter, or was never observed by tool.definition

- GIVEN a tool other than `bash` that was never observed by the `tool.definition` hook, or whose schema has no `workdir` parameter
- WHEN a call to that tool is made
- THEN the plugin does not modify the call's arguments

#### Scenario: A call's arguments object is missing

- GIVEN a tool call whose `output.args` is absent
- WHEN the `tool.execute.before` hook fires for that call
- THEN the plugin performs no injection and does not throw

#### Scenario: Bash tool call, session has an active working directory

- GIVEN a session with an active working directory
- WHEN a `bash` tool call is made without an explicit `workdir` argument
- THEN the plugin sets the call's `workdir` argument to the session's active working directory

#### Scenario: Bash tool call injects workdir even when its live schema is not detected as eligible

- GIVEN a session with an active working directory, where the `tool.definition` hook has recorded `bash` as NOT workdir-capable (or never observed it)
- WHEN a `bash` tool call is made without an explicit `workdir` argument
- THEN the plugin still sets the call's `workdir` argument to the session's active working directory
