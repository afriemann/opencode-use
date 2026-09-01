## Why

`use_worktree` fails with a misleading git error — `fatal: 'origin' does not
appear to be a git repository` — whenever a session has no prior `use_cwd` call
and was started outside a git repository (e.g. opencode opened from `$HOME`).
The tool's git root selection (`gitRoot()`) falls back to `ctx.directory`
without ever validating that it's actually a git repository, and never
considers the target `path` argument — even though that path routinely points
directly into a real, working repository (the documented
`<repo-root>/.worktrees/<branch>` convention). Confirmed by live reproduction
in a real session on 2026-09-01 (see memory atom
`reality/opencode-use-worktree-wrong-git-root`).

## What Changes

- `use_worktree` validates its candidate git root (`state.cwd` / `ctx.worktree`
  / `ctx.directory`) via `git rev-parse --show-toplevel` before running any
  other git subprocess command.
- If the candidate root isn't a git repository, the tool discovers one by
  walking up from the nearest existing ancestor of the target worktree `path`.
- If neither resolves to a repository, the tool raises one clear, actionable
  error naming both failed candidates and instructing the caller to call
  `use_cwd` first — instead of letting a raw git subprocess error leak through.
- Side effect (beneficial, not additional scope): the resolved root is now
  always the canonical repository top-level, which also fixes a latent
  correctness gap in the existing "branch already checked out at repository
  root" and cross-repo-contamination guards — both compare against `root`
  assuming it is already the toplevel, which wasn't previously guaranteed.

## Capabilities

### Modified Capabilities
- `worktree-git-root`: the git root selection requirement gains a validation +
  discovery fallback step and a clear failure mode, replacing the current
  unvalidated fallback to `ctx.directory`.

## Impact

- Affected code: `src/index.js` only (`gitRoot`/`useWorktree.execute`), plus a
  new `test/` suite and an updated `package.json` `test` script.
- No API surface change — same tool name, args, and return-value shape.
- No new dependency.
- No breaking change for callers that already call `use_cwd` before
  `use_worktree` (the common case) — behavior there is unchanged except the
  resolved root is now canonicalized to the repo toplevel.
