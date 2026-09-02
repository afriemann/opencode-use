## Context

See `proposal.md` — Why. This design covers only *how* the mechanism swap is
built. The proposal's approved decisions are inputs here, not re-litigated:
keep an identifier-shaped name filter (re-justified as POSIX `environ`
well-formedness), exclude `PWD`/`OLDPWD`/`DIRENV_*`, and defer the
silent-failure tripwire.

Constraints that shape the approach:

- **The hook has no tool identity.** `shell.env` is
  `(input: { cwd, sessionID, callID }, output: { env }) => Promise<void>`.
  There is no `tool` field, so the plugin cannot scope injection to `bash`
  even if it wanted to — the widening of surface is inherent to the
  mechanism, not a choice made here.
- **The hook must not reject.** `plugin.trigger` invokes hooks via
  `Effect.promise`, which treats a rejection as an unrecoverable *defect*
  rather than a recoverable error. A rejection aborts the shell spawn. The
  existing hooks already swallow their own errors; this one must too, and
  for a stricter reason.
- **Two layers, one session, two owners.** The workdir layer
  (`tool.execute.before`) independently sets the child process's cwd. The
  env layer must not contradict it — hence the `PWD`/`OLDPWD` exclusion.
  The hook receives `input.cwd`, and deliberately ignores it.
- **`state.env` is a faithful record.** `use_direnv`'s return message counts
  and names what direnv exported, and `experimental.chat.system.transform`
  reports that count. The proposal states session state shape is unchanged.
  Filtering therefore happens at injection time, not at capture time.
- **Nothing may be exported from `src/index.js` but `default`** (README
  §"must export nothing but `default`"). New helpers stay module-private.
- **Personal repo, single maintainer.** Prefer the smallest mechanism that
  works over configurable machinery.

## Goals / Non-Goals

**Goals**

- The session's active environment reaches every shell process opencode
  spawns for that session, via the native mechanism, with no visible
  artefact in the agent's transcript.
- A new, stronger invariant holds and is testable: **the plugin never
  modifies the agent's command string.** Today `tool.execute.before` is the
  only place that does; after this change nothing does.
- Injection is fail-open: any fault degrades to "no env injected", never to
  a failed shell spawn.

**Non-Goals**

- No silent-failure tripwire (deferred — see `proposal.md`).
- No change to `state.env`'s shape, to `use_direnv`'s capture logic, or to
  what `use_direnv` reports.
- No change to the workdir layer's behaviour, guards, or diagnostics.
- No configuration surface for which variables are injected.

## Decisions

### 1. Hook shape and guard order

**Decision.** Register `'shell.env'` in the returned hook object,
positioned directly after `'tool.execute.before'` so the two injection
layers read together. Body:

1. `try {`
2. `if (!input?.sessionID) return` — no session, nothing to inject.
3. `const state = sessions.get(input.sessionID); if (!state) return`
4. Build a local object from `state.env`, keeping only keys accepted by
   `isInjectableEnvKey` (§2).
5. `if (no keys survived) return` — no observable mutation.
6. `if (!output.env || typeof output.env !== 'object') output.env = {}`
7. `Object.assign(output.env, injectable)` — one atomic application.
8. *(optionally)* one diagnostic log line — see §5.
9. `} catch (err) { log('shell.env failed', err) }` — see §4.

**`input.sessionID` undefined vs unknown — one behaviour, two guards.**
Both must produce *no mutation of `output.env`*. Step 2 handles undefined;
step 3 handles unknown. Step 3 alone would technically cover both
(`Map.get(undefined)` yields `undefined`), but step 2 is kept deliberately:
`getState()` will happily create a session keyed literally `undefined` if
any tool ever executes without a `sessionID`, and such an entry must never
leak its env into a session-less interactive pty spawn. Step 2 costs one
line and closes that hole permanently.

**Mutate in place, do not reassign.** The caller holds the `output` object
and reads `output.env` after the hook resolves, so a reassignment would in
fact be observed — but `Object.assign` onto the existing object is the
safer of the two: it survives a caller that captured `output.env` by
reference before the hook ran, and it composes with any other plugin that
also populates `output.env`. Step 6 exists only as a defensive fallback for
a host that passes `output` without an `env` object; it is not the expected
path.

**Precedence is last-writer-wins, deliberately.** opencode merges
`{ ...process.env, ...extra.env }`, so injected keys beat the ambient
process environment — which is exactly what a direnv delta is supposed to
do, and matches what `export K=V && …` did. Within `output.env`, this
plugin overwrites any same-named key an earlier plugin set; with no other
plugin known to populate `output.env`, arbitration machinery would be
speculative (YAGNI).

**Rejected alternative — read `input.cwd` to re-derive `PWD`.** The hook is
told the cwd, so it *could* inject a correct `PWD` rather than excluding
it. Rejected: `PWD` is set by the shell itself on startup, so injecting it
adds a second writer for a value the shell already computes correctly, and
re-couples this layer to a value the workdir layer owns. Excluding it is
both simpler and strictly more correct.

### 2. Key filtering: one named predicate, three rules

**Decision.** A single module-private predicate, `isInjectableEnvKey(key)`,
placed at module scope where `buildEnvExports`/`shellQuote` are removed
from (§3), so the diff reads as a replacement. Three module-level
constants carry the rules so each is independently reviewable:

```js
/** POSIX portable environment-variable name (IEEE Std 1003.1, §8.1). */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Set independently by the shell / the workdir layer — never injected. */
const ENV_KEY_DENYLIST = new Set(['PWD', 'OLDPWD'])
/** direnv's own bookkeeping — confuses a direnv-hooked child shell. */
const ENV_KEY_DENY_PREFIX = 'DIRENV_'
```

The predicate returns `false` on the first failing rule and `true`
otherwise:

1. `!ENV_NAME_PATTERN.test(key)` → reject.
2. `ENV_KEY_DENYLIST.has(key)` → reject.
3. `key.startsWith(ENV_KEY_DENY_PREFIX)` → reject.

**Why one composed predicate rather than two filters.** The two rules have
different justifications but a single consumer and a single call site;
splitting them into `isWellFormedEnvName` + `isInjectableEnvKey` would add
an indirection whose only benefit is documentation — which the three named
constants already provide. One predicate, one place to look.

**Why the identifier-shaped regex, re-justified.** POSIX `environ` entries
are `name=value` strings; a name that is empty, contains `=`, or contains a
NUL byte is not representable. The regex is *stricter* than that minimum —
it is POSIX's **portable** character set for environment variable names.
That strictness is deliberate and free: direnv cannot produce a name
outside this set from a well-formed `.envrc`, and anything outside it is far
more likely to be a parse artefact than an intended variable. Note the
changed justification: this is **not** shell-injection defence. There is no
parsing step in a real `environ` assignment; the escaping concern that
motivated `shellQuote` is dissolved by the mechanism swap, not relocated.

**Exact-case matching, no case folding.** `PWD` and `pwd` are distinct
variables in POSIX; a case-insensitive denylist would silently drop a
legitimate `pwd` variable. Rules 2 and 3 are exact-case.

**Values are never inspected, never filtered, never logged.** Only keys are
examined. A value is passed through verbatim as `String`-typed data (already
normalised at capture in `use_direnv`).

**Rejected alternative — filter at capture time in `use_direnv`.** Storing
only injectable keys in `state.env` would make the hook a plain copy.
Rejected: it silently changes the count and names `use_direnv` reports back
to the model and that `experimental.chat.system.transform` displays, turning
a truthful "direnv exported N variables" into a lossy one; and it couples
`.envrc` capture to a consumer-side concern. *Accepted consequence:* the
reported count may exceed the number actually injected. This is correct —
the count describes what was **loaded**, not what is injected — and the
prompt wording (§6) is phrased to stay true either way.

### 3. Deletions

| Removed | Location | Note |
| --- | --- | --- |
| `shellQuote` | `src/index.js` ~242–244 | Sole caller is `buildEnvExports` |
| `buildEnvExports` | `src/index.js` ~246–254 | Sole caller is the branch below |
| The `if (input.tool === 'bash') { … }` env branch | inside `tool.execute.before`, ~779–784 | The hook's only remaining `bash` special-case for env |

Verified: after these three removals there are no remaining references to
either helper anywhere in the repo (`src/`, `test/`, `README.md`).

**What in `tool.execute.before` is explicitly *untouched*:** the
`if (!output.args) return` guard, the `sessions.get(input.sessionID)`
lookup and its `if (!state) return` guard, the `bash`-always-eligible
determination, the `state.cwd`-gated diagnostic logging, the
explicit-workdir-wins guard, and the surrounding try/catch. Both surviving
guards are still load-bearing for the workdir branch — removing the env
branch does not make either dead. The hook's net change is the deletion of
one `if` block; the workdir layer's observable behaviour is byte-identical.

### 4. Error containment

**Decision.** Wrap the entire body in `try/catch`, log via the existing
`log()` helper with the message `'shell.env failed'`, and never rethrow —
matching the convention every other hook in this file already follows
(`tool.definition failed`, `tool.execute.before failed`,
`chat.system.transform failed`). The catch is the last statement; nothing
after it can reject.

**Why a stricter obligation than the other hooks.** For the existing hooks
a rejection would break a tool call. Here, `Effect.promise` classifies a
rejection as a defect, so a bug in this hook takes down the shell spawn
itself. "Never throws" is therefore not defensive politeness — it is the
hook's contract.

**Why build-then-assign (§1 steps 4–7) rather than assigning key by key.**
A per-key loop that faults midway leaves `output.env` half-populated — a
partially-applied environment is a worse failure than none, and is the kind
of state that produces a confusing downstream symptom. Building a local
object first makes application atomic: either the whole filtered set lands
or nothing does. This also makes the fault-injection test in §7 (S8) mean
what it claims.

### 5. Diagnostics — recommended, but beyond the proposal's stated scope

**Decision (recommended, needs confirmation).** Emit exactly one log line
when the hook injects, and nothing otherwise:

```
shell-env: <n> var(s) injected for <sessionID>
```

**Options considered.**

- **(a) Silent.** Only the error path logs. Smallest diff; matches the
  proposal's literal text, which mentions only error logging.
- **(b) Log every invocation,** including no-session and empty-env cases.
  Rejected — fires on every interactive pty spawn for no decision.
- **(c) Log only when injecting** *(recommended)*. Mirrors the precedent set
  in `add-workdir-injection-diagnostics`: log only when there is a real
  decision to report. It is the same cadence the workdir layer already uses
  (one line per call with active `cwd`), so it adds no new noise class. It
  also makes the *deferred* tripwire manually answerable today — "did
  `shell.env` fire for this session?" becomes a log grep rather than a
  rebuild.

**Constraint, whichever option is chosen: never log a variable's value.**
Counts and (at most) names only. Names are already model-visible via
`use_direnv`'s return message; values are not, and must not become
log-visible.

This is the one element of this design the proposal does not name. It is
recommended, not assumed — see *Open Questions*. If declined, drop it: it
touches nothing else, and no spec scenario in §7 depends on it (the error
path in S8 asserts on the *error* log line, which exists in both options).

### 6. Wording updates — apply the predicate, not a fixed list

**Decision.** The audit criterion is: *no model-visible or human-visible
string may claim that the session environment arrives as a command prefix,
as `export …` statements, or as a modification of the command string.* The
engineer applies that predicate to the whole repo; the table below records
every location known to match at design time, and the semantic each must
land on.

| Location | Currently claims | Must become |
| --- | --- | --- |
| `experimental.chat.system.transform`, env line (~840–842) | env is "automatically prepended to every bash command as `export VAR=val`" | env is applied natively to the process environment of shell commands run for this session; no `export` statements appear anywhere |
| `experimental.chat.system.transform`, note line (~858) | context may show "a `workdir` value (and, for `bash`, `export …` statements)" | drop the `export` clause entirely — only `workdir` is ever added to a call |
| `tool.execute.before` JSDoc (~763–772) | describes "Layer 1 (env, `bash`-only)" and "Layer 2 (workdir)" | one layer only (workdir); env is no longer this hook's concern |
| `experimental.chat.system.transform` JSDoc (~818–820) | "`bash` also receives env injection" | env reaches shell processes via the separate `shell.env` hook |
| `use_clear` description (~615) | clearing env means vars "will no longer be prepended to bash commands" | clearing env means vars are no longer applied to shell commands run for this session |
| `README.md` §Features, `use_direnv` bullet (~10) | "all exported variables prepended to every bash command" | applied to the environment of every shell command run for the session |
| `README.md` §Features, Transparent injection bullet (~9) | "env (bash-only) and workdir … injected silently via `tool.execute.before`" | two distinct mechanisms: workdir via `tool.execute.before`, env via `shell.env` |
| `README.md` §`use_direnv` (~106) | "prepended to every bash command as `export K=V && ...`" | as above |
| `README.md` §How It Works, Env layer (~184) | `tool.execute.before` "prepends `export K=V && …`" | remove the env layer from this hook's description; add a sibling `### Hook: shell.env` subsection |
| `README.md` §How It Works, invariant (~187) | "The agent's command is never modified **beyond the env prefix**" | state the now-unqualified invariant: the plugin never modifies the agent's command string |

**Note a discrepancy with the proposal.** The proposal lists the `use_cwd`
description among the strings to update. At design time `use_cwd`'s
description makes no claim about the environment mechanism at all — it
describes workdir injection and the `.envrc` *detection* reminder, both of
which remain accurate. Under the predicate above it needs no change. The
predicate governs; see *Open Questions*.

The README `§How It Works` entry for the new hook should state the one
functional consequence a reader needs: the environment now reaches shell
parts spawned from the prompt path as well as `bash` tool calls, and
interactive pty terminals (which carry no `sessionID`) continue to receive
nothing — unchanged from today.

### 7. Test strategy

**Decision.** The `describe('Bash Environment Injection')` block in
`test/workdir-injection.test.js` is **replaced**, not edited, by
`describe('Shell Environment Injection')`. Its existing two tests both
assert the removed mechanism and have no successor in place: the
active-env test is replaced by S1, and the "A non-bash tool call is made"
test is subsumed by S2 (`bash` is the strongest case — if the command is
untouched for `bash`, it is untouched for everything).

Existing harness is sufficient: `makePlugin` / `makePluginWithLogs`,
`fakeDirenvShell(json)` to seed `state.env` through the real `use_direnv`
tool, `uniqueSessionId()`, `makeTempDir`. No new helper is needed. Every
scenario invokes the hook directly as
`plugin['shell.env']({ sessionID, cwd, callID }, output)`.

Each scenario below is written to become a literal GIVEN/WHEN/THEN in the
spec delta and a TDD red-step test.

| # | Scenario | Observable expectation |
| --- | --- | --- |
| S1 | Session has active environment variables | GIVEN a session where `use_direnv` loaded `FOO=bar`, `BAZ=qux`; WHEN `shell.env` fires with that `sessionID`; THEN `output.env` contains exactly those keys with those values |
| S2 | Command string is never modified | GIVEN a session with active env; WHEN `tool.execute.before` fires for a `bash` call with `command: 'echo hi'`; THEN `output.args.command` is still exactly `'echo hi'` — **the regression guard for the deleted branch and the invariant this change buys** |
| S3 | Invocation carries no session ID | GIVEN a session with active env exists; WHEN `shell.env` fires with `sessionID: undefined`; THEN `output.env` is unchanged (still empty) |
| S4 | Invocation carries an unknown session ID | GIVEN a `sessionID` no tool ever ran under; WHEN `shell.env` fires; THEN `output.env` is unchanged (still empty) |
| S5 | Malformed variable names are excluded | GIVEN `use_direnv` loaded a payload containing a well-formed key alongside names that are not POSIX-portable (e.g. `1BAD`, `WITH SPACE`, `HAS-DASH`, `''`); WHEN `shell.env` fires; THEN only the well-formed key appears in `output.env` |
| S6 | Shell- and direnv-owned keys are excluded | GIVEN a payload containing `PWD`, `OLDPWD`, `DIRENV_DIR`, `DIRENV_WATCHES` alongside `FOO`; WHEN `shell.env` fires; THEN `output.env` contains `FOO` only. *Optional additional assertion pinning §2's exact-case rule: a lowercase `pwd` in the same payload IS injected.* |
| S7 | Session has an empty environment | GIVEN a session where `use_direnv` loaded nothing (`{}`); WHEN `shell.env` fires; THEN `output.env` is unchanged and the hook resolves |
| S8 | An internal fault never propagates | GIVEN a session with non-empty active env; WHEN `shell.env` fires with an `output` whose `env` is `Object.freeze({})`; THEN the call resolves (`assert.doesNotReject`) and a log line containing `shell.env failed` was emitted |

**S8's fault-injection mechanism, precisely.** ESM modules are strict mode,
so `Object.assign` onto a frozen target throws `TypeError` — *provided
there is at least one property to assign*. S8 must therefore seed a
non-empty `state.env`, or it passes vacuously by taking the §1 step-5 early
return. This is why §4 chose build-then-assign: the single assignment is
the one place a realistic fault can be injected from outside the plugin.

**Not tested, deliberately.** That the hook fires for prompt-path shell
parts as well as `bash` tool calls is a property of *who calls the hook* —
the hook has no tool identity to assert on (§Context), so there is nothing
to test at the plugin boundary. It is documented (§6), not asserted.

### 8. Spec delta shape

`Bash Environment Injection` is renamed and its mechanism rewritten.
OpenSpec matches `MODIFIED` deltas by exact existing header text, so a
rename is expressed as removal plus addition (same shape as the archived
`generalize-workdir-injection` design §9).

| Existing requirement | Fate | Delta operation |
| --- | --- | --- |
| `Bash Environment Injection` | renamed + rewritten | `REMOVED` (reason: mechanism replaced and renamed), plus `ADDED` `Shell Environment Injection` carrying S1–S8 |
| `Tool Workdir Injection` | unchanged | none — **except** if S2 is filed here rather than under the new requirement; see below |
| `System Prompt Session Context` | unchanged | none — its text names the active environment but asserts no mechanism, so it stays true |
| `Workdir Injection Diagnostics` | unchanged | none |

**Placement of S2.** It asserts a `tool.execute.before` behaviour (command
untouched) but exists to guard *this* change's invariant. Recommend filing
it under `Shell Environment Injection` so the requirement that removes the
prefix also owns the proof it is gone; the alternative — a `MODIFIED`
`Tool Workdir Injection` gaining one scenario — splits the story across two
requirements for no gain.

If §5's diagnostic line is accepted, it adds one scenario to
`Shell Environment Injection` (*GIVEN a session with active env; WHEN the
hook injects; THEN a line reporting the count is logged*), consistent with
how `Workdir Injection Diagnostics` states its logging conditions. If
declined, no scenario is added.

Run `openspec validate use-shell-env-hook --strict` after authoring. Spec
authoring is the engineer's step, not this document's.

## Risks / Trade-offs

- **Version coupling to opencode's `shell.env` wiring** — analysed and
  accepted in `proposal.md` §Compatibility, with the tripwire deferred. Not
  re-opened here. The one thing this design adds: §5's log line makes the
  failure mode manually observable today without building the tripwire.
- **Widened injection surface.** Prompt-path shell parts now receive the
  session env where previously only `bash` tool calls did. Judged desirable
  in the proposal (both are real shell executions for the session), and it
  is not optional — the hook has no tool identity to filter on.
- **Reported-vs-injected count divergence.** `use_direnv` and the system
  prompt report what direnv exported; the hook injects a filtered subset.
  → *Mitigation:* §6's wording keeps both statements true; the divergence is
  only ever "loaded ≥ injected", and only for keys that could not have
  worked anyway (malformed) or are actively harmful (`PWD`, `DIRENV_*`).
- **A `.envrc` that genuinely depends on `DIRENV_*` propagating to a child**
  would now behave differently. → *Mitigation:* accepted per the approved
  decision; the failure is toward a child shell re-evaluating the `.envrc`
  rather than skipping it, which is the safe direction.
- **Silent partial coverage if a future host stops passing `sessionID`.**
  The hook would degrade to injecting nothing, silently. → Same failure
  class as the version-coupling risk above, and covered by the same
  deferred tripwire.

**Rollout.** Behaviour-only change confined to `src/index.js`, its test
file, and `README.md`. No new dependencies, no persisted data, no migration.
Rollback is a plain revert — the removed helpers and the removed branch are
pure functions and one `if` block, with no state to restore.

## Component Breakdown

| Component | Kind of work | Done when |
| --- | --- | --- |
| `isInjectableEnvKey` + its three rule constants | Application code (`src/index.js`, module scope, not exported) | A well-formed name passes; `1BAD`/`WITH SPACE`/`HAS-DASH`/empty are rejected; `PWD`, `OLDPWD`, and any `DIRENV_*` are rejected; lowercase `pwd` passes |
| `'shell.env'` hook | Application code (`src/index.js`, returned hook object) | Populates `output.env` with the filtered active env for a known session; mutates nothing for an absent, unknown, or empty-env session; applies the filtered set atomically |
| Error containment | Application code (same hook) | An induced internal fault resolves the promise, logs `shell.env failed`, and leaves `output.env` untouched |
| Env-branch removal from `tool.execute.before` | Application code (deletion) | The `bash` env branch is gone; both surviving guards, the workdir branch, and its diagnostics are byte-identical in behaviour; `output.args.command` is never written |
| `buildEnvExports` / `shellQuote` removal | Application code (deletion) | Neither identifier appears anywhere in `src/`, `test/`, or `README.md` |
| Wording audit | Application code (string constants) + Documentation (`README.md`) | No model- or human-visible string claims a command-prefix / `export` mechanism; README gains a `### Hook: shell.env` subsection and states the unqualified never-modifies-the-command invariant |
| Diagnostic log line (§5, pending confirmation) | Application code | One line per injecting invocation, reporting count and session only — never a variable's value |
| Spec delta per §8 | Spec authoring (engineer) | `openspec validate use-shell-env-hook --strict` passes with `Shell Environment Injection` carrying S1–S8 |
| `test/workdir-injection.test.js` | Test code | The `Bash Environment Injection` block is replaced by `Shell Environment Injection` covering S1–S8; no test references the removed helpers or the prefix string |

## Open Questions

1. **§5 diagnostic log line.** Recommended but outside the proposal's
   stated scope, which mentions only error logging. Confirm accept or
   decline before implementing — it is self-contained either way, and
   determines whether §8 files one extra spec scenario.
2. **§6 `use_cwd` description.** The proposal lists it among the strings to
   update; at design time it carries no environment-mechanism claim and
   appears to need no change. The engineer should apply the §6 predicate and
   either find a match this design missed, or record that the proposal's
   list was a superset.
