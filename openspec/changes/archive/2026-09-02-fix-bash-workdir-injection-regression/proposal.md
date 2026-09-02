## Why

The `generalize-workdir-injection` change (archived 2026-09-02) gated `bash`'s
workdir injection behind the same schema-eligibility cache used for every
other tool. This was a live regression: immediately after deployment, a user
confirmed via a real session (`use_worktree` → `bash pwd`/`git rev-parse`)
that `bash` calls silently stopped receiving the active working directory.
Root cause: `bash`'s real, live-converted tool schema does not reliably
match the `isWorkdirEligible` predicate's assumed shape (an unverified
assumption — see `design.md` decision #1 of the prior change, which reasoned
from architecture rather than empirical testing). `bash` must never depend
on schema-detection succeeding for its own workdir injection.

## What Changes

- `tool.execute.before`'s workdir-injection branch now treats `bash` as
  always eligible, independent of `workdirCapable`'s cached verdict for it.
  Every other tool still requires a positive `workdirCapable` cache hit.
- Corrects the `workdir-injection` spec's "Bash tool call" scenario, which
  incorrectly asserted bash is injected "exactly as for any other
  workdir-capable tool" — it is not; bash is now an explicit, permanent
  special case for the injection branch (as it always was for the env
  branch).

This is a pure bug fix with no architectural dimension: `design.md` is
skipped per the four skip criteria (single-branch change in one existing
function; no API/data-model/component-boundary change; no infrastructure or
config changes; no new dependencies).

## Capabilities

### Modified Capabilities

- `workdir-injection`: corrects the "Bash Tool call" injection scenario to
  reflect that bash is always eligible for workdir injection, regardless of
  schema-detection outcome.

## Impact

- `src/index.js`: `tool.execute.before` hook only.
- `test/workdir-injection.test.js`: new regression-guard test proving bash
  injects even when its schema is recorded as ineligible.
- No new dependencies. No changes to the `tool.definition`/annotation path
  or to any other tool.
