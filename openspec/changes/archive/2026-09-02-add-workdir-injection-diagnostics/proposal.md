## Why

Diagnosing the `fix-bash-workdir-injection-regression` incident (and an
ongoing, still-unresolved report that `openspec_cli`'s workdir injection
does not fire even after its `workdir` parameter was correctly migrated from
`cwd`) required guesswork and a temporary throwaway diagnostic, because the
plugin has no permanent, low-noise observability into its own two core
decisions: whether a tool was recorded as workdir-capable, and whether a
given call actually received workdir injection and why (or why not). This
change adds that logging permanently via the existing `log()` helper, so
future generalization issues are diagnosable from opencode's normal app log
without redeploying a special build.

## What Changes

- `tool.definition` logs, at `info` level, a `workdir-capability: <toolID> =>
  <eligible>` line — but only the first time a toolID is recorded, or when
  its recorded eligibility changes from a previous value. This avoids
  spamming the log on every LLM turn for tools whose capability is already
  known and unchanged.
- `tool.execute.before` logs, at `info` level, one line per call **only when
  the session has an active working directory** (`state.cwd` set — the only
  condition under which an injection decision is actually meaningful):
  - `workdir-injection: <tool> => <cwd>` when injection happens
  - `workdir-injection: <tool> skipped (explicit workdir already set)` when
    the call already supplied its own value
  - `workdir-injection: <tool> skipped (not recorded as workdir-capable;
    cached=<value>)` when the tool was not eligible
- No change to injection or annotation *behavior* — purely additive
  observability.

This is a pure observability addition using an existing logging primitive
(`log()`), with no new dependencies, no new architecture, and no behavior
change — `design.md` is skipped per the four skip criteria (see
`design.md` for the explicit skip justification, since this still needs a
short note to satisfy the artifact dependency graph).

## Capabilities

### Modified Capabilities

- `workdir-injection`: adds diagnostic logging requirements for the
  `tool.definition` capability-recording decision and the
  `tool.execute.before` injection decision.

## Impact

- `src/index.js`: `tool.definition` and `tool.execute.before` hooks only.
- `test/workdir-injection.test.js`: new tests asserting the log helper is
  invoked with the expected messages for each logged case, and NOT invoked
  when there is no active working directory (no-noise guarantee).
- No new dependencies.
