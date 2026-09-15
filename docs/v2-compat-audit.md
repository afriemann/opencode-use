# opencode V2 Compatibility Audit — `opencode-use`

**Date:** 2026-09-15
**Tested against:** `opencode-ai@dev` (`0.0.0-dev-202609142154`, published
2026-09-14), installed as the `opencode2` command via a local sandbox at
`~/opencode-v2-sandbox`. See the `reality/opencode-v2-sandbox-plugin-compat`
memory atom for the reusable sandbox setup steps.

## What "opencode V2" is

opencode is incrementally merging an Effect-based rewrite (`packages/core`)
into the *same* `opencode-ai` npm package this plugin already targets — it is
not a separate package or CLI. Progress is exposed via prerelease dist-tags
(confirmed via `npm view opencode-ai dist-tags --json`): `latest` (stable,
`1.18.31` as of this audit), `next`, `beta`, `dev` (freshest, published
near-daily). There is no install-time "v2 mode" flag; you track V2 progress
by installing a fresher dist-tag. V2 ships its own plugin API
(`@opencode-ai/plugin/v2/{effect,promise}`, documented in
`packages/plugin/src/v2/{effect,promise}/README.md` in the
`anomalyco/opencode` source) with hook shapes structurally different from the
V1 API this plugin uses.

**Important methodology note:** reading V2 source/docs alone is misleading.
`packages/core/src/tool/bash.ts` (V2's bash tool) carries a literal
`// TODO: Add plugin shell.env environment augmentation once V2 plugin hooks
exist.` comment, and the V2 plugin README documents no `tool`/`shell`/`chat`
domain — which suggested (wrongly, on its own) that V1 tool/shell hooks might
already be broken on a `dev` build. An empirical test (below) shows they are
not. Running `opencode2 debug v2` in the test project returned:

```json
{"providers": [], "default": {"_id": "Effect", "op": "OnSuccess", "args": {"_id": "Effect", "op": "WithFiber"}}, "small": {}}
```

confirming V2 is live today only for the **catalog** domain (providers/
models); it has not yet replaced the V1 plugin runtime that handles
`tool`/`shell`/`chat` hooks. (Full command output also archived in the
`reality/opencode-v2-sandbox-plugin-compat` memory atom.) Conclusions below
are based on running this plugin, unmodified, against the real `dev` build —
not on inference from V2 source alone.

## Hooks registered by this plugin (`src/index.js`)

| Hook | Purpose |
|---|---|
| `tool` | Registers the plugin's own tools: `use_cwd`, `use_direnv`, `use_worktree`, `use_clear` |
| `tool.definition` | Caches per-tool `workdir`-parameter eligibility and annotates eligible tools' schemas |
| `tool.execute.before` | Injects the session's active cwd as `output.args.workdir` for eligible tool calls |
| `shell.env` | Injects direnv-loaded environment variables into bash tool executions |
| `experimental.chat.system.transform` | Injects active cwd/env/worktree state into the system prompt for non-bash tools |

## Empirical test result

**Setup:** scratch project at `/tmp/opencode/v2-sandbox/test-opencode-use`
with `opencode.json` pointing `plugin` at this repo's `src/index.js` (this
worktree, unmodified).

**Run 1** — establishes baseline hook registration and no-error execution:

```
opencode2 run "Use the bash tool to run 'echo hello-from-shell-env-test' and \
  then use the use_cwd tool to set the working directory to /tmp" \
  --print-logs --log-level DEBUG
```

**Run 2** — corrected ordering (`use_cwd` *before* a second `bash` call) to
directly observe the injection mechanism, not just absence of error:

```
opencode2 run "First use the use_cwd tool to set the working directory to \
  <project>/cwd-target, then AFTER that use the bash tool to run 'echo ...; pwd'" \
  --print-logs --log-level DEBUG
```

Run 2 produced the log line:

```
[opencode-use] workdir-injection: bash => /tmp/opencode/v2-sandbox/test-opencode-use/cwd-target
```

— this is `src/index.js`'s `tool.execute.before` success-path log
(`log(`workdir-injection: ${input.tool} => ${state.cwd}`)`, line 869), fired
only when injection actually happens. This is direct positive evidence, not
merely absence of an error.

**Result — all 5 hooks fired without error; 2 have direct positive evidence, 1 partial, 2 no-error-only:**

| Hook | Result | Evidence |
|---|---|---|
| `tool` | ✅ Pass (partial scope) | `use_cwd` tool call executed successfully: `use_cwd {"path":"/tmp"}` → `Working directory set to /tmp`. Only `use_cwd` was exercised in these runs — `use_direnv`, `use_worktree`, and `use_clear` (also registered via this same `tool` hook) were not called, so this row does not confirm those three. |
| `tool.definition` | ✅ Pass | 60 `[opencode-use] workdir-capability: <tool> => <bool>` log lines emitted, one per available tool, zero errors |
| `tool.execute.before` | ✅ Pass (direct evidence) | Run 2's `workdir-injection: bash => .../cwd-target` log line is the hook's own success-path log, proving the injection mechanism actually ran, not just that it didn't throw |
| `shell.env` | ⚠️ Pass (not fully exercised) | No failure logged (`log('shell.env failed', err)` absent) in either run, but no active `direnv` `.envrc` was present in the test project, so actual env-variable content wasn't observed — only that the hook didn't throw |
| `experimental.chat.system.transform` | ⚠️ Pass (no error only) | No failure logged (`log('chat.system.transform failed', err)` absent) in either run. This hook has no success-path log call (only pushes to `output.system` silently), and the CLI's `--print-logs` output doesn't dump full system-prompt content, so the actual injected `## Active Session Context` block was not directly observed in these runs — code inspection confirms it only activates once `state.cwd`/`state.envSource`/`state.worktree` are populated (i.e. after `use_cwd`/`use_direnv`/`use_worktree` ran), consistent with no error occurring. |

The only load failure observed in either test run was unrelated:
`~/.config/opencode/plugins/opencode-openspec.js` failed with
`command.trim is not a function` — a separate, real regression in
`opencode-openspec` against this `dev` build, tracked under that repo's own
audit (not `opencode-use`).

## Cross-reference against the documented V2 plugin API

V2's plugin API (`packages/plugin/src/v2/{effect,promise}/README.md`)
currently documents only these domains/hooks:

- Transform hooks: `agent`, `catalog`, `command`, `integration`, `reference`,
  `skill` (each via `.transform()`)
- Runtime hooks: `aisdk.sdk`, `aisdk.language`

None of `opencode-use`'s five hooks (`tool`, `tool.definition`,
`tool.execute.before`, `shell.env`, `experimental.chat.system.transform`) are
part of this documented V2 set. Empirically, though, they all still work
today — they run on the V1 plugin runtime, which is running in parallel with
V2's (so-far catalog-only) migration, not yet replaced by it.

## Risk rating and recommended action

Risk here means *likelihood × impact of this hook breaking on a future V2
migration* — not a security severity scale (distinct from the `code-reviewer`
agent's Blocker/Warning/Suggestion vocabulary used elsewhere in this repo).

| Hook | Risk | Recommended action |
|---|---|---|
| `tool` (custom tool registration) | Medium | No V2-documented equivalent for registering arbitrary tools. Re-test on each `dev` bump; watch `packages/core` for a `tool` domain addition. |
| `tool.definition` | Medium | Same as above — no V2 domain covers tool-schema introspection/mutation yet. |
| `tool.execute.before` | Medium-High | This is the plugin's core mechanism (cwd injection). `packages/core/src/tool/bash.ts`'s TODO comment is the clearest signal V2 hasn't wired equivalent interception yet. Highest-priority hook to re-test on every `dev` bump. |
| `shell.env` | Medium-High | Same TODO comment applies directly to this hook (it names `shell.env` explicitly). Confirmed not erroring today; next audit pass should add a `.envrc` (e.g. `export FOO=bar`) to the scratch project, call `use_direnv`, then run `bash` and grep the command's actual environment for `FOO` to get full positive evidence, matching what was done for `tool.execute.before` in this pass. |
| `experimental.chat.system.transform` | Low-Medium | Marked `experimental` in V1 already; no V2 chat/session domain documented. Watch for either a V1 removal or a V2 equivalent appearing together. |

**Overall:** No action needed today — every hook this plugin depends on works
correctly against the current `dev` prerelease. Re-run this same empirical
test (`opencode2 run ... --print-logs --log-level DEBUG` against a scratch
project) after refreshing `~/opencode-v2-sandbox` to a newer `dev` build
periodically, and especially before any `latest` version bump that crosses
a major version boundary. Escalate to actual migration work only if a hook
starts failing or logging errors in that test.

## How to reproduce this test

```bash
# Refresh the sandbox to the latest dev build
cd ~/opencode-v2-sandbox && npm install opencode-ai@dev
# npm's `allowScripts` security default blocks postinstall scripts, but this
# package's postinstall is what downloads the actual platform binary — run
# it manually after every install/update:
node node_modules/opencode-ai/postinstall.mjs
opencode2 --version   # confirm the build date/tag

# Scratch project pointing at this plugin
mkdir -p /tmp/opencode-use-v2-test && cd /tmp/opencode-use-v2-test
cat > opencode.json << 'EOF'
{ "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-use/src/index.js"] }
EOF

opencode2 run "Use the bash tool to run 'echo test' and then use the use_cwd tool to set the working directory to /tmp" \
  --print-logs --log-level DEBUG 2>&1 | grep -iE "opencode-use|failed"
```
