## 1. `discoverGitRoot` helper

- [x] 1.1 Write failing tests for `discoverGitRoot($, dir)`: resolves the canonical root for a directory inside a git repository; returns `null` (not throws) for a directory that is not inside a repository, and verify the tests fail
- [x] 1.2 Implement `discoverGitRoot` in `src/index.js` (runs `git rev-parse --show-toplevel`, returns the trimmed path or `null` on any failure) and verify the new tests pass

## 2. `resolveRepoContext` helper (AGENTS.md + .envrc discovery, never throws)

- [x] 2.1 Write failing tests for `resolveRepoContext($, dir, log)` covering: AGENTS.md found at the target directory; found at an ancestor within the git root boundary; nearest-match wins when multiple exist between the directory and the root; not found anywhere within the boundary; directory not inside a git repository (search collapses to the directory itself); `.envrc` found and not found (asserting no `direnv` subprocess is invoked for detection); and verify the tests fail
- [x] 2.2 Implement the single upward walk (realpath-normalized search base, bounded by the discovered git root or the base directory alone) probing each level for `AGENTS.md` and `.envrc` via `stat`, and verify the corresponding tests pass
- [x] 2.3 Write failing tests for the two size gates: a file ≤16 KiB loads in full; a file >16 KiB and ≤1 MiB is read, truncated at a line boundary to ≤16 KiB, with a truncation note; a file >1 MiB is not read, yields an absent result, with a size-limit note; and verify the tests fail
- [x] 2.4 Implement `MAX_AGENTS_MD_BYTES` (16 KiB) and `MAX_AGENTS_MD_READ_BYTES` (1 MiB) as named constants and the truncation/skip logic, and verify the size-gate tests pass
- [x] 2.5 Write a failing test asserting `resolveRepoContext` never throws and resolves to `{ agentsMd: null, notes: [] }` when git-root discovery, the upward walk, or the file read throws internally, and verify it fails
- [x] 2.6 Wrap `resolveRepoContext`'s body so every internal failure is caught, logged via the existing `log` helper, and yields the null/no-notes result, and verify the test from 2.5 passes

## 3. `applyDirectoryChange` choke point and call-site rewiring

- [x] 3.1 Write failing tests for `applyDirectoryChange($, state, resolvedDir, log)`: assigns `state.cwd` unconditionally; runs discovery and overwrites `state.agentsMd` (including to `null`) only when `resolvedDir` differs from the prior `state.cwd`; is a no-op (no discovery, no notes) when `resolvedDir` equals the prior `state.cwd`; and verify the tests fail
- [x] 3.2 Implement `applyDirectoryChange`, and verify the tests from 3.1 pass
- [x] 3.3 Route `use_cwd`'s existing `state.cwd = resolved` assignment through `applyDirectoryChange`, append any returned notes to its return string (newline-separated, after the existing primary message), and verify existing `use_cwd` tests still pass and the discovery notes appear when applicable
- [x] 3.4 Route all three `use_worktree` success paths (idempotent same-path early return, already-exists reuse, newly-created) through `applyDirectoryChange` in place of their direct `state.cwd`/`state.worktree` assignments, append returned notes to each path's return string, and verify a test exists asserting the no-op behavior (per task 3.1) separately for each of the three paths when the resolved path already equals `state.cwd`
- [x] 3.5 Write a failing test asserting that a subsequent `use_worktree` call to an already-active worktree path re-triggers discovery when an intervening `use_cwd` call moved `state.cwd` elsewhere in between, and verify it fails, then confirm it passes once 3.4 is complete

## 4. Advisory system-prompt injection

- [x] 4.1 Write failing tests for the fence-length computation: a fence of at least one character longer than the longest run of backtick-only lines in the content (minimum 3), and verify the tests fail
- [x] 4.2 Implement the fence-length computation and content wrapping, and verify the tests pass
- [x] 4.3 Write failing tests for the `experimental.chat.system.transform` hook: injects a distinct block (separate from "Active Session Context (opencode-use)") stating the repository path, file path, advisory/not-authoritative framing, and provenance caution when `state.agentsMd` is set; injects no such block when it is absent; and verify the tests fail
- [x] 4.4 Implement the second `output.system.push` call carrying the advisory block, and verify the tests from 4.3 pass

## 5. `use_clear` post-condition

- [x] 5.1 Write failing tests: clearing `cwd` when `state.agentsMd` is set clears it and reports the cleared repository; clearing `worktree` when `state.cwd` pointed at the removed worktree also clears `state.agentsMd`; clearing with no `state.agentsMd` set adds no repository-context line; and verify the tests fail
- [x] 5.2 Implement the post-clear enforcement ("if `state.cwd` is falsy, `state.agentsMd` must be `null`") after all existing clear branches, and verify the tests pass

## 6. `use_direnv` `changeCwd` removal

- [x] 6.1 Write a failing test asserting `use_direnv` no longer accepts or acts on a `changeCwd` argument (the session's `state.cwd` is unchanged regardless of any such argument), and verify it fails against the current implementation
- [x] 6.2 Remove `use_direnv`'s `changeCwd` schema entry, its mention in the tool description, its destructured default in `execute()`, its `state.cwd` assignment, and the conditional suffix on its return string, and verify the test from 6.1 passes and existing `use_direnv` tests (env loading, blocked `.envrc`, not-installed) still pass

## 7. Documentation

- [x] 7.1 Update `use_cwd`'s and `use_worktree`'s tool descriptions to document the automatic AGENTS.md load and the `.envrc` detection-only reminder
- [x] 7.2 Update `use_direnv`'s tool description to remove any reference to `changeCwd`
- [x] 7.3 Update `README.md`: document the new automatic behavior for `use_cwd`/`use_worktree` (AGENTS.md auto-load with advisory framing, `.envrc` detection reminder with no automatic execution), remove `changeCwd` from `use_direnv`'s parameter table, and update the session-state shape shown under "How It Works" to include `agentsMd`

## 8. Full verification

- [x] 8.1 Run the full test suite (`npm test`) and confirm all tests pass, including every scenario named in `specs/context-autoload/spec.md`
- [x] 8.2 Confirm no direct `state.cwd = …` assignment remains in `src/index.js` outside `applyDirectoryChange` and `use_clear` (manual grep or, if time permits, the recommended source-text guard test from design.md)
- [x] 8.3 Confirm every scenario in `specs/context-autoload/spec.md` has a corresponding test named after its slugified scenario title
