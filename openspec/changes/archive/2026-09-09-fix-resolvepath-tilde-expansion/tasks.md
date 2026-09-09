## 1. Failing tests (red)

- [x] 1.1 Add a failing test for "Input path is a bare tilde" (use_cwd with `path: '~'`) and verify it fails against the current (unfixed) code
- [x] 1.2 Add a failing test for "Input path starts with tilde-slash" (use_cwd with a `~/subdir` path pointing at a real temp dir) and verify it fails against the current (unfixed) code
- [x] 1.3 Add a failing test for "Input path references another user's home directory" (`~otheruser/subpath` resolves as a literal relative path, unexpanded) and verify it passes trivially against the current code (documents existing pass-through behavior as a regression guard)

## 2. Implementation (green)

- [x] 2.1 Implement `expandHome()` in `src/index.js` using `node:os.homedir()`, expanding bare `~` and `~/...` only
- [x] 2.2 Wire `expandHome()` into `resolvePath()` ahead of the existing `isAbsolute` check
- [x] 2.3 Run the new tests (1.1, 1.2) and verify they now pass; verify 1.3 still passes

## 3. Full verification

- [x] 3.1 Run the full test suite (`npm test`) and verify all tests pass, including the pre-existing suite
- [x] 3.2 Manually confirm `node --check src/index.js` reports no syntax errors (covered by `npm test`)
