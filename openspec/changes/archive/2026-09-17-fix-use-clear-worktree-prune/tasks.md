## 1. Tests (red step)

- [x] 1.1 Write a failing test: `use_clear` resolves the correct repository root via `resolveGitRoot` even when session context (`state.cwd`/`ctx.directory`) points at a different, unrelated repository, and removal succeeds against the correct repo instead of failing with `"is not a working tree"` — verify via `git worktree list` in each repo
- [x] 1.2 Write a failing test: when the worktree's containing repository can no longer be found by `resolveGitRoot` (repo directory deleted, session context also invalid), `use_clear` propagates `resolveGitRoot`'s own clear error instead of attempting a guessed `git worktree remove`
- [x] 1.3 Write a regression test: normal owned-worktree removal (correct context, no drift) still succeeds and clears state as before

## 2. Implementation (green step)

- [x] 2.1 In `use_clear`'s owned-worktree removal branch, resolve the root via `resolveGitRoot($, gitRoot(state, ctx), worktreePath)` (letting a resolution failure propagate); verify tests 1.1, 1.2, and 1.3 pass

## 3. Docs and verification

- [x] 3.1 Update `README.md`'s `use_clear` section if its wording implies the previous (buggy) root-selection behavior
- [x] 3.2 Run the full test suite and linter; confirm no regressions
- [x] 3.3 Confirm the delta spec in `openspec/changes/fix-use-clear-worktree-prune/specs/worktree-cleanup/spec.md` matches what was built before archiving

## 4. Code review follow-ups

- [x] 4.1 Add a test covering the pre-existing "Removal fails due to uncommitted or untracked content" scenario, which had no test before this change
- [x] 4.2 Parameterize `resolveGitRoot`'s failure-message retry hint (`retryTool`) so `use_clear` reports "call use_clear again" instead of the misleading "call use_worktree again"
