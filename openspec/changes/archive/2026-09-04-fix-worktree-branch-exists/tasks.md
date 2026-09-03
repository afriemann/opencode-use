## 1. Reproduce and encode failing tests

- [x] 1.1 Add a red-step test reproducing "branch exists but not checked out anywhere" and verify it fails against current code
- [x] 1.2 Add a red-step test reproducing "branch already checked out at a different worktree path" and verify it fails against current code

## 2. Implement recovery

- [x] 2.1 In the `use_worktree` catch block, distinguish the "branch already exists" git error from the "path already exists" error
- [x] 2.2 On branch-exists: check `git worktree list --porcelain` for a registration of `<branch>` at a path other than the target
- [x] 2.3 If not registered elsewhere, retry with `git worktree add <path> <branch>` (no `-b`) and return the success response; verify test 1.1 now passes
- [x] 2.4 If registered at a different path, raise a clear error naming that path and instructing `create: false` reuse there; verify test 1.2 now passes

## 3. Verify no regressions

- [x] 3.1 Run the full existing test suite and confirm all prior tests (including path-already-exists idempotency and cross-repo contamination) still pass
- [x] 3.2 Update README.md's `use_worktree` description to mention the branch-exists recovery behavior
