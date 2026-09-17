## Why

`use_clear`'s owned-worktree removal selects the working directory for its `git worktree
remove` subprocess call using raw session context (`gitRoot(state, ctx)`), while
`use_worktree` already uses the more robust `resolveGitRoot` helper (which discovers the
repo that actually contains the target path, instead of trusting session context verbatim)
for the equivalent decision at creation time. When session context has drifted to an
unrelated repository since the worktree was created — reproduced directly in a live session
(worktree owned in repo A, session context pointing at repo B after other work) — every
`git worktree remove` call, forced or not, fails with `fatal: '<path>' is not a working
tree`, because git correctly reports that repo B has no such worktree registered. The user
then had to fall back to manually running `rm -rf` plus `git worktree prune` from the
correct repo to actually clean up. Confirmed empirically against real git repositories
(git 2.43.0): a plain `git worktree remove` from the *correct* repo root succeeds even when
the worktree's own directory was already deleted outside of git (git resolves the
now-"prunable" registration on its own, no `--force` or `git worktree prune` required) — so
the only defect is the git-root selection itself, not the removal/force/prune logic
downstream of it.

**Refinement note:** the original scoping of this change also proposed adding a
`git worktree prune` fallback for `force`-cleared "is not a working tree" failures.
Empirical testing during implementation showed this is unnecessary: once the correct root
is resolved, a legitimately orphaned entry is removed without needing `force` at all, and
the only remaining case that still says "is not a working tree" from the *correct* root is
a worktree that is already fully deregistered — for which `git worktree prune` is a no-op,
and clearing the plugin's own reference (the existing behavior) is already correct. That
part of the original proposal has been dropped; see `specs/worktree-cleanup/spec.md` for
the resulting, narrower delta.

## What Changes

- `use_clear`'s owned-worktree removal now resolves the git root via `resolveGitRoot`,
  matching `use_worktree`'s existing, already-hardened approach — instead of trusting raw
  session context directly. If `resolveGitRoot` itself cannot determine a containing
  repository, its own clear error propagates instead of attempting a removal against a
  guessed, likely-wrong directory.

## Capabilities

### Modified Capabilities

- `worktree-cleanup`: `use_clear`'s owned-worktree removal resolves its git root the same
  way `use_worktree` does, instead of trusting raw session context.

## Impact

- `src/index.js` — `use_clear` tool's owned-worktree removal branch only; no new parameters,
  no API surface change, no new dependencies.
- `test/` — new test file covering the fixed behavior.
- `README.md` — `use_clear` documentation updated to match.
