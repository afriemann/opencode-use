## 1. Reproduce and encode a failing test

- [x] 1.1 Add a red-step test: session's cached candidate resolves to a valid but unrelated repo; target path is under a different real repo. Verify it fails against current code (worktree created against the wrong repo).

## 2. Implement the containment check

- [x] 2.1 In `resolveGitRoot`, after resolving a candidate's git toplevel, verify the target worktree path is inside it (or equal to it)
- [x] 2.2 If containment fails, reject the candidate and continue to the next one in the fallback chain
- [x] 2.3 Verify test 1.1 now passes

## 3. Report the resolved git root in the tool's response

- [x] 3.1 Update `use_worktree`'s success response messages (creation, reuse, and already-active paths) to name the resolved repository root
- [x] 3.2 Add/update a test asserting the success message names the repository root

## 4. Verify no regressions

- [x] 4.1 Run the full existing test suite and confirm all prior `resolveGitRoot`/`use_worktree` scenarios still pass
- [x] 4.2 Confirm `openspec/specs/worktree-git-root/spec.md` was not manually edited during implementation (archive applies the delta)
