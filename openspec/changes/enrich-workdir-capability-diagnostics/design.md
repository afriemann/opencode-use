## Design Skip Justification

Skipped per the four criteria: pure additive logging enrichment in one
existing function (`tool.definition`), no architecture change, no
infrastructure/config change, no new dependencies.

## Detail

```js
if (previouslyRecorded === undefined || previouslyRecorded !== eligible) {
  const detail = eligible
    ? ''
    : ` (workdir prop: ${JSON.stringify(output.parameters?.properties?.workdir)}, required: ${JSON.stringify(output.parameters?.required)})`
  log(`workdir-capability: ${toolID} => ${eligible}${detail}`)
}
```

`JSON.stringify(undefined)` returns `undefined` (not a string), which
`${}` coerces to the literal text `"undefined"` — acceptable and clear in a
log line (distinguishes "no `workdir` property at all" from a present but
disqualified one).
