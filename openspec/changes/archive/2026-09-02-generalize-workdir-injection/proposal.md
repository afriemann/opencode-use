## Why

The plugin's automatic `workdir` injection (via `tool.execute.before`) and its
tool-schema annotation (via `tool.definition`) are currently hardcoded to the
built-in `bash` tool only. Any other custom tool in the ecosystem that accepts
a `workdir`-style path parameter does not benefit from this mechanism: the
agent must resolve and pass the active session directory manually for those
calls, which is exactly the failure mode this plugin exists to eliminate for
`bash`. This was discovered live: `git-host-check` (a separate custom tool,
`~/.config/opencode/tools/git-host-check.ts`) resolves its own optional `cwd`
argument the same way (`args.cwd → context.worktree → context.directory`),
and calling it without an explicit `cwd` after switching the active session
directory via `use_cwd`/`use_worktree` silently ran against the *original*
session directory instead — the same bug class affects any tool relying on
`context.worktree`/`context.directory` for path resolution.

Other custom tools have been standardized to expose an optional `workdir`
string parameter (matching the native `bash` convention, migrated away from
`cwd`) so this generalized injection covers them for free, with no dependency
between plugins.

## What Changes

- Generalize `tool.definition` to run for every tool (not only `bash`): cache,
  per tool ID, whether its schema declares an optional `workdir` string
  parameter, and annotate that parameter's description with the same
  auto-injection guidance previously shown only for `bash`.
- Generalize `tool.execute.before`'s workdir-injection branch to apply to any
  tool cached as workdir-capable, when the session has an active working
  directory and the call did not supply its own `workdir`. The env-export
  prefix injection remains `bash`-only, since only `bash` has a shell
  `command` string to prepend exports to.
- Generalize the `experimental.chat.system.transform` system-prompt wording
  and the `use_cwd` tool description (the only one that referenced "bash
  call" specifically) from "every bash call" to "every tool call that
  accepts a `workdir` parameter", without changing the unrelated guidance for
  `read`/`write`/`edit`/`glob`/`grep` (those tools have no `workdir`
  parameter and are unaffected).

Out of scope: migrating `opencode-openspec`'s `openspec_cli` /
`openspec_status` / `openspec_instructions` tools (or `git-host-check`) from
`cwd` to `workdir` — that is done separately, in those tools' own repos.

## Capabilities

### Modified Capabilities

- `workdir-injection`: generalizes the injection and schema-annotation
  mechanism from `bash`-only to any tool whose schema declares an optional
  `workdir` string parameter.

## Impact

- `src/index.js`: `tool.definition` hook, `tool.execute.before` hook,
  `experimental.chat.system.transform` hook, and the `use_cwd` tool
  description string.
- `test/workdir-injection.test.js` (new), `test/helpers.js` (new, extracted
  shared temp-dir helper): coverage for the generalized behavior.
- `README.md`: feature description updated to reflect generic workdir-param
  injection.
- No new dependencies. No changes to `opencode-openspec` or `git-host-check`.
