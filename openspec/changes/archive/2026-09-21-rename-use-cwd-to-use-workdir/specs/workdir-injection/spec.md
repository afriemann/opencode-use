## MODIFIED Requirements

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
