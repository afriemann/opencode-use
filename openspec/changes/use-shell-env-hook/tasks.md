## 1. Key filtering

- [x] 1.1 Add `ENV_NAME_PATTERN`, `ENV_KEY_DENYLIST`, `ENV_KEY_DENY_PREFIX` constants and the `isInjectableEnvKey(key)` predicate (module scope, `src/index.js`), placed where `buildEnvExports`/`shellQuote` are removed from (design §2, §3)

## 2. `shell.env` hook

- [x] 2.1 Write failing tests for scenarios S1, S3, S4, S7 (active env / undefined sessionID / unknown sessionID / empty env — spec "Shell Environment Injection") in a new `describe('Shell Environment Injection')` block in `test/workdir-injection.test.js`, invoking `plugin['shell.env']({ sessionID, cwd, callID }, output)` directly (design §7)
- [x] 2.2 Register the `'shell.env'` hook per design §1 (guard order, build-then-assign, `Object.assign` in place) to make 2.1's tests pass
- [x] 2.3 Write failing tests for scenarios S5 and S6 (malformed names excluded; `PWD`/`OLDPWD`/`DIRENV_*` excluded, including the exact-case `pwd` passes assertion) and confirm they pass against 2.2's implementation via `isInjectableEnvKey`
- [x] 2.4 Write a failing test for scenario S8 (internal fault never propagates — `Object.freeze({})` as `output.env`, `assert.doesNotReject`, asserts a `shell-env failed`-style log line) and wrap the hook body in try/catch logging via the existing `log()` helper to make it pass

## 3. Remove the old mechanism

- [x] 3.1 Write a failing test for scenario "Command string is never modified" (S2) asserting `output.args.command` is unchanged for a `bash` call in a session with active env
- [x] 3.2 Delete the `bash`-specific env-prefix branch inside `tool.execute.before` to make 3.1 pass, leaving the workdir-injection guards and behavior byte-identical (design §3)
- [x] 3.3 Delete `buildEnvExports` and `shellQuote`; grep `src/`, `test/`, `README.md` to confirm no remaining references to either identifier
- [x] 3.4 Delete the two existing tests in the old `describe('Bash Environment Injection')` block (superseded by 2.1–3.1) and remove the now-empty `describe` block

## 4. Wording updates

- [x] 4.1 Apply the design §6 audit predicate across `src/index.js`: update `experimental.chat.system.transform` env wording and its note line, the `tool.execute.before` JSDoc, the `experimental.chat.system.transform` JSDoc, and the `use_clear` tool description — none may claim a command-prefix/`export` mechanism
- [x] 4.2 Update `README.md` per design §6's table (5 locations: Features bullets ~9-10, `use_direnv` section ~106, How It Works env layer ~184 and invariant ~187) plus add a `### Hook: shell.env` subsection describing the new mechanism and its prompt-path/pty scope note
- [x] 4.3 Confirm `use_cwd`'s tool description needs no change (design §6 open question) — read it and verify it makes no environment-mechanism claim; leave unchanged if confirmed

## 5. Verification

- [x] 5.1 Run the full test suite (`npm test` or project equivalent) and confirm all tests pass, including every new scenario S1–S8 and the command-untouched regression guard
- [x] 5.2 Run project linters/diagnostics on `src/index.js` and `test/workdir-injection.test.js` and fix any reported issue
- [x] 5.3 Grep the whole repo for `export.*&&` / `buildEnvExports` / `shellQuote` to confirm zero remaining references outside git history
