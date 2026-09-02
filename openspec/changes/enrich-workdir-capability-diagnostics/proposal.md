## Why

Live diagnostic logs from `add-workdir-injection-diagnostics` confirmed
`tool.definition` correctly fires for `openspec_cli` with the right toolID
(ruling out a tool-ID mismatch between hooks), but `isWorkdirEligible`
records it as `false`. The current log line reports only the boolean
verdict, not which check disqualified it or what the real `workdir` property
looked like — leaving no way to determine the actual disqualifying reason
without another debug round-trip. Enrich the ineligible-verdict log line
with the raw `workdir` property and `required` array so a disqualifying
schema shape is diagnosable directly from the log.

## What Changes

- When `tool.definition` records a toolID as NOT workdir-capable (first-seen
  or changed to `false`), the log line additionally includes the raw
  `workdir` property (if any) and the schema's `required` array, so the
  exact disqualifying condition (missing property, wrong type, `enum`
  present, or listed as `required`) is visible directly in the log.
- No change when eligible is `true` — the existing concise line is
  sufficient there.

Pure additive observability enrichment using the existing `log()` helper;
`design.md` is skipped per the four skip criteria (single function, no
architecture, no infra/config changes, no new dependencies).

## Capabilities

### Modified Capabilities

- `workdir-injection`: the "Workdir Injection Diagnostics" requirement's
  capability-recording log line gains the raw disqualifying detail when the
  verdict is `false`.

## Impact

- `src/index.js`: `tool.definition` hook only.
- `test/workdir-injection.test.js`: updated/added assertions for the
  enriched ineligible-verdict log line.
