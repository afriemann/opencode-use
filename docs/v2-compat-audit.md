# opencode V2 Compatibility - `opencode-use`

V2 uses `src/plugin.v2.js` with `@opencode/plugin >= 2.2.5`; V1 uses
`src/plugin.v1.js` with `@opencode-ai/plugin >= 1.15.0`. Both share tool and
directory/environment logic in `src/core.js`.

## Runtime entrypoints

Custom tools, workdir routing, environment handling and advisory semantics
are shared. V1 delivers live context in system blocks; V2 delivers anchored
ordinary-user-message snapshots with constant system trust framing.

| Consumer wants | Import |
|---|---|
| V1 (`opencode-ai` / `@opencode-ai/plugin`, current default) | `opencode-use` or `opencode-use/v1` |
| V2 (`@opencode/cli` / `@opencode/plugin`) | `opencode-use/v2` |

`package.json`'s `main`/`"."` still resolve to V1 — existing installs are
unaffected. Opting into V2 is an explicit `"./v2"` import.

## V1 → V2 hook mapping

| V1 hook | V2 destination |
|---|---|
| `tool` (custom tool registration) | `ctx.tool.transform((editor) => editor.add({...}))` |
| `tool.definition` (workdir schema annotation) | same `transform`, `editor.update(...)`, re-run on `mcp.tools.changed` |
| `tool.execute.before` | `ctx.tool.hook("execute.before", ...)` |
| `shell.env` | `ctx.shell.hook("create.before", ...)` |
| `experimental.chat.system.transform` | `ctx.session.hook("context", ...)`: constant system framing and chronological message replay |

## Required tool option: `options: { codemode: false }`

**This is the single most important fact for anyone porting a plugin's
custom tools to V2.** A tool registered via `editor.add()` with no
`options.codemode` set (or `codemode: true`) is **Code-Mode-only**: the
model can only reach it indirectly, via a separate `execute` JS-execution
tool (`await tools.use_workdir({...})`), never as a direct native tool call.
Confirmed empirically against the real `@opencode/cli` 2.0.4 runtime:

```
✗ use_workdir {"path":"."} failed
Error: No tool named "use_workdir" is currently available. Please use a tool from the available tool list.
⚙ execute {"code":"return await tools.use_workdir({ path: \".\" });"}
```

Setting `options: { codemode: false }` on the tool descriptor fixes this —
the tool becomes directly callable with no fallback:

```
⚙ use_workdir {"path":"."}
```

`options: { pinned: true }` does **not** fix this (tested — no effect on
direct callability); do not confuse the two. `codemode`'s default/effect is
documented in plain prose only for MCP server config
(https://opencode.ai/v2/docs/mcp-servers/: "Defaults to `true`. Set to
`false` to expose the server's tools directly to the model instead of
through Code Mode.") — the plugin `ctx.tool.transform` docs page uses the
identical field/shape but never states a default for plugin tools
specifically; this was confirmed by direct empirical testing, not doc prose
alone.

Every custom tool this plugin registers on V2 sets `options.codemode: false`
in its shared `core.js` descriptor (not per-call — see design rationale
below).

## Known limitation: shell-environment injection without a `sessionID`

V2's `ShellCreateBefore` hook payload (`ctx.shell.hook("create.before", ...)`)
carries `{ command, cwd, timeout, shell, env }` — **no `sessionID`**, unlike
V1's `shell.env` hook. This plugin's environment injection (`use_direnv`)
is normally scoped per-session by `sessionID`; on V2 that information is not
available.

**Mitigation:** a fail-closed resolution ladder, in this order:

1. If exactly one tracked session has a non-empty environment, use it.
2. Otherwise, if exactly one env-bearing session's working directory equals
   or is an ancestor of the shell invocation's `cwd`, use that session's
   environment.
3. Otherwise, inject **nothing**, and log the candidate sessions once.

This never injects one session's environment into a different session's
shell call — an ambiguous case always resolves to "inject nothing," never a
guess. **Practical impact:** if you run multiple concurrent opencode
sessions on V2, each with a different `use_direnv`-loaded environment, and
their working directories don't disambiguate them, environment injection may
be skipped for some shell calls. The applicable V2 snapshot states the
caveat when the requesting session has a loaded environment and more than
one tracked session has a nonempty environment. Another session loading or
clearing its environment updates this warning at the next settled hook.

This does not affect V1 at all — V1's `shell.env` hook still receives a
real `sessionID` and injects deterministically.

## Architecture: `core.js` + two adapters

`src/core.js` holds everything runtime-agnostic: session state, the four
tools' business logic (`executeUseWorkdir`, `executeUseDirenv`,
`executeUseWorktree`, `executeUseClear`), the workdir-eligibility JSON-Schema
predicate, the env-key filter, and the context renderers.
`plugin.v1.js` and `plugin.v2.js` are thin adapters that wire each host's
hook surface onto this shared core and inject host-specific dependencies
(`$`, a log sink, the base directory).

`src/context-journal.js` owns V2 replay and persistence. Records retain exact
snapshot bytes, whole-host-prefix fingerprints and minimal ordering/window
metadata. Unchanged tool loops replay each applicable record once at its
original boundary. Changes append complete replacements, including absence
and advisory withdrawal. Pending mutations settle before rendering; canonical
host moves do not overwrite intentional tool cwd overrides.

### Persistence and failure boundary

Rendered cwd/worktree paths, advisory text and environment source/count can
be confidential. The journal stores these for replay, not environment values,
execution state, host-message excerpts or raw requests. Fingerprints are
internal identifiers, not anonymized conversation data. Reload hydrates replay
records separately from fresh execution state.

Missing anchors remain dormant through reversible history windows. Replayed
records never move to similar-looking messages or the current tail. Historical
copies can survive file correction while retained host history remains
replayable. `use_clear` withdraws current applicability without rewriting that
history; journal deletion cannot recall provider-held content. Exact replay
precludes arbitrary TTL or rolling eviction of already-sent snapshots.

Deletion drains in-process journal writes before final removal. Journal-only
startup and periodic sweeps, plus pre-replay/write checks, erase confirmed
orphan records. Indeterminate existence checks authorize neither replay nor
new writes. Host KV has no session cascade or compare-and-set; cross-process
atomic erasure is not promised. Unreadable/invalid journals, storage exhaustion
and rejected writes abort the awaited context hook with sanitized diagnostics,
never fall back to mutable system text or stale/incomplete snapshots.

Freshness ends at the context hook's final settled snapshot, not physical
network send. Prefix stability is structural evidence only; provider cache
hits and billing improvements require separate measurement.

## Other V2-specific facts

- The built-in `bash` tool is renamed `shell` on V2 — the "always eligible
  for workdir injection" constant differs per adapter accordingly.
- V2 tool schemas are always plain JSON Schema — V1's raw-Zod schema-source
  detection (needed because `parameters` was a raw Zod object on hosts
  predating opencode 1.14.49) doesn't apply and stays V1-only.
- V2's plugin `Context` has no shell-exec (`$`) member. The V2 adapter
  resolves `globalThis.Bun.$` once at `setup()` and fails loudly (a thrown
  error with an actionable message) if it's absent, rather than failing
  silently at first tool call. This plugin currently requires a Bun-hosted
  V2 runtime as a result.
- The `mcp.tools.changed` event (a real, verified event type in
  `@opencode/schema`'s event manifest — an earlier draft named this
  `catalog.updated`, which does not exist and would never have fired)
  triggers a re-scan of tool schemas for workdir eligibility, guarded against
  re-entrancy.

## Verification

`npm run test:context-cache` uses the locked 2.2.5 CLI and an isolated local
fake provider. It captures final primary HTTP request bodies in memory,
without prompt/environment logging or real model credentials. It exercises
native tool loops, context/advisory changes and clearing, other-session
environment warnings, restart, textual/native-window compaction, and revert.
Auxiliary request kinds do not consume the primary-response fixture.

- **Correction:** the original plan called for re-pointing the five
  existing spec-suite test files directly at `core.js` (via injected
  fakes), so the same test file structurally exercises both runtimes. That
  re-point was **not done** — the five files (`context-autoload`,
  `path-resolution`, `workdir-injection`, `worktree-branch-reuse`,
  `resolve-git-root`) still import `plugin.v1.js` unchanged. Since
  `plugin.v1.js` is now a thin pass-through to `core.js`'s exported
  functions, this *does* still transitively exercise `core.js`'s logic
  through the V1 adapter's call path — but it is not the same guarantee as
  running the same assertions directly against `core.js`, and it says
  nothing about the V2 *adapter's own wiring* (which hook receives which
  event shape, whether mutations land on the right object). That wiring is
  covered separately, and only, by `test/plugin-v2-conformance.test.js`.
- `test/plugin-v2-conformance.test.js` covers V2-adapter wiring:
  `options.codemode: false` on every custom tool (via a live assertion in
  `plugin.v2.js` itself, not just a test), hook mutation shapes, cleanup
  disposal of all four registrations, the real `mcp.tools.changed` reload
  path, and that `use_direnv`/`use_worktree`/`use_clear` are each reachable
  through their V2 `execute()` wrapper.
- `test/env-resolution-ladder.test.js` covers the V2 shell-env fail-closed
  ladder in isolation (single-session, cwd-match, and ambiguous cases).
- `npm run test:e2e` (not part of default `npm test`) runs one real
  end-to-end check against the actual `@opencode/cli` binary, asserting
  direct (non-Code-Mode) tool callability and workdir injection — the one
  failure class invisible to any mock.

**Follow-up needed:** `test:e2e` is not yet wired into CI (`.github/workflows/ci.yml`).
It requires a real model credential (currently invoked with
`--model github-copilot/claude-sonnet-5`) and makes a live LLM call, which
CI runners don't have configured today — adding it needs an explicit
decision on which credential to provision and whether the cost/flakiness of
a live-model CI job is acceptable, not a default action. Run it locally
before releasing changes to `plugin.v2.js` until that decision is made.

## History: the original `opencode-ai@dev` audit (2026-09-15)

Preserved for its still-useful empirical method (testing hooks live against
a running build rather than inferring compatibility from source alone) and
because it correctly found a real, unrelated bug (`opencode-openspec`
crashing against `opencode-ai@dev` — since fixed, see that repo's own
`v2-compat-audit` PR): all 5 V1 hooks (`tool`, `tool.definition`,
`tool.execute.before`, `shell.env`, `experimental.chat.system.transform`)
were confirmed still working on the `opencode-ai@dev` prerelease as of
`0.0.0-dev-202609142154` (2026-09-14) — this remains true today and is
unrelated to the real V2 migration documented above. `opencode-ai@dev` is
V1's own prerelease channel and will presumably keep running V1-shape
plugins for as long as that channel exists; it says nothing about the real
V2 product's compatibility.

## Native worktree capability assessment (V2 2.0.6)

A later review (separate from the port work above) re-examined this
plugin's V2 design against opencode V2's real native capabilities, to check
whether any of `use_worktree`/`use_clear`/`use_direnv` could now be replaced
by a native domain instead of plugin-owned logic. Two hypotheses were
investigated and both were **confirmed wrong**, verified directly against
the real V2 source (`/tmp/opencode/v2-src`, tag `v2.0.6`):

1. **"Native `ctx.worktree`/`ctx.vcs` domains could replace or found
   `use_worktree`/`use_clear`."** Confirmed wrong: the native worktree
   domain's `create()` — both the bundled "git" strategy
   (`packages/core/src/worktree/git.ts`) and the plugin-facing
   `WorktreeDefinition`/`WorktreeCreateInput` extension point
   (`packages/plugin/src/worktree.ts`) — **has no concept of creating a new
   git branch at all**. `WorktreeCreateInput.branch` is documented in-source
   as "a starting ref, not the name of a new branch," and the bundled
   strategy hardcodes `git worktree add --detach --`. This plugin's entire
   purpose (named-branch feature-development workspaces, optionally rebased
   on a live-detected remote default branch) has no native equivalent.
   Native `ctx.worktree.list()` also carries no `branch` field, so it
   can't replace this plugin's own `git worktree list --porcelain` parsing
   either.
2. **"Setting `options.permission` on `use_clear`'s destructive removal
   branch would route it through a native confirmation prompt."** Confirmed
   wrong, for the same reason found in the parallel `opencode-openspec`
   review: `options.permission` (verified against
   `packages/core/src/tool.ts`) only affects wholesale tool-visibility
   filtering at snapshot time (deny-only, hides the tool from the model's
   catalog entirely) — it never gates a specific invocation with an
   ask-prompt, and `ctx.permission.rules(...)` doesn't exist on the real
   plugin-facing `PermissionDomain` type at all. There is no native
   mechanism, as of V2 tag `v2.0.6`, for a plugin-registered custom tool to
   gate its own invocation behind a real confirmation prompt.

A sweep of the remaining native domains (`ctx.storage`, `ctx.command`,
`ctx.integration`, `ctx.mcp`, `ctx.skill`, `ctx.reference`,
`ctx.generate.text`) found nothing else applicable to this plugin.
`use_direnv`'s shell-env-injection approach and the cross-repo
worktree-contamination guard were reconfirmed as genuinely plugin-unique,
irreplaceable functionality.

Named-branch workspaces and directory-scoped environment handling remain
plugin responsibilities. Model-context delivery follows the current contract
and verification method described above.
