## Why

opencode is incrementally merging an Effect-based rewrite ("V2", `packages/core`)
into the same `opencode-ai` npm package this plugin targets, exposed via
prerelease dist-tags (`next`, `beta`, `dev`) rather than a separate package.
An empirical sandbox test (`opencode2`, a local `opencode-ai@dev` install —
see the `reality/opencode-v2-sandbox-plugin-compat` memory atom) already
showed this plugin's V1 hooks (`tool`, `tool.definition`) load and fire
correctly against the current `dev` build — so this is not a "likely broken"
audit but a "confirm working today, watch for the day it changes" audit.
Before any future opencode major-version bump reaches `latest`, we want a
documented, evidence-based record — grounded in an actual test run, not just
source-reading — of which of this plugin's extension points still work in V2
today, so a breaking upgrade doesn't surprise us. This closes out the
"deferred V2-core-rewrite compatibility risk" already flagged in this
project's own memory (`work/opencode-use-plugin`).

## What Changes

- Add a committed audit document, `docs/v2-compat-audit.md`, recording:
  - Every V1 plugin hook `opencode-use` currently registers (`tool`,
    `tool.definition`, `tool.execute.before`, `shell.env`,
    `experimental.chat.system.transform`) and what each is used for.
  - **Empirical test result** for each hook: load the plugin in a scratch
    project via `opencode2 run "..." --print-logs --log-level DEBUG` and
    record whether the hook actually fires without error (not just whether
    it's documented in the V2 plugin API).
  - Cross-reference against the V2 plugin API docs
    (`packages/plugin/src/v2/{effect,promise}/README.md` in the
    `anomalyco/opencode` source) to note which domains are formally
    documented (`agent`/`catalog`/`command`/`integration`/`reference`/`skill`
    `.transform()`, `aisdk.sdk`/`aisdk.language`) vs. which V1 hooks work today
    without being part of that documented set (i.e. still running on the V1
    runtime in parallel).
  - A risk rating and recommended action per hook, based on the test
    evidence (e.g. "confirmed working on dev build as of <date>; no
    documented V2 equivalent yet — re-test on each `dev` bump").
  - The concrete way to test against V2 in progress: the `opencode2` sandbox
    command (`~/opencode-v2-sandbox`, `opencode-ai@dev`), since there is no
    separately installable "v2" package.
- No behavioral change to the plugin itself. No new dependencies. No V2
  migration code is written in this change — that is out of scope until a
  hook actually breaks.

**Capabilities**

No new or modified capabilities — this change adds a documentation artifact
with no spec-level behavior change. `skip_specs: true` is set in this change's
`.openspec.yaml` accordingly.

## Impact

- Adds `docs/v2-compat-audit.md` to the repository.
- No code, dependency, or configuration changes.
- Informs (but does not itself perform) any future opencode V2 migration work
  for this plugin.
