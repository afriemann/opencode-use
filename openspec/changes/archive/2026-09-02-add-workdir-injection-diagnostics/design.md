## Design Skip Justification

Skipped per the `openspec` skill's four criteria, all of which hold:

1. **No architectural dimension.** Uses the existing `log()` helper already
   used by every hook's error path; no new logging infrastructure.
2. **Two existing functions, additive only.** `tool.definition` and
   `tool.execute.before` each gain a few lines; no new functions, no changed
   control flow for injection/annotation itself.
3. **No infrastructure or configuration changes.**
4. **No new dependencies.**

## Noise-control decisions

- **`tool.definition`**: log only on first-seen or on a change in recorded
  eligibility for a toolID, not on every firing (which happens every LLM
  turn per callable tool). A `Map<toolID, boolean>` already exists
  (`workdirCapable`); comparing the previous value before `.set()` is
  sufficient — no new state needed.
- **`tool.execute.before`**: log only when `state.cwd` is truthy. Before any
  `use_cwd`/`use_worktree` call, there is nothing to decide, so gating on
  this condition means the log stays silent for the common case (no active
  session directory) and only speaks when there is a real decision to
  report.
