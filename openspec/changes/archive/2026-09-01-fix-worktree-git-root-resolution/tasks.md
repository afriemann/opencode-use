## 1. Failing tests (red step)

- [x] 1.1 Write `test/resolve-git-root.test.js` with a minimal Node-based shim for the Bun `$` shell interface (`.cwd().quiet().text()`, direct `await`-ability without `.text()`, throwing an `Error` with `.stderr` on non-zero exit) backed by real `child_process` calls against real temporary git repositories. Verify: file exists, `node --test test/resolve-git-root.test.js` runs and fails (functions not yet exported/implemented).
- [x] 1.2 Encode all three OpenSpec scenarios as tests named after their scenario titles: `session has an explicit working directory`, `session was opened outside a git repository with no explicit working directory`, `neither the session context nor the target path resolves to a git repository`. Verify: all three tests exist and fail for the expected reason (missing exports).
- [x] 1.3 (added during review) Add an integration-level test calling `use_worktree`'s actual `execute()` end-to-end (not just `resolveGitRoot` in isolation), to guard against the fix landing in the wrong call site. Verify: confirmed this test genuinely fails when `resolveGitRoot` is reverted out of `useWorktree.execute` (manually toggled and re-run) before trusting it as a regression guard.

## 2. Implementation (green step)

- [x] 2.1 Add `dirname` to the existing `node:path` import in `src/index.js`. Verify: `node --check src/index.js` passes.
- [x] 2.2 Add exported `nearestExistingDir(path)` helper that walks up to the nearest existing ancestor directory. Verify: covered by the scenario tests in step 3.
- [x] 2.3 Add exported `resolveGitRoot($, candidateRoot, resolvedWorktreePath)` helper implementing the validate-then-discover-then-error logic from the spec. Verify: covered by the scenario tests in step 3.
- [x] 2.4 Wire `resolveGitRoot` into `useWorktree.execute`, replacing `const root = gitRoot(state, ctx)` with `const root = await resolveGitRoot($, gitRoot(state, ctx), resolved)`. Verify: `node --check src/index.js` passes.

## 3. Verification

- [x] 3.1 Run `node --test test/` and confirm all scenario tests pass. Verify: test runner reports 0 failures (4/4 passing, including the integration test).
- [x] 3.2 Update `package.json` `"test"` script to `node --check src/index.js && node --test test/ && echo 'Syntax OK'`. Verify: `npm test` passes locally.
- [x] 3.3 Attempted to re-run the original live reproduction in the same opencode session; confirmed this is not possible mid-session because the plugin module was already loaded into memory before the fix was written to disk (no hot-reload). Instead verified the fix via: (a) the automated integration test in 1.3, confirmed to genuinely fail without the fix and pass with it; (b) a standalone debug script (`/tmp/debug-integration.mjs`, not committed) exercising the same real `OpenCodeUse` plugin factory directly.

## 4. Review and ship

- [x] 4.1 Get the diff reviewed by `code-reviewer` against `proposal.md` → delta `specs/` → diff. Verify: every `[BLOCKER]` resolved, every `[WARNING]` explicitly accepted or rejected with a reason. First review round found 3 blockers (fix wired into wrong function `useClear` instead of `useWorktree`, causing both an unfixed bug and a new crash) and 2 warnings (no temp-dir cleanup in tests, unchecked tasks.md); all corrected.
- [x] 4.2 Commit directly to `main` (per user instruction — direct-to-main for this repo) and run `openspec archive fix-worktree-git-root-resolution --yes`, then commit the archival. Verify: `git show --stat HEAD` lists only the intended files; `git status --porcelain` is clean.
