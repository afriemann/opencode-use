## 1. Core rename (src/core.js)

- [x] 1.1 Rename the `use_cwd` tool descriptor key/name, `TOOL_TEXT.use_cwd` (description/parameter text), `SELF_TOOL_NAMES` entry, and `V2_TOOL_OPTIONS.use_cwd` entry to `use_workdir` in `src/core.js`; verify `V2_CUSTOM_TOOL_NAMES` (derived from `V2_TOOL_OPTIONS`'s keys) picks up `use_workdir` automatically with no separate edit
- [x] 1.2 Rename the `executeUseCwd` function to `executeUseWorkdir` in `src/core.js` and update its export
- [x] 1.3 Update all in-code cross-reference strings in `src/core.js` that name `use_cwd`: `use_direnv`'s description (~line 407), `use_worktree`'s description (~lines 425, 427), and the `log('use_cwd failed', err)` message (~line 494)
- [x] 1.4 Update `src/lib.js`'s error-guidance text (~line 129) referencing `use_cwd`
- [x] 1.5 Verify: `grep -rn "use_cwd" src/` returns no matches (excluding intentional historical references, if any remain by design)

## 2. Plugin adapters

- [x] 2.1 Update `src/plugin.v1.js` to import/use `executeUseWorkdir`, register the tool as `use_workdir`, and reference `TOOL_TEXT.use_workdir`
- [x] 2.2 Update `src/plugin.v2.js` to import/use `executeUseWorkdir`, register the tool descriptor as `name: 'use_workdir'`, reference `TOOL_TEXT.use_workdir` and `V2_TOOL_OPTIONS.use_workdir`
- [x] 2.3 Verify: `npm test` passes (syntax check + full test suite) after 1.x/2.x edits — verified via direct `node --test test/*.test.js` invocation (103/103 pass) after discovering `npm test`'s own `--test=test/` glob syntax silently no-ops instead of running tests (pre-existing environment issue, see report)

## 3. Tests

- [x] 3.1 Update `test/context-autoload.test.js`: rename every `use_cwd` call/reference and any test name that names the tool directly to `use_workdir`
- [x] 3.2 Update `test/path-resolution.test.js` likewise
- [x] 3.3 Update `test/plugin-v2-conformance.test.js` likewise
- [x] 3.4 Update `test/resolve-git-root.test.js` likewise
- [x] 3.5 Update `test/use-clear-worktree-cleanup.test.js` likewise
- [x] 3.6 Update `test/workdir-injection.test.js` likewise
- [x] 3.7 Update `test/e2e/run.mjs`: reword the live prompt (~line 73) and the "no tool named use_cwd" assertion string (~line 91) to `use_workdir`; leave `test:e2e`'s exclusion from CI/default `npm test` unchanged
- [x] 3.8 Verify: `npm test` (all 11+ suites) passes with zero failures — 103/103 subtests across 9 suites pass via direct `node --test test/*.test.js`
- [ ] 3.9 Manually run `npm run test:e2e` once locally (requires a live model credential) to confirm the edited live-prompt and assertion strings pass end-to-end — attempted; blocked in this environment by disabled npm install-scripts (the `@opencode/cli` postinstall did not run) and no live model credential available; left unchecked, see report

## 4. Documentation

- [x] 4.1 Update `README.md`: every prose, heading (`### \`use_cwd\`` → `### \`use_workdir\``), and code-sample reference to `use_cwd` becomes `use_workdir` (lines 5, 9, 54, 58, 63, 67-72, 107, 117/134/135/167/177 area, and any others found by grep)
- [x] 4.2 Update `docs/v2-compat-audit.md`'s embedded tool-name references (the empirical CLI transcript quoting `use_cwd`, and the `executeUseCwd` function-name reference at ~line 112) to `use_workdir`/`executeUseWorkdir`
- [x] 4.3 Verify: `grep -rn "use_cwd" README.md docs/` returns no matches

## 5. Delta specs (already authored; verify only)

- [x] 5.1 Run `openspec validate rename-use-cwd-to-use-workdir` and confirm it passes structurally

## 6. Review, commit, and archive

- [ ] 6.1 Run `npm test` one final time and confirm all suites pass
- [ ] 6.2 Get the diff reviewed by `code-reviewer` against proposal.md → delta specs → diff; resolve every `[BLOCKER]` and disposition every `[WARNING]`
- [ ] 6.3 Commit the rename (source, tests, docs, delta specs)
- [ ] 6.4 Run `openspec archive rename-use-cwd-to-use-workdir --yes` and confirm the 4 main specs merge cleanly; commit the archival separately

## 7. Post-archive follow-up (mandatory, own commit — do not skip)

- [ ] 7.1 In the merged `openspec/specs/context-autoload/spec.md`: rename the 2 scenario titles that still literally read `use_cwd` (`"use_cwd moves to a genuinely new directory"` and `"use_cwd is called again with the same resolved directory"`) to their `use_workdir` equivalents, and update the corresponding test names in `test/context-autoload.test.js` if they mirror the old titles
- [ ] 7.2 In the merged main specs, update the `## Purpose` preambles of `context-autoload/spec.md` (line 5), `path-resolution/spec.md` (line 5), and `workdir-injection/spec.md` (line 6) to say `use_workdir` instead of `use_cwd`
- [ ] 7.3 Delete the stray pre-existing `</content>` artifact line at `context-autoload/spec.md:196` (unrelated leftover tooling output, safe to remove once archive has completed)
- [ ] 7.4 Commit this follow-up separately, e.g. `docs: rename use_cwd scenario titles and purpose text in merged specs`
- [ ] 7.5 Verify: `grep -rn "use_cwd" openspec/specs/` returns no matches (excluding `openspec/changes/archive/**`, which is intentionally left untouched as a frozen historical record)
