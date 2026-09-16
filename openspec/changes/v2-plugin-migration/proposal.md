## Why

opencode's real V2 product (`@opencode/cli` / `@opencode/plugin`, distinct
from the `opencode-ai` V1 prerelease channel) uses an entirely different
plugin SDK (`Plugin.define({ id, setup(ctx) })` instead of V1's
object-entrypoint hooks). V1 plugin implementations do not run under V2 at
all — the official migration guide states this explicitly. V1 support for
old-shape plugins is an intentional but time-boxed compatibility bridge
("remove after your support window ends"), so `opencode-use` needs a real,
verified V2 implementation before that window closes, while continuing to
support users still on V1.

## What Changes

- Extract a runtime-agnostic `src/core.js` from the current `src/index.js`:
  session state, the four tool descriptors, the workdir-eligibility
  predicate, the env-key filter, and the system-prompt block builders. Both
  entrypoints become thin adapters over this shared core (see `design.md`
  D1) — the previous single-entrypoint file duplicated no logic, so nothing
  here changes behavior, only where the logic lives.
- `src/plugin.v1.js` (renamed from `src/index.js` via `git mv`): reduced to
  a V1 adapter over `core.js`; identical behavior, identical test
  assertions.
- `src/plugin.v2.js` (new): a real V2 `Plugin.define` adapter over the same
  `core.js`. The documented single-file hybrid-shape trick does not work on
  real V1 builds (confirmed empirically), so separate entrypoints are
  required for genuine dual support. Maps all 5 V1 hooks to their V2
  equivalents:
  - custom tool registration (`use_cwd`, `use_direnv`, `use_worktree`,
    `use_clear`) → `ctx.tool.transform((editor) => editor.add({...}))`,
    each carrying `options: { codemode: false }` in the shared descriptor
    (not per-call) so they remain natively/directly callable instead of
    silently becoming Code-Mode-only (V2's default for a tool with no
    `options` set — confirmed empirically to break direct tool-calling).
  - tool-schema `workdir` annotation (was `tool.definition`) → re-run via
    `editor.update`, re-triggered on `catalog.updated` events, with a
    re-entrancy guard.
  - `tool.execute.before` → `ctx.tool.hook("execute.before", ...)`.
  - `shell.env` → `ctx.shell.hook("create.before", ...)`, using a
    fail-closed env-resolution ladder in place of V1's `sessionID`-keyed
    lookup (V2's payload has no `sessionID` — see D6 and the
    `workdir-injection` spec delta below).
  - `experimental.chat.system.transform` → `ctx.session.hook("context", ...)`,
    including the AGENTS.md advisory block and the D6 injection-caveat line.
  - `$` (shell exec) is resolved once from `globalThis.Bun.$` at setup,
    injected into `core.js` — not reached for ad hoc inside tool bodies —
    so the shared spec suite can inject a fake `$` exactly as the existing
    V1 tests already do.
- Fix the `bash`→`shell` built-in tool-name rename in the workdir-injection
  eligibility check (V2 renamed the built-in `bash` tool to `shell`);
  kept as a per-adapter constant.
- `package.json`: `main`/`"."` stay `plugin.v1.js` (unchanged for existing
  consumers); add explicit `"./v1"` and `"./v2"` subpath exports; mark
  **both** peer dependencies (`@opencode-ai/plugin`, `@opencode/plugin`)
  optional; add `@opencode/plugin` and `@opencode/cli` as devDependencies
  for local test execution and the end-to-end gate.
- `test` script syntax-checks all three files (`core.js`, both adapters);
  a separate `test:e2e` script (not part of the default `npm test`) runs
  one real end-to-end check against `@opencode/cli`, asserting direct
  native callability, workdir injection, and prompt injection — the one
  failure class (Code-Mode silent demotion) invisible to any mock.
- Correct `docs/v2-compat-audit.md`: the original audit tested against
  `opencode-ai@dev`, which is NOT the real V2 product — replace the
  misleading "no migration needed yet" framing with the actual V2 port
  status, findings, and the D6 env-injection limitation (user-facing, not
  just a code comment).
- Existing spec suite (`context-autoload`, `path-resolution`,
  `workdir-injection`, `worktree-branch-reuse`, `worktree-git-root`) is
  re-pointed to exercise `core.js` directly via injected fakes, so it
  structurally covers both runtimes rather than being duplicated per
  adapter; a thin adapter-conformance suite is added per entrypoint for
  wiring-only assertions.

## Spec-level behavior

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `workdir-injection`: requirement text currently names V1 mechanisms
  (`experimental.chat.system.transform`, `tool.definition`,
  `tool.execute.before`, `shell.env`) as normative, and mandates a
  three-source schema ladder (including raw-Zod detection) that V2 cannot
  satisfy (V2 schemas are always plain JSON Schema). Needs: (a) mechanism
  names reframed as per-runtime notes rather than the sole normative
  mechanism, (b) a V2 clause for the Shell Environment Injection
  requirement, since `ShellCreateBefore` on V2 carries no `sessionID` — the
  two V1 scenarios "no session ID → not modified" / "unknown session ID →
  not modified" are not computable as written; replaced on V2 by a
  fail-closed env-resolution ladder (single env-bearing session, else
  `cwd`-based correlation, else no injection + log) that never injects one
  session's environment into another.
- `context-autoload`: requirement text names
  `experimental.chat.system.transform` as normative; needs the same
  mechanism-neutral reframing (V2 uses `ctx.session.hook("context", ...)`).
  No behavioral change to the AGENTS.md advisory block itself.

## Impact

- `src/index.js` → renamed `src/plugin.v1.js` (`git mv`, history preserved),
  reduced to a V1 adapter.
- `src/core.js` (new): extracted runtime-agnostic behavior, shared by both
  adapters.
- `src/plugin.v2.js` (new): V2 adapter over `core.js`.
- `package.json`: `exports` (`"./v1"` added), both peer deps optional,
  `@opencode/plugin` + `@opencode/cli` devDependencies, `test`/`test:e2e`
  scripts.
- `docs/v2-compat-audit.md`: corrected/expanded to reflect the real V2 port
  and the D6 limitation.
- `openspec/specs/workdir-injection/spec.md`,
  `openspec/specs/context-autoload/spec.md`: delta specs per the Modified
  Capabilities section above.
- Existing tests re-pointed at `core.js`; new adapter-conformance tests per
  entrypoint; new `test:e2e` script and CI job.
- No change to `lib.js` (unchanged, imported by `core.js` exactly as before).
- Consumers on V1 are unaffected (`"."` and `main` unchanged). Consumers who
  opt into `"./v2"` get the new V2 plugin, with the D6 caveat documented.
