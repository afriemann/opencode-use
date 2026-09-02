## ADDED Requirements

### Requirement: Workdir Injection Diagnostics

The plugin SHALL log, via the existing app-log helper, its workdir-capability
recording decisions and its per-call injection decisions, so that
generalization failures are diagnosable from opencode's normal app log
without a special build. The `tool.definition` hook SHALL log a
capability-recorded line only the first time a toolID is recorded, or when
its recorded eligibility changes from a previously recorded value — not on
every firing. The `tool.execute.before` hook SHALL log an injection-decision
line only when the session has an active working directory (`state.cwd`
truthy) — the only condition under which an injection decision is
meaningful — and SHALL NOT log anything when there is no active working
directory.

#### Scenario: A toolID's workdir-capability is recorded for the first time

- GIVEN a toolID that has never been recorded in the workdir-capability cache
- WHEN the `tool.definition` hook fires for that toolID
- THEN the plugin logs a line reporting the toolID and its recorded eligibility

#### Scenario: A toolID's recorded eligibility changes

- GIVEN a toolID previously recorded with one eligibility value
- WHEN the `tool.definition` hook fires again for that toolID with a schema that yields a different eligibility value
- THEN the plugin logs a line reporting the toolID and its new eligibility

#### Scenario: A toolID's recorded eligibility is unchanged

- GIVEN a toolID previously recorded with a given eligibility value
- WHEN the `tool.definition` hook fires again for that toolID with a schema that yields the same eligibility value
- THEN the plugin does not log a capability-recorded line for that firing

#### Scenario: Injection happens

- GIVEN a session with an active working directory and a call to an eligible tool that omits `workdir`
- WHEN the `tool.execute.before` hook injects the active working directory into the call
- THEN the plugin logs a line reporting the tool and the injected value

#### Scenario: Injection is skipped because the call already has an explicit workdir

- GIVEN a session with an active working directory and a call that already specifies `workdir`
- WHEN the `tool.execute.before` hook fires for that call
- THEN the plugin logs a line reporting that injection was skipped because an explicit value was already present

#### Scenario: Injection is skipped because the tool is not recorded as workdir-capable

- GIVEN a session with an active working directory and a call to a tool other than `bash` that is not recorded as workdir-capable
- WHEN the `tool.execute.before` hook fires for that call
- THEN the plugin logs a line reporting that injection was skipped because the tool was not recorded as workdir-capable

#### Scenario: No active working directory

- GIVEN a session with no active working directory
- WHEN the `tool.execute.before` hook fires for any call
- THEN the plugin logs no injection-decision line
