## Why

Live diagnostic logs (from `add-workdir-injection-diagnostics` and
`enrich-workdir-capability-diagnostics`) revealed that `isWorkdirEligible`'s
JSON-Schema-shaped access (`output.parameters?.properties?.workdir`) returns
`undefined` for every plugin-authored custom tool, including `openspec_cli`
which does declare an optional `workdir` string parameter. The initial
hypothesis (that `output.parameters` is a raw Zod object exposing `.shape`)
was tested against `@opencode-ai/plugin`'s source and empirically with real
`zod@4.1.8` objects, then corrected by `architect` reading opencode's own
registry source (`packages/opencode/src/tool/registry.ts`): on current
opencode, `output.parameters` is an **opaque Effect Schema** for
plugin-authored tools, not a Zod object — so a Zod-`.shape`-based fix would
not have resolved the incident either. The hook payload already carries a
third field, `output.jsonSchema`, which **is** the real, LLM-facing JSON
Schema (built via `z.toJSONSchema(z.object(args), {io:"input"})`), and the
**existing, unmodified** predicate applied to `output.jsonSchema` correctly
returns `true` for an `openspec_cli`-shaped schema. The predicate logic was
never wrong — it was reading the wrong field. A comment in opencode's
registry source also records that hosts predating `1.14.49` genuinely
exposed `parameters` as a `ZodObject`, and this plugin's own
`peerDependencies` range (`>=1.15.0`) is open-ended and spans both host
generations, so a single-path fix is not safe across the declared support
range.

## What Changes

- `isWorkdirEligible` becomes a three-path, ordered detection:
  1. `output.jsonSchema?.properties?.workdir` — current opencode, and the
     natural shape for MCP-registered tools (JSON Schema over the wire) —
     using the existing (correct, unchanged) JSON-Schema rules: `type ===
     'string'`, no `enum`, not in `required`.
  2. `output.parameters?.shape?.workdir` — hosts where `parameters` is a raw
     Zod object (pre-`1.14.49`-era registry code). Classified by **duck
     typing** on `_zod.def.type` (no `zod` import; matches how opencode
     itself detects Zod values) rather than `instanceof`, so it correctly
     recognizes `.optional()`/`.default()`/`.prefault()` wrappers over an
     inner `string` type.
  3. `output.parameters` itself treated as JSON Schema (any other source
     that presents `parameters` this way) — reuses the same helper as path 1.
  Every path failing is fail-closed (no injection), matching the existing
  invariant.
- `tool.definition`'s annotation-mutation logic writes back to whichever
  source matched: in-place `.description =` for a JSON-Schema property
  (paths 1/3 — verified safe, no getter/throw), or `parameters.shape.workdir
  = zodProp.describe(next)` reassignment for the Zod path (path 2 — Zod
  schemas are immutable; in-place `.description =` on a Zod schema throws
  under ESM strict mode and must never be used).
- **No new dependency.** zod v4's `instanceof` is structural (`Symbol.hasInstance`
  checks `_zod.traits`) and survives duplicate module installs, and path 2's
  duck-typing needs no import at all — the earlier proposal's rationale for
  adding `zod` as an explicit dependency does not hold.
- The capability diagnostic log line additionally records which schema
  source matched (`jsonSchema` / `parameters.shape` / `parameters`), so a
  future host-generation mismatch is immediately visible without another
  debug round-trip.

## Capabilities

### Modified Capabilities

- `workdir-injection`: the eligibility-detection mechanism becomes
  source-agnostic across the three schema shapes a tool's definition may
  present to the hook, consulted in the order above; the `enum` exclusion
  remains required for JSON-Schema sources. The annotation requirement
  gains: the annotation is written back to whichever source matched.

## Impact

- `src/index.js`: `isWorkdirEligible` (refactored into a shared JSON-Schema
  helper plus a Zod duck-typing branch), and the `tool.definition` hook's
  annotation-mutation logic and diagnostic log line.
- `test/workdir-injection.test.js`: non-bash test fixtures are rewritten to
  use real `z.toJSONSchema(z.object(args), {io:'input'})` output (path 1)
  and real `z.object({...})` instances (path 2) instead of plain
  JSON-literal mocks — the JSON-literal mocks are exactly how this bug
  survived undetected, since they tested a shape that never occurs in
  production for these tools.
- `zod` is added as a **devDependency only** (test fixtures now use real
  `z.object()`/`z.toJSONSchema()` output to mirror production schema
  shapes — see the tasks.md amendment). `src/index.js` itself has no `zod`
  import; the runtime detection uses duck-typing on path 2 specifically to
  avoid that dependency.
