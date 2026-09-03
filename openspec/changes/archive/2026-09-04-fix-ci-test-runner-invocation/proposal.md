## Why

CI (`npm test` in `.github/workflows/ci.yml`, Node 22 and 24) has been failing on every run since at least commit `714b64f` (confirmed via `gh run list`) with:

```
Error: Cannot find module '/home/runner/work/opencode-use/opencode-use/test'
```

Reproduced locally via Docker (`node:22`, exact patch `22.23.2` matching the CI log) with `npm ci && npm test`. Root cause: `package.json`'s test script invokes `node --test test/` — a bare directory path argument. Node's own CLI docs (verified via context7 against `nodejs.org/docs/latest-v22.x/api/cli.json` and `test.json`) document only two supported invocations: `node --test` (no path — auto-discovers files matching test naming conventions) or `node --test "<glob>"` (explicit glob pattern). A bare directory path is not a documented invocation; on Node 22.23.2 and 24.19.0 it silently falls through to Node's CJS entry-point resolution, which tries to `require('test')` and fails with `MODULE_NOT_FOUND`. This did not surface locally because the developer's Node (v26.8.1) apparently tolerates the bare directory argument — an unverified, version-dependent behavior that should not be relied on.

Separately, while reproducing in Docker (which bundles an older git, 2.39.5, than the real CI runner's 2.55.0), a second, independent test fixture bug surfaced: `test/resolve-git-root.test.js`'s `makeTempRepo` helper calls `git init -q` but never creates an initial commit. `git worktree add -b <branch> <path>` on an empty repository (no commits, unborn HEAD) only succeeds on git versions new enough to auto-infer `--orphan` (confirmed: git 2.43.0 does this with the message "No possible source branch, inferring '--orphan'"; git 2.39.5 fails with `fatal: not a valid object name: 'HEAD'`). This test currently likely passes on GitHub's `ubuntu-latest` runner (which has git 2.55.0), but is not portable across environments with an older git and should not depend on this undocumented, version-gated fallback.

## What Changes

- `package.json`: change the `test` script from `node --test test/` to `node --test` (Node's documented no-argument default auto-discovery of test files).
- `test/resolve-git-root.test.js`: `makeTempRepo` creates an initial empty commit after `git init`, matching the pattern already used by `test/context-autoload.test.js`'s `commitAll` helper, so the `use_worktree integration` test's `git worktree add -b` call does not depend on git's auto-orphan-inference for empty repos.

## Capabilities

Pure tooling/test-infrastructure fix — no application behavior changes, so no capability specs are added or modified. `skip_specs: true` is set in `.openspec.yaml`.

## Impact

- `package.json` — one line (`scripts.test`).
- `test/resolve-git-root.test.js` — `makeTempRepo` helper only; no test assertions change.
- No production code (`src/`) changes; no dependency changes; no public tool behavior changes.
