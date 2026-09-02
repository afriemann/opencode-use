## 1. Enrich and verify

- [x] 1.1 Add the raw `workdir` prop and `required` array to the ineligible-verdict log line; verify `it('A toolID is recorded as ineligible')` passes
- [x] 1.2 Verify the eligible-verdict log line is unchanged: existing "first time"/"changes"/"unchanged" tests still pass
- [x] 1.3 Run `npm test` and confirm all tests pass with no regressions
- [x] 1.4 Run `openspec validate enrich-workdir-capability-diagnostics --strict` and confirm it passes
