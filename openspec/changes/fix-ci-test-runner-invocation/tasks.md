## 1. Fix CI test-runner invocation

- [x] 1.1 Change `package.json`'s `test` script from `node --test test/` to `node --test`
- [x] 1.2 Verify locally with `npm test` (all existing tests still discovered and passing)
- [x] 1.3 Verify in Docker against `node:22` and `node:24` images (matching CI's exact Node versions) that `npm ci && npm test` no longer produces `MODULE_NOT_FOUND`

## 2. Fix git-version-dependent test fixture

- [x] 2.1 Update `test/resolve-git-root.test.js`'s `makeTempRepo` to create an initial empty commit after `git init`
- [x] 2.2 Verify the `use_worktree integration` test still passes locally
- [x] 2.3 Verify in the `node:22` Docker container (older git, 2.39.5) that the test now passes without relying on auto-orphan-inference

## 3. Ship

- [x] 3.1 Run the full test suite locally and confirm no regressions
- [ ] 3.2 Push and open a PR; confirm the GitHub Actions CI run passes on both Node 22 and Node 24
