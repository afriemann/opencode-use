## Design Skip Justification

This change skips a commissioned `architect` design per the `openspec` skill's
four skip criteria, all of which hold:

1. **Pure bug fix, no architectural dimension.** Restores bash's previously
   unconditional workdir injection; no new concept introduced.
2. **Single branch in one existing function.** Only `tool.execute.before`'s
   `eligibleForInjection` condition changes.
3. **No infrastructure or configuration changes.**
4. **No new dependencies.**

## Fix

```js
const eligibleForInjection = input.tool === 'bash' || workdirCapable.get(input.tool) === true
if (state.cwd && !output.args.workdir && eligibleForInjection) {
  output.args.workdir = state.cwd
}
```

`bash` is now unconditionally eligible for workdir injection, matching its
pre-`generalize-workdir-injection` behavior exactly. Every other tool still
requires a positive `workdirCapable` cache hit — the generalization to other
tools introduced by the prior change is unaffected.

## Non-Goal

Determining the exact real-world shape mismatch between bash's live schema
and the `isWorkdirEligible` predicate is out of scope here — the fix does
not depend on knowing it, since bash no longer routes through the predicate
for injection at all. If bash's schema-annotation (the `tool.definition`
descriptive hint) is also silently not applying due to the same shape
mismatch, that is a separate, lower-severity, non-functional issue not
addressed by this change.
