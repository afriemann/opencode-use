## 1. Reproduce and fix

- [x] 1.1 Write a failing regression test proving bash's workdir injection breaks when `tool.definition` records it as ineligible or never observes it; confirm it fails against the archived code
- [x] 1.2 Fix `tool.execute.before` so `bash` is always eligible for workdir injection independent of the `workdirCapable` cache; confirm the regression test passes

## 2. Correct specs and verify

- [x] 2.1 Correct the `workdir-injection` spec's "Bash tool call" scenario and add the new regression-guard scenario
- [x] 2.2 Run the full test suite (`npm test`) and confirm all tests pass with no regressions
- [x] 2.3 Run `openspec validate fix-bash-workdir-injection-regression --strict` and confirm it passes
