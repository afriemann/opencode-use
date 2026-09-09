## Why

`resolvePath()` — the single path-resolution helper shared by `use_cwd`,
`use_direnv`, and `use_worktree` — never expands a leading `~`. A caller (or
the model, mirroring what a user would type in a shell) passing a
shell-conventional path like `~/git/middle-earth` gets it treated as a plain
relative path segment, which is then joined onto `ctx.directory` or
`state.cwd`. The result is a broken path such as
`/home/aljoshafriemann/~/git/middle-earth`, and the tool fails with `ENOENT`
instead of resolving to the user's actual home directory.

## What Changes

- `resolvePath()` expands a leading `~` (bare) or `~/...` to the current
  user's home directory (via `node:os.homedir()`) before its existing
  absolute/relative resolution logic runs. All three tools that funnel their
  `path` argument through `resolvePath()` (`use_cwd`, `use_direnv`,
  `use_worktree`) inherit the fix automatically, with no per-tool change.
- Out of scope: `~otheruser/...` (tilde for a user other than the current
  one) is not supported — it requires an OS user-directory lookup with no
  portable Node API, and was not part of the reported bug.

## Capabilities

### New Capabilities

(none — `path-resolution` main spec was authored separately, ahead of this
change, to capture pre-existing behavior before this delta is applied)

### Modified Capabilities

- `path-resolution`: the path-resolution helper now expands a leading `~` or
  `~/...` to the current user's home directory before applying its existing
  absolute/relative resolution rules.

## Impact

- Affected code: `src/index.js` — `resolvePath()` and its three call sites
  (`use_cwd`, `use_direnv`, `use_worktree`) all pick up the fix without
  individual changes, since they all funnel through the shared helper.
- No new dependencies (`node:os.homedir()` is part of the Node standard
  library already implicitly available in this Node ≥22.5 project).
- No API, schema, or infrastructure changes.
