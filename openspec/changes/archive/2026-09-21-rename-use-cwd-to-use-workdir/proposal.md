## Why

The tool that sets the session's active working directory is currently named
`use_cwd`. The project's own established convention for a working-directory
parameter (documented in the `opencode-plugin-dev` skill, already applied to
the `workdir` parameter name used throughout this plugin's other tools and
its `workdir-injection` capability) is `workdir`, not `cwd`. Renaming the
tool itself to `use_workdir` aligns its name with that convention and with
the vocabulary already used everywhere else in this codebase (the
`workdir-injection` spec, the `workdir` parameter auto-injected into other
tool calls, and the "Active Session Context" system-prompt block).

This is a pure rename: no behavior, schema shape, or business logic changes.
`src/core.js`'s `executeUseCwd` function and all its logic are unchanged;
only the exported/registered tool name, its description text, and every
human-readable cross-reference to that name change.

## What Changes

- Rename the tool `use_cwd` → `use_workdir` in both plugin adapters
  (`src/plugin.v1.js`, `src/plugin.v2.js`) and in the shared core
  (`src/core.js`): the registered tool key/`name`, the `TOOL_TEXT.use_cwd`
  description/parameter text keys, the `SELF_TOOL_NAMES` set entry, the
  `V2_TOOL_OPTIONS` entry (`V2_CUSTOM_TOOL_NAMES` is derived from
  `V2_TOOL_OPTIONS`'s keys and needs no separate edit), and all in-code
  cross-reference strings: log messages, `use_direnv`'s description
  (`core.js:407`) and `use_worktree`'s description (`core.js:425,427`),
  which each name `use_cwd` as a prerequisite, and `lib.js`'s
  error-guidance text (`lib.js:129`).
- Rename the corresponding exported/internal function `executeUseCwd` →
  `executeUseWorkdir` in `src/core.js` (internal identifier, not part of the
  model-facing contract, but renamed for consistency — no behavior change).
- Update `README.md`: every prose, heading, and code-sample reference to
  `use_cwd` becomes `use_workdir`.
- Update `docs/v2-compat-audit.md`'s embedded tool-name references,
  including its empirical CLI transcript (a live `use_cwd` invocation) and
  its reference to the `executeUseCwd` function name (`docs/v2-compat-audit.md:112`)
  — reworded for consistency (historical narrative content, not re-verified
  against a live run).
- Update the 4 existing main spec files that reference `use_cwd` in
  requirement prose or scenario GIVEN/WHEN/THEN text
  (`context-autoload`, `path-resolution`, `workdir-injection`,
  `worktree-git-root`) via MODIFIED delta requirements. Each MODIFIED delta
  reproduces its requirement's **complete** body verbatim (all scenarios,
  not just the ones mentioning `use_cwd`) per `openspec archive`'s
  wholesale-replacement semantics — see `tasks.md`.
- Update the corresponding test files (`test/context-autoload.test.js`,
  `test/path-resolution.test.js`, `test/plugin-v2-conformance.test.js`,
  `test/resolve-git-root.test.js`, `test/use-clear-worktree-cleanup.test.js`,
  `test/workdir-injection.test.js`, and **`test/e2e/run.mjs`**) to
  call/assert `use_workdir` instead of `use_cwd`, renaming any test name
  that names the tool directly. `test/e2e/run.mjs` is wired to the
  `test:e2e` npm script (not part of default `npm test`, which only
  collects `*.test.js`); it sends a live prompt naming `use_cwd` (line 73)
  and asserts on a "no tool named use_cwd" string (line 91) — both are
  edited to the new name. `test:e2e` requires a live model credential and
  is run manually before release, not as part of this change's automated
  verification (per its own pre-existing exclusion from CI); it will be run
  once locally after the rename to confirm the edited assertions pass.
- **BREAKING**: any existing user or automation that calls the `use_cwd`
  tool by name must be updated to call `use_workdir` instead — there is no
  backward-compatible alias, per user direction (this is a personal/solo,
  pre-1.0, unpublished project with a single consumer — no version bump or
  changelog entry is added; the README rename is the sole user-facing
  record of the break).

Out of scope:
- `openspec/changes/archive/**` is a frozen historical record and is
  **not** modified — every `use_cwd` reference in an already-archived
  change's `proposal.md`/`design.md`/`tasks.md`/frozen delta specs stays
  exactly as written.
- `docs/v2-compat-audit.md`'s historical narrative determinations
  (empirical test conclusions, dates, version numbers) are not re-verified
  live; only its embedded tool-name references are reworded.
- Two scenario titles in `context-autoload`'s main spec
  (`context-autoload/spec.md:23,29`) that literally contain the string
  `use_cwd` in their title text keep that title text in this change's
  delta, required by `openspec archive`'s exact-title matching for
  MODIFIED requirements. The `## Purpose` preambles of `context-autoload`,
  `path-resolution`, and `workdir-injection` (which each mention `use_cwd`
  above the `## Requirements` section, out of reach of any delta) are
  likewise left as-is by the delta. All of the above — the 2 scenario
  titles, the 3 Purpose preambles, and one unrelated pre-existing stray
  `</content>` artifact at `context-autoload/spec.md:196` — are renamed or
  cleaned up in one small follow-up edit directly to the merged main
  specs, immediately after `openspec archive` completes, as its own commit
  separate from the archival commit (see `tasks.md`; editing a main spec
  is only forbidden before archive, not after).

## Design

No `design.md` is authored for this change. The only decision in this
change with any design content — ship a backward-compatible `use_cwd`
alias/deprecation shim, or hard-rename with no alias — was pre-settled by
an explicit, attributed user constraint (solo/personal project, no external
consumers to preserve compatibility for; see "BREAKING" above). Every other
edit is mechanical identifier substitution across files with no
architectural dimension, no component-boundary change, no infrastructure or
configuration change, and no new dependency. `design.md` would record one
already-decided decision and no trade-offs, so it is skipped.

## Capabilities

### Modified Capabilities

- `context-autoload`: the "Directory-Change Detection Gate" requirement's
  prose and GIVEN/WHEN/THEN scenario bodies now reference `use_workdir`
  instead of `use_cwd` (2 nested scenario titles keep their literal
  `use_cwd` wording in this delta per the archive title-matching
  requirement; see note above).
- `path-resolution`: the "Relative Path Resolution Against Base Directories"
  requirement's prose and scenario bodies now reference `use_workdir`.
- `workdir-injection`: the "Tool Workdir Injection" requirement's prose
  (the list of the plugin's own self-tool names) now reads `use_workdir`
  instead of `use_cwd`.
- `worktree-git-root`: the "Git Root Selection" requirement's prose and all
  four scenario bodies now reference `use_workdir` instead of `use_cwd`.

## Impact

- **Affected code**: `src/core.js`, `src/plugin.v1.js`, `src/plugin.v2.js`,
  `src/lib.js`, `README.md`, `docs/v2-compat-audit.md`.
- **Affected tests**: `test/context-autoload.test.js`,
  `test/path-resolution.test.js`, `test/plugin-v2-conformance.test.js`,
  `test/resolve-git-root.test.js`, `test/use-clear-worktree-cleanup.test.js`,
  `test/workdir-injection.test.js`, `test/e2e/run.mjs`.
- **Affected specs**: `openspec/specs/context-autoload/spec.md`,
  `openspec/specs/path-resolution/spec.md`,
  `openspec/specs/workdir-injection/spec.md`,
  `openspec/specs/worktree-git-root/spec.md` (all via this change's delta
  specs, merged by `openspec archive`).
- **No dependency, schema, or infrastructure changes.**
- **Breaking for any existing caller of the `use_cwd` tool name** — see
  above.
