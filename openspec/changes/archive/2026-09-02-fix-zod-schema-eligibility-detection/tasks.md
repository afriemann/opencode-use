## 1. JSON Schema path (primary)

- [x] 1.1 Extract the existing JSON-Schema eligibility rules into a shared helper; verify `it("Tool's workdir parameter is eligible via its JSON Schema representation")` passes using a real `z.toJSONSchema(z.object({...}), {io:'input'})` fixture
- [x] 1.2 Point the primary detection path at `output.jsonSchema` first

## 2. Zod raw-schema path (fallback for older hosts)

- [x] 2.1 Implement duck-typed Zod detection (`_zod.def.type`, no `zod` import) recognizing `optional`/`default`/`prefault` wrappers over an inner `string`; verify `it("Tool's workdir parameter is eligible via a raw Zod schema representation")` passes using a real `z.object({...})` fixture

## 3. Legacy `parameters`-as-JSON-Schema path

- [x] 3.1 Reuse the shared JSON-Schema helper against `output.parameters` as the third, lowest-priority path

## 4. Ineligibility, annotation, and regression coverage

- [x] 4.1 Verify `it("Tool's workdir parameter is enum-constrained, non-string, or required")` still passes across all three sources
- [x] 4.2 Verify `it('Tool has no workdir parameter, or was never observed by tool.definition')` still passes
- [x] 4.3 Update the `tool.definition` annotation-mutation logic to write back to whichever source matched (in-place for JSON Schema, reassignment via `.describe()` for Zod); verify `it("An eligible tool's schema is requested")` and `it('The same definition object is annotated twice')` pass for BOTH a JSON-Schema fixture and a real-Zod fixture
- [x] 4.4 Rewrite all non-bash test fixtures in `test/workdir-injection.test.js` to use real `z.toJSONSchema(z.object(args), {io:'input'})` output or real `z.object({...})` instances instead of plain JSON-literal mocks
- [x] 4.5 Add the matched-source detail to the capability diagnostic log line; verify existing diagnostic tests still pass and the source is present in the log message

## 5. Full verification

- [x] 5.1 Run `npm test` and confirm all tests pass with no regressions
- [x] 5.2 Run `openspec validate fix-zod-schema-eligibility-detection --strict` and confirm it passes
- [x] 5.3 `package.json` gains `zod` as a **devDependency only** (for test fixtures built from real `z.object()`/`z.toJSONSchema()` output — see amendment below); confirm no runtime `import`/`require` of `zod` in `src/index.js`

## Amendment

Tasks 5.3 and design.md D3/Component Breakdown originally stated
`package.json` would be unchanged. During implementation, test fixtures were
rewritten (per task 4.4) to use real `z.object()`/`z.toJSONSchema()` output
instead of JSON-literal mocks — exactly what the design flagged as the root
cause of the original bug surviving undetected. This requires `zod` to be
resolvable from the test file, added as a **devDependency**, with a symlink
matching the existing `@opencode-ai/plugin` peer-dependency pattern
(documented in `README.md`). This does not conflict with D3, whose concern
was specifically a **runtime** dependency reintroducing duplicate-install and
version-skew risk for `src/index.js` (which still has zero `zod` import).
