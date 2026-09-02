## REMOVED Requirements

### Requirement: Bash Environment Injection

**Reason**: Replaced by native environment injection via opencode's
`shell.env` plugin hook — see the new "Shell Environment Injection"
requirement. The `export K=V && ...` command-prefix mechanism this
requirement described is deleted entirely: the plugin no longer modifies
the agent's `command` argument for any reason.

**Migration**: No user-facing migration is needed — `use_direnv` behaves
identically from the model's perspective (same tool, same return message).
Any code or documentation that assumed environment variables arrive as a
visible `export K=V && ...` prefix on `bash` commands must be updated to
expect them in the real shell process environment instead.

## ADDED Requirements

### Requirement: Shell Environment Injection

The plugin SHALL register a `shell.env` hook that populates `output.env`
with the session's active environment (`state.env`) for every shell
invocation opencode triggers with a known `sessionID`. This mechanism SHALL
NOT modify the `command` argument of any tool call, under any
circumstance.

Only environment variable keys that are POSIX-portable identifiers
(matching `[A-Za-z_][A-Za-z0-9_]*`) SHALL be injected; other keys are
silently excluded. The keys `PWD` and `OLDPWD`, and any key starting with
`DIRENV_`, SHALL also be excluded from injection regardless of whether
they are POSIX-portable, since they are owned by the shell itself or by
direnv's own bookkeeping and would otherwise conflict with the
independently-set working directory or confuse a direnv-hooked child
shell. Key matching SHALL be exact-case.

The hook SHALL NOT throw or reject under any internal fault; any error
SHALL be caught and logged, leaving `output.env` unmodified by the failed
operation.

#### Scenario: Session has active environment variables

- **WHEN** the `shell.env` hook fires with the `sessionID` of a session where `use_direnv` previously loaded `FOO=bar` and `BAZ=qux`
- **THEN** `output.env` contains exactly `FOO: 'bar'` and `BAZ: 'qux'`

#### Scenario: Command string is never modified

- **WHEN** a `bash` tool call is made for a session with active environment variables
- **THEN** the call's `command` argument is unchanged from what the caller supplied

#### Scenario: Invocation carries no session ID

- **WHEN** the `shell.env` hook fires with `sessionID` undefined
- **THEN** `output.env` is not modified

#### Scenario: Invocation carries an unknown session ID

- **WHEN** the `shell.env` hook fires with a `sessionID` that no tool has ever executed under
- **THEN** `output.env` is not modified

#### Scenario: Malformed variable names are excluded

- **WHEN** the `shell.env` hook fires for a session whose active environment contains both a well-formed key and keys that are not POSIX-portable identifiers (e.g. starting with a digit, containing a space, containing a hyphen, or empty)
- **THEN** only the well-formed key appears in `output.env`

#### Scenario: Shell- and direnv-owned keys are excluded

- **WHEN** the `shell.env` hook fires for a session whose active environment contains `PWD`, `OLDPWD`, and a `DIRENV_`-prefixed key alongside an ordinary key
- **THEN** `output.env` contains the ordinary key only, and not `PWD`, `OLDPWD`, or the `DIRENV_`-prefixed key

#### Scenario: Session has an empty environment

- **WHEN** the `shell.env` hook fires for a session where `use_direnv` loaded no variables
- **THEN** `output.env` is not modified and the hook resolves normally

#### Scenario: An internal fault never propagates

- **WHEN** the `shell.env` hook encounters an internal error while applying a session's active environment
- **THEN** the hook resolves without throwing or rejecting, and the error is logged
