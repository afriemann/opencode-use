## 1. Dependency and packaging setup

- [ ] 1.1 Add `@opencode/plugin` and `@opencode/cli` as devDependencies; mark both `@opencode-ai/plugin` and `@opencode/plugin` optional peerDependencies; verify `npm install` resolves cleanly from a clean `node_modules`
- [ ] 1.2 Add `"./v1"` export alongside the existing `"./v2"` export; keep `"."`/`main` pointed at `plugin.v1.js`; verify `node -e "require.resolve('opencode-use/v1')"`-equivalent (ESM: dynamic import) resolves both subpaths

## 2. Extract the runtime-agnostic core (D1)

- [ ] 2.1 Create `src/core.js`: move session-state map, the four tool descriptors (`{name, description, schema, execute(input, deps)}`, each carrying `options: { codemode: false }` in the descriptor), the workdir-eligibility predicate, the env-key filter, and the system-prompt block builders out of `src/index.js`; `core.js` takes `$`, a log sink, and a base directory as injected dependencies (D2) — no `Bun.$` or ad hoc shell access inside; verify `node --check src/core.js` passes and the file exports a named surface only (no default export, matching `lib.js`'s existing convention)
- [ ] 2.2 Rewrite `src/plugin.v1.js` (`git mv src/index.js src/plugin.v1.js` first, preserving history) as a thin V1 adapter over `core.js`: wires V1 hook registration to core functions, injects V1's `$` from plugin input; verify `npm test`'s existing assertions pass unchanged in content (no test file's expected values change, only what module they import from)

## 3. V2 adapter (`src/plugin.v2.js`)

- [ ] 3.1 Implement `Plugin.define({ id, setup(ctx) })` wiring: tool registration via `ctx.tool.transform((editor) => editor.add(...))` using core's tool descriptors verbatim (including `options: { codemode: false }`); schema annotation via `editor.update`; verify a real end-to-end run (see task 7) shows `use_cwd` etc. registered
- [ ] 3.2 Wire `tool.execute.before` → `ctx.tool.hook("execute.before", ...)`, mutating `event.input` in place; use the built-in tool name `shell` (not `bash`) as the always-eligible constant; verify an adapter-conformance test asserts in-place mutation and the `shell` constant
- [ ] 3.3 Wire `shell.env` → `ctx.shell.hook("create.before", ...)`, mutating `event.env`; implement the D6 fail-closed env-resolution ladder (single env-bearing session → cwd-match → no injection + log) per the `workdir-injection` spec delta's V2 Shell Environment Injection scenarios; verify unit tests cover the single-session, cwd-match, and ambiguous-no-injection cases exactly as specified
- [ ] 3.4 Wire `experimental.chat.system.transform` → `ctx.session.hook("context", ...)`, pushing `{type:'text', text}` onto `event.system`; include the AGENTS.md advisory block (per `context-autoload`'s unchanged Advisory System-Prompt Injection requirement) and the V2-only env-injection caveat line (per the D6 spec delta) built from the shared core template; verify a test asserts both blocks appear when applicable
- [ ] 3.5 Resolve `$` once at `setup()` from `globalThis.Bun?.$`; fail loudly (thrown error with an actionable message) at load time if absent, not at first tool call; verify a test simulates a missing `Bun` global and asserts the loud failure
- [ ] 3.6 Register a `catalog.updated` event subscription (`ctx.event.subscribe`) that re-runs the schema-annotation pass via `ctx.tool.reload()`, guarded against re-entrancy (a reload already in flight must not trigger a nested reload); dispose the subscription and the transform `Registration` from `setup()`'s cleanup return; verify a test asserts idempotent re-annotation across two reloads and that a reload triggered from inside the handler does not recurse
- [ ] 3.7 Verify tool-id/namespace behavior against a real catalog (D8): confirm whether `editor.list()` returns ids equal to the registered `name`, or a namespaced variant; key the self-tool exclusion set (`use_cwd`/`use_direnv`/`use_worktree`/`use_clear`) on whatever `list()` actually reports; verify via a real end-to-end run that the plugin does not annotate or inject into its own tools

## 4. Spec compliance and delta specs (R1–R3, D10)

- [ ] 4.1 Update `openspec/specs/workdir-injection/spec.md` and `openspec/specs/context-autoload/spec.md` with the delta content already drafted in this change's `specs/` directory (mechanism-neutral requirement text, V2 shell-env resolution ladder) — this task is the archive-time merge; verify `openspec validate v2-plugin-migration` passes with the deltas in place
- [ ] 4.2 Re-point the existing spec-suite tests (`test/context-autoload.test.js`, `test/path-resolution.test.js`, `test/workdir-injection.test.js`, `test/worktree-branch-reuse.test.js`, `test/worktree-git-root.test.js`) at `core.js` via injected fakes, so each spec's scenarios run once and apply to both adapters structurally; verify `npm test` is green and each test file's `// spec:` header still names its covering spec

## 5. Adapter-conformance tests (Layer 2)

- [ ] 5.1 Write `test/plugin-v2-conformance.test.js`: asserts all four custom tools are registered with `options.codemode === false` (D4 guard), the `execute.before`/`create.before`/`context` hooks are wired and mutate the expected event fields, and `setup()`'s cleanup disposes both the event subscription and the transform registration; verify it passes under `node --test`
- [ ] 5.2 Extend `test/plugin-export-surface.test.js` (or add an equivalent check) so it also covers `plugin.v2.js` and `core.js`: `plugin.v1.js` and `plugin.v2.js` each export `default` only; verify the test fails if a stray named export is (re)introduced

## 6. Known-bug fixes carried in from the WIP audit (D10 R3)

- [ ] 6.1 Restore the AGENTS.md advisory system-prompt block in the V2 session-context hook (was silently missing in the pre-existing WIP commit) — covered by task 3.4
- [ ] 6.2 Make V2's `use_clear` clear `state.agentsMd` whenever `state.cwd` becomes falsy, and report the cleared repository in the return value, matching `context-autoload`'s `use_clear` requirement; verify a test exercises both the explicit-`cwd`-clear and the worktree-clear-cascades-to-cwd cases
- [ ] 6.3 Add the raw `workdir` property and the schema's `required` array to the ineligible-capability log line on V2, matching the `workdir-injection` Diagnostics requirement; verify a test asserts both fields appear in the logged line for a disqualified tool

## 7. End-to-end verification against the real V2 runtime (Layer 3, D9)

- [ ] 7.1 Write a `test:e2e` script (not part of default `npm test`) that runs the plugin against a real `@opencode/cli` instance in a scratch project directory, asserting: (a) `use_cwd` is invoked as a direct native tool call, not routed through Code Mode; (b) a subsequent eligible tool call receives the injected `workdir`; (c) the "Active Session Context (opencode-use)" block appears in the assembled system prompt; verify the script passes locally against the installed `@opencode/cli` version pinned in devDependencies
- [ ] 7.2 Wire `test:e2e` as its own CI job, separate from the default test job, so it cannot be silently skipped; verify the CI config change is present (or, if this repo has no CI config yet, document the intended job in `docs/v2-compat-audit.md` and flag this as a follow-up, since adding CI infrastructure may be out of scope for this change — confirm with the user if unclear)

## 8. Documentation

- [ ] 8.1 Rewrite `docs/v2-compat-audit.md`: replace the warning-banner-only correction with the actual V2 port status, the confirmed API mapping, the `options.codemode: false` requirement, and the D6 env-injection limitation stated in user-facing terms (not just a code comment); verify the doc no longer claims "no migration needed" anywhere

## 9. Final verification and review

- [ ] 9.1 Run the full test suite (`npm test`) and the end-to-end script (`npm run test:e2e`); verify both are green
- [ ] 9.2 Run `openspec validate v2-plugin-migration --strict`; verify it passes
- [ ] 9.3 Commission `code-reviewer` for the full diff (proposal → specs → design → diff); resolve every `[BLOCKER]`, explicitly accept or reject every `[WARNING]`
</content>
