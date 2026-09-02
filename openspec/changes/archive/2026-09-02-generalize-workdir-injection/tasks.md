## 1. Capability registry and eligibility predicate

- [x] 1.1 Add a module-level `workdirCapable` Map and a `SELF_TOOLS` Set (`use_cwd`, `use_direnv`, `use_worktree`, `use_clear`) in `src/index.js`, and verify `node --check src/index.js` passes
- [x] 1.2 Implement the eligibility predicate (string type, no `enum`, not in `required`) as a small helper, and verify unit tests `it('Tool's workdir parameter is enum-constrained, non-string, or required')` and `it('Tool has no workdir parameter, or was never observed by tool.definition')` pass

## 2. `tool.definition` generalization

- [x] 2.1 Remove the `if (toolID !== 'bash') return` restriction; run the self-tool guard, then the eligibility predicate, then the idempotency sentinel (check the live description string), then append a tool-agnostic annotation constant; verify `it('An eligible tool's schema is requested')` and `it('The same definition object is annotated twice')` pass
- [x] 2.2 Verify `it('A tool's workdir parameter is not eligible')` passes (no description mutation for non-eligible schemas)

## 3. `tool.execute.before` generalization

- [x] 3.1 Hoist a shared `if (!output.args) return` guard before the env and workdir branches; verify `it('A call's arguments object is missing')` passes
- [x] 3.2 Keep the env-export branch scoped to `input.tool === 'bash'`; verify `it('Session has active environment variables')` and `it('A non-bash tool call is made')` (env branch) pass
- [x] 3.3 Generalize the workdir branch to `workdirCapable.get(input.tool) === true`; verify `it('Session has an active working directory, an eligible tool, call omits workdir')`, `it('Call explicitly specifies its own workdir')`, and `it('Bash tool call, session has an active working directory')` pass

## 4. System-prompt and description text

- [x] 4.1 Update the `experimental.chat.system.transform` wording from "every bash call" to "every tool call that accepts a `workdir` parameter", keeping the env sentence bash-scoped and the read/write/edit/glob/grep guidance qualified as "tools with no `workdir` parameter"; add a regression test confirming the injected text no longer says "bash call" and still emits nothing when there is no active context
- [x] 4.2 Update the `use_cwd`, `use_direnv`, `use_worktree` tool description strings from "every bash call" to "every tool call that accepts a workdir parameter (including bash)"

## 5. Documentation

- [x] 5.1 Update `README.md`'s Features section to describe generic workdir-parameter injection instead of bash-only injection

## 6. Full verification

- [x] 6.1 Run `npm test` (full suite: `node --check src/index.js && node --test test/`) and confirm all tests pass with no regressions
- [x] 6.2 Run `openspec validate generalize-workdir-injection --strict` and confirm it passes
