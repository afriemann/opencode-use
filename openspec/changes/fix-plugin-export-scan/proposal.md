## Why

opencode's own legacy-plugin loader (`getLegacyPlugins` in
`packages/opencode/src/plugin/index.ts`) invokes **every top-level named
export that is a function** as an independent plugin factory, called as
`server(input, load.options)` — not just the `default` export. `src/index.js`
currently has five other named exports (`nearestExistingDir`,
`resolveGitRoot`, `discoverGitRoot`, `resolveRepoContext`,
`applyDirectoryChange`) that exist purely so tests can import and unit-test
them directly. Each of these gets misinterpreted as its own "plugin" and
invoked with the wrong argument shape, throwing at plugin-registration time.

Because a module namespace object enumerates its exports alphabetically,
whether this was previously tolerated depended entirely on `default`
sorting before the other named exports. It did — until this session added
`applyDirectoryChange` and `discoverGitRoot`, both of which sort **before**
`default` alphabetically. That moved a throwing phantom-plugin invocation
ahead of the real plugin factory in the iteration order, so the loader now
aborts before ever calling `default` — **the entire plugin fails to load,
and all four tools (`use_cwd`, `use_worktree`, `use_direnv`, `use_clear`)
disappear.** This was caught live: the previous change's `applyDirectoryChange`
export threw `"undefined is not an object (evaluating 'state.cwd')"` (its
`state` parameter actually received `load.options`) immediately after an
opencode restart, confirmed via the opencode app log and by reading
opencode's own plugin-loader source. A related, less severe instance of the
same defect (`resolveGitRoot`/`nearestExistingDir` throwing when invoked the
same wrong way) has been silently present and tolerated in every restart
today, based on log evidence of a stable, pre-existing `"path" property must
be of type string, got object` error.

## What Changes

- `src/index.js` (the file symlinked into `~/.config/opencode/plugins/`, and
  therefore the only file opencode's loader scans) will export **only**
  `export default async function OpenCodeUse(...)` — no other top-level named
  exports.
- The five helper functions currently exported from `src/index.js`
  (`nearestExistingDir`, `resolveGitRoot`, `discoverGitRoot`,
  `resolveRepoContext`, `applyDirectoryChange`) move to a new file,
  `src/lib.js`, which is never symlinked into opencode's plugins directory
  and therefore never scanned by its loader. `src/index.js` imports them from
  `./lib.js` for its own internal use.
- Test files import these helpers from `../src/lib.js` instead of
  `../src/index.js` (the `default` export, `OpenCodeUse`, is still imported
  from `../src/index.js` as before).
- A new regression-guard test asserts `src/index.js`'s module namespace has
  no exported keys other than `default`, so this defect class cannot silently
  recur.
- No behavioral change to any tool: this is a pure internal reorganization
  fixing a load-time defect, not a change to `use_cwd`/`use_worktree`/
  `use_direnv`/`use_clear`'s specified behavior.

## Capabilities

No new or modified capability: the tools' specified behavior (per
`workdir-injection`, `worktree-git-root`, and `context-autoload`) is
unchanged — this fixes a defect that was preventing that already-specified
behavior from running in production at all. `skip_specs: true` is set in
this change's `.openspec.yaml`.

## Impact

- **Code**: `src/lib.js` (new), `src/index.js` (imports only, no
  behavior change), `test/resolve-git-root.test.js`,
  `test/context-autoload.test.js` (import paths only).
- **Severity**: this is a production-breaking regression fix — the plugin
  currently fails to load entirely following the previous change's deploy.
- **Docs**: `README.md`, "Extending the plugin" section, documents the
  constraint (no top-level named exports besides `default` in `src/index.js`)
  so it is not reintroduced.
- **Dependencies**: none added.
