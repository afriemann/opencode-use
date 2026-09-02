## Context

See `proposal.md` — Why. This design covers only *how* the generalization is built.

Constraints that shape the approach:

- **Two hooks, two different inputs.** `tool.definition` receives `{ toolID }` plus
  `output.parameters` (the tool's schema) but no session. `tool.execute.before`
  receives `{ tool, sessionID }` plus `output.args` (the runtime arguments) but
  **no schema**. Neither hook alone can both decide eligibility and act on it, and
  there is no documented synchronous "look up a tool's schema" API available from
  inside `tool.execute.before`.
- **The installed SDK gives no type help.** In
  `@opencode-ai/plugin/dist/index.d.ts` the `tool.definition` hook is typed
  `(input: { toolID: string }, output: { description: string; parameters: any })`.
  `parameters` is `any`, so eligibility detection is a runtime shape check by
  contract, not a compile-time guarantee.
- **Existing behaviour must not regress.** `bash` keeps both workdir injection and
  `export K=V && …` env-prefix injection; env injection stays `bash`-only because
  only `bash` has a shell `command` string to prepend to.
- **Failure must be silent.** Both hooks already swallow their own errors so a
  plugin fault can never break tool execution. That stays.
- **Personal repo, single maintainer.** Prefer the smallest mechanism that works
  over configurable machinery.

## Goals / Non-Goals

**Goals**

- Any tool whose schema declares an optional `workdir` string parameter receives
  the same automatic injection and schema annotation `bash` receives today.
- `bash` ceases to be a special case for *workdir*; it remains the only special
  case for *env*.
- The mechanism is fail-closed: anything the plugin cannot positively confirm as
  workdir-capable is left untouched.

**Non-Goals** (see also *Non-Goals* section below for the external ones)

- No configuration surface, no opt-out list, no per-session tuning.
- No change to `read` / `write` / `edit` / `glob` / `grep` handling — they have no
  `workdir` parameter and remain served by the system-prompt section.
- No coordination protocol, handshake, or version negotiation between this plugin
  and the tools it injects into. Eligibility is inferred from the schema alone.

## Decisions

### 1. Schema access via `output.parameters.properties.<name>` — assumption with justification

**Decision.** Read eligibility from `output.parameters?.properties?.workdir` and
treat that as valid for *every* tool, regardless of the schema library the tool
was authored with (zod, effect-schema, hand-written JSON Schema, anything else).

**Why this is safe, not a gamble.** The functional half of this feature — writing
`state.cwd` into `output.args.workdir` in `tool.execute.before` — operates on the
plain runtime arguments object and touches no schema at all, so it is entirely
outside the reach of any schema-dialect concern. Only the *descriptive* half (the
`tool.definition` annotation) reads a schema. And opencode must convert every
tool's parameters into JSON Schema before it can send tool definitions to any
LLM's function-calling API — that conversion is a hard requirement of every
provider's tool-calling contract, not an opencode implementation detail. By the
time `tool.definition` fires, the object handed to the hook has therefore already
been normalized to JSON Schema. `properties.<name>` is consequently the
architecturally correct access pattern for any tool, and the earlier
schema-dialect concern is closed rather than deferred.

**Residual handling.** Because `parameters` is typed `any` and a tool may declare
no parameters at all, every access stays optional-chained; a missing
`properties` object simply yields "not eligible".

### 2. Eligibility predicate

**Decision.** A tool is workdir-capable when its schema declares `workdir` as an
**optional string with no enum constraint**:

```js
const p = output.parameters?.properties?.workdir
const required = output.parameters?.required
const eligible =
  !!p && p.type === 'string' && !('enum' in p) &&
  !(Array.isArray(required) && required.includes('workdir'))
```

**Rationale for each clause.**

- `type === 'string'` — a `workdir` that is an object, array, or boolean is a
  different concept that happens to share a name; injecting a path string into it
  would corrupt the call.
- no `enum` — an enum-constrained parameter has a closed value set the session's
  arbitrary absolute path will not belong to. Rejecting it avoids producing a
  schema-invalid argument.
- **not in `required`** — this clause extends the agreed predicate and is a
  design judgement, flagged so it can be dropped without affecting anything else.
  Both the proposal and the current spec describe the target as an *optional*
  `workdir` parameter. Annotating a **required** parameter with "you do not need
  to set it" directly contradicts its own schema and would push the model toward
  emitting an invalid call. Injection into a required param is also near-useless
  in practice, since the model must supply a value anyway and the
  explicit-value-wins guard would then suppress the injection. Rejecting required
  params costs one array check and removes a self-contradicting annotation.

### 3. Registry: module-level `Map<toolID, boolean>`, no TTL

**Decision.** A module-level `const workdirCapable = new Map()` sits beside the
existing module-level `sessions` map (`src/index.js:10`). `tool.definition`
writes into it; `tool.execute.before` reads from it. The key is the bare
`toolID` string.

**Why a cache is required at all.** `tool.execute.before` never sees a schema.
Caching the verdict at definition time is the only available path from "what the
schema says" to "what the call does".

**Why no TTL, no invalidation, no cross-session bookkeeping.** The registry sends
a tool's definition to the model *before* the model can call that tool — a model
cannot invoke a tool it was never shown. `tool.definition` for tool *X* therefore
always fires before any `tool.execute.before` for *X* within the same LLM turn.
The cache is consequently repopulated, from the authoritative schema, on every
turn in which the tool is callable at all. There is no window in which a stale
entry can be read, so expiry logic would guard against nothing.

**Why `toolID` alone is a sufficient key.** `tool.definition` is given no
`sessionID`; tool schemas are a property of the installed toolset, not of a
session. A session-scoped key is impossible to construct and would be wrong if it
were.

**Fail-closed default.** A missing entry (`.get()` → `undefined`) is falsy and
means "do not inject". If the hook never fires, or a schema shape defeats the
predicate, the outcome is today's behaviour for that tool — manual `workdir` —
never a wrong injection.

### 4. Idempotency: the annotation is its own sentinel

**Decision.** Before appending, check whether the parameter description already
contains the annotation string, and skip if so. The check reads the **live
description string**, not a side flag:

```js
if (p.description?.includes(WORKDIR_ANNOTATION)) return
p.description = (p.description ?? '') + WORKDIR_ANNOTATION
```

**Why a string sentinel and not a "already annotated" boolean.** A per-`toolID`
boolean flag would be wrong: if opencode constructs a fresh definition object per
turn (the likely case), a sticky flag would suppress the annotation on every turn
after the first, silently disabling the feature. Only state carried *on the
object being mutated* answers the actual question "has *this* object already been
appended to". Using the full annotation constant as its own marker adds no extra
token to the prompt and cannot drift out of sync with the text it guards.

This is cheap insurance against compounding, not a fix for observed compounding.

### 5. Tool-agnostic annotation text

**Decision.** Extract the appended guidance into a single module-level constant
that names no specific tool. The current text says "Previous **bash** calls in
your context…"; generalized, it must read in terms of "this parameter" and "this
tool" so it is correct when appended to any eligible tool's schema.

The same de-bashing applies to the `experimental.chat.system.transform` section
and the `use_cwd` / `use_direnv` / `use_worktree` descriptions: "every bash call"
becomes "every tool call that accepts a `workdir` parameter". The env sentence in
that section stays explicitly `bash`-scoped.

### 6. Self-injection guard, placed once

**Decision.** Exclude the plugin's own tool IDs — `use_cwd`, `use_direnv`,
`use_worktree`, `use_clear` — from annotation and from the capability cache, via
a module-level `Set` checked at the top of `tool.definition`.

**Why one guard is enough.** Excluding them at definition time means they are
never *recorded* as workdir-capable, and the execute-side cache lookup is already
fail-closed, so it rejects them for free. A second guard in
`tool.execute.before` is harmless but redundant; the engineer may add it as belt
and braces without changing behaviour.

This is defensive coding: none of the four currently declares a `workdir`
parameter. It exists so a future edit to one of them cannot make the plugin
inject into itself.

### 7. Hook body shape and guard order

**`tool.definition`** — cheapest rejection first:

1. self-tool `Set` check → return;
2. predicate (§2) → on failure record `false` and return;
3. sentinel check (§4) → return if already annotated;
4. append annotation, record `true`.

**`tool.execute.before`** — one shared `output.args` guard, then the two
independent branches:

1. `if (!output.args) return` — the args guard, hoisted because both branches
   write into it;
2. `const state = sessions.get(input.sessionID); if (!state) return`;
3. **env branch**, `bash`-only: prepend `export K=V && …` to
   `output.args.command`;
4. **workdir branch**, generic: `if (workdirCapable.get(input.tool) !== true)
   return`, then `if (state.cwd && !output.args.workdir) output.args.workdir =
   state.cwd`.

**Note the structural payoff.** `bash` needs no special-casing on the workdir
path — it satisfies the generic predicate like any other eligible tool — so the
only remaining `input.tool === 'bash'` test in the hook is the env branch. The
code shape mirrors the spec shape decided in §9: one generic workdir requirement,
one `bash`-only env requirement.

The explicit-value-wins guard (`!output.args.workdir`) is unchanged and remains
the model's per-call override.

### 8. External beneficiary: `git-host-check`

`~/.config/opencode/tools/git-host-check.ts` (source in the `ai-dotfiles` repo)
is being migrated from an optional `cwd` argument to `workdir` alongside this
change, as a lightweight direct edit in that repo. It is **not** a task of this
change and does not appear in these specs — but it is the reason this
generalization ships with a real, exercisable beneficiary rather than a
speculative one. If that migration does not land, this change still stands on its
own; it simply has no non-`bash` consumer yet.

### 9. Spec-delta authoring: split the bundled requirement

The current main spec has one requirement,
`### Requirement: Bash Tool Workdir and Environment Injection`, that bundles two
behaviours which now diverge — workdir injection generalizes, env injection stays
`bash`-only. OpenSpec matches `MODIFIED` deltas by **exact existing header text**,
and there is exactly one existing header covering both behaviours, so "modify
both" is not expressible: one header cannot match two delta entries.

**Recommended delta shape.**

| Existing requirement | Fate | Delta operation |
| --- | --- | --- |
| `Bash Tool Workdir and Environment Injection` | splits in two | `REMOVED` (with reason: split), plus `ADDED` `Tool Workdir Injection` (generic) and `ADDED` `Bash Environment Injection` (`bash`-only, substance unchanged, scope clarified) |
| `Bash Tool Schema Annotation` | generalizes + renames | `REMOVED` plus `ADDED` `Tool Workdir Schema Annotation` |
| `System Prompt Session Context` | wording only, header kept | `MODIFIED` — drop the "every bash call" framing; qualify the `read`/`write`/`edit`/`glob`/`grep` guidance as "tools that have no `workdir` parameter" |

The third requirement is included because its current text asserts that non-`bash`
tools have no `workdir` parameter — an assertion this change falsifies.

**Fallback if the tooling objects to the rename-by-removal shape:** keep the
existing header under `MODIFIED` for the generalized workdir requirement and
`ADD` the `bash`-env requirement beside it, accepting a now-inaccurate
requirement name. Prefer the table above; the name matters for a spec that will
be read repeatedly.

Run `openspec validate generalize-workdir-injection --strict` after authoring
either shape. Spec authoring itself is the engineer's step, not this document's.

## Alternatives Considered

**A general opt-out deny-list.** A configurable list of tool IDs excluded from
injection. **Rejected — YAGNI.** No tool is known to declare a `workdir` string
parameter with semantics that would be harmed by injection, and this is a
single-maintainer personal repo where the cost of *not* having the escape hatch
is one direct edit. The §2 predicate plus the explicit-value-wins guard already
cover the realistic mis-fire cases. This is a considered-and-rejected
alternative, not deferred work — re-open it only if a concrete offending tool
appears.

**Query the tool registry at execute time instead of caching.** Look the schema
up on demand inside `tool.execute.before`, avoiding the cache entirely.
**Rejected — not available.** `tool.execute.before` is handed only
`{ tool, sessionID }` and `output.args`; it receives no schema, and there is no
documented synchronous registry-lookup API reachable from a plugin hook. Even if
one existed, it would repeat schema work on every call to buy invalidation
guarantees the ordering property in §3 already provides for free.

**A per-`toolID` boolean "already annotated" flag for idempotency.** Rejected in
§4: it answers a different question than the one being asked and would disable
the annotation entirely if definition objects are recreated per turn.

**Keeping `bash` as an explicit special case on the workdir path.** Rejected: it
would duplicate the generic path for no behavioural gain and would keep the code
shape out of step with the split spec.

## Non-Goals

- **Migrating `git-host-check` itself.** Handled separately in the `ai-dotfiles`
  repo (see §8). Not a task, spec, or test of this change.
- **Migrating `opencode-openspec`'s `cwd`-named tools** (`openspec_cli`,
  `openspec_status`, `openspec_instructions`). Explicitly out of scope: separate
  repo, the user's own follow-up. This plugin deliberately does **not** bridge the
  gap by also injecting into a `cwd` parameter — see the compatibility window
  below.
- **Any configuration surface** for enabling, disabling, or scoping injection.

## Risks / Trade-offs

- **Known compatibility window: `cwd`-named tools stay manual.** Until
  `opencode-openspec` migrates, its tools still take `cwd` and receive no
  injection; the agent must pass the directory explicitly. → *Mitigation:* the
  system-prompt section still reports the active working directory, so the agent
  has the value available to pass by hand — the same position it is in today.
  Accepted deliberately: injecting into `cwd` as well would double the surface
  and entrench a name this ecosystem is migrating away from.

- **A third-party tool could declare a `workdir` string meaning something other
  than "process working directory".** → *Mitigation:* the §2 predicate narrows to
  optional, unconstrained strings; the explicit-value-wins guard lets the model
  override per call; the deny-list alternative is re-openable if a real case
  appears.

- **Plugin tool IDs might be namespaced by opencode**, making the §6 self-guard a
  no-op. → *Mitigation:* not load-bearing — none of the four tools declares a
  `workdir` parameter, and the cache is fail-closed. The guard is defence in
  depth, so a no-op is a non-event.

- **`output.parameters` shape variance across tool authors.** → *Mitigation:*
  §1's justification plus optional chaining on every access; unrecognized shapes
  fall through to "not eligible", i.e. today's behaviour.

- **Annotation text lengthens every eligible tool's schema.** Small per-turn token
  cost, multiplied by the number of eligible tools. → *Mitigation:* accepted; the
  set of eligible tools is tiny, and the sentinel in §4 prevents it compounding.

**Rollout.** Behaviour-only change confined to `src/index.js` plus tests and
README. No new dependencies, no persisted data, no migration step. Rollback is a
plain revert; reverting restores `bash`-only injection with no residue, since the
cache is in-memory and the annotation is regenerated per turn.

## Component Breakdown

| Component | Kind of work | Done when |
| --- | --- | --- |
| Capability registry + eligibility predicate + self-tool set | Application code (`src/index.js`, module scope) | A tool with an optional unconstrained string `workdir` is recorded `true`; enum-constrained, non-string, required, and plugin-own tools record `false`/absent |
| `tool.definition` generalization (annotation + sentinel) | Application code | Annotation appended once per definition object for any eligible tool, tool-agnostic in wording, never duplicated on repeat firing |
| `tool.execute.before` generalization (args guard, env branch, workdir branch) | Application code | Any cached-eligible tool receives `state.cwd` when the call omits `workdir`; explicit values survive; env prefix still applies to `bash` only; a missing `output.args` is a no-op |
| Prompt/description de-bashing | Application code (string constants) | System-prompt section and the three `use_*` descriptions describe workdir injection generically; the env sentence stays `bash`-scoped |
| Spec delta per §9 | Spec authoring (engineer) | `openspec validate generalize-workdir-injection --strict` passes with workdir and env as separate requirements |
| `test/workdir-injection.test.js` | Test code | Covers: eligible non-`bash` tool injected; enum/non-string/required rejected; plugin-own tools rejected; explicit `workdir` preserved; repeat `tool.definition` does not duplicate; missing `output.args` no-op; `bash` env prefix unchanged |
| `README.md` feature description | Documentation | Describes generic workdir-parameter injection rather than `bash`-only |
