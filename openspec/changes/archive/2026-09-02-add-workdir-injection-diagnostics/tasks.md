## 1. tool.definition capability logging

- [x] 1.1 Log a capability-recorded line only on first-seen or changed eligibility for a toolID; verify `it("A toolID's workdir-capability is recorded for the first time")` and `it("A toolID's recorded eligibility changes")` pass
- [x] 1.2 Verify no log call on an unchanged repeat firing: `it("A toolID's recorded eligibility is unchanged")` passes

## 2. tool.execute.before injection-decision logging

- [x] 2.1 Log when injection happens; verify `it('Injection happens')` passes
- [x] 2.2 Log when skipped due to an explicit workdir already present; verify `it('Injection is skipped because the call already has an explicit workdir')` passes
- [x] 2.3 Log when skipped due to the tool not being workdir-capable; verify `it('Injection is skipped because the tool is not recorded as workdir-capable')` passes
- [x] 2.4 Verify no log call when there is no active working directory: `it('No active working directory')` passes

## 3. Full verification

- [x] 3.1 Run `npm test` and confirm all tests pass with no regressions
- [x] 3.2 Run `openspec validate add-workdir-injection-diagnostics --strict` and confirm it passes
