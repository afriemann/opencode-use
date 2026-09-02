## 1. Regression tests (red step)

- [x] 1.1 Write a failing test asserting `src/index.js`'s module namespace exports nothing but `default` (e.g. `Object.keys(await import('../src/index.js'))` equals `['default']`), and verify it fails against the current file (5 extra named exports)
- [x] 1.2 Write a failing test that reproduces opencode's actual `getLegacyPlugins` invocation pattern: import every exported value from `src/index.js`, call every function-typed one as `fn(fakeInput, undefined)` (mirroring `server(input, load.options)`), and assert none of them throw — verify it fails against the current file

## 2. Fix

- [x] 2.1 Create `src/lib.js` containing `nearestExistingDir`, `resolveGitRoot`, `discoverGitRoot`, `resolveRepoContext`, `applyDirectoryChange` as named exports, moved verbatim (no logic changes) from `src/index.js`
- [x] 2.2 Update `src/index.js` to import these five functions from `./lib.js` and remove their `export` keyword duplicates — `src/index.js` exports only `export default async function OpenCodeUse(...)` afterward
- [x] 2.3 Update `test/resolve-git-root.test.js` to import `resolveGitRoot` from `../src/lib.js` instead of `../src/index.js` (keep the `OpenCodeUse` default import from `../src/index.js`)
- [x] 2.4 Update `test/context-autoload.test.js` to import `discoverGitRoot`, `resolveRepoContext`, `applyDirectoryChange` from `../src/lib.js` instead of `../src/index.js`
- [x] 2.5 Run the full test suite (`npm test`) and verify all tests pass, including the two new regression tests from section 1

## 3. Real-runtime verification

- [x] 3.1 Using a real `bun` process and the real `@opencode-ai/plugin` peer dependency, reproduce opencode's `getLegacyPlugins` scan against the fixed `src/index.js` and confirm exactly one legacy plugin candidate (the `default` export) is found, and that calling it with `(input, options)` succeeds and returns the expected `{ tool, ... }` hooks object
- [ ] 3.2 After this change is pushed to `main`: update the pinned commit SHA in `~/git/ai-dotfiles/.chezmoiexternal.yaml`'s `opencode-use` archive external, run `chezmoi apply` to sync `~/.config/opencode/vendor/opencode-use/`, confirm the deployed `src/index.js`/`src/lib.js` match this fix, and note that a live restart of opencode is required to actually reload the plugin process

## 4. Documentation

- [x] 4.1 Update `README.md`'s "Extending the plugin" section documenting that `src/index.js` must export only `default` — any other top-level named export is misinterpreted by opencode's legacy-plugin loader as an independent plugin factory and invoked with the wrong arguments, and that testable helpers belong in `src/lib.js` instead
