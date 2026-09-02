## Why

`use_direnv` currently injects loaded environment variables into `bash` tool
calls by prepending an `export K=V && ...` string to the command, built via
`buildEnvExports`/`shellQuote`. This clutters the model's context (every
`bash` call transcript shows the export prefix) and requires bespoke
shell-quoting logic that is a potential source of escaping bugs.

opencode ships a native `shell.env` plugin hook — `(input: { cwd, sessionID,
callID }, output: { env: Record<string,string> }) => Promise<void>` — that is
invoked by opencode itself immediately before spawning any shell child
process for a session, and the returned `env` is merged directly into the
real process environment (`{ ...process.env, ...extra.env }`). This is the
intended, already-documented mechanism for exactly this use case (confirmed
by reading the currently-shipping `packages/opencode/src/tool/shell.ts` and
`packages/opencode/src/session/prompt.ts` in the opencode source, and
independently documented in the `opencode-plugin-dev` skill). Switching to it
removes the visible command clutter and the quoting logic entirely, at no
cost to functionality, and gains a real invariant: the plugin will no longer
modify the agent's command string at all (today it is the only place that
does).

## What Changes

- Add a `'shell.env'` hook to the plugin that populates `output.env` from the
  session's active `state.env` whenever `input.sessionID` resolves to a known
  session. This fires for the `bash` tool **and** for shell parts spawned
  from the prompt path (`session/prompt.ts` also triggers this hook) — a
  slightly wider surface than today's `bash`-only prefix, which is desirable
  since both are real shell executions for the session. Interactive pty
  terminals trigger this hook without a `sessionID` and so continue to
  receive no injected env, unchanged from today.
- The hook body is wrapped in try/catch and never throws or rejects —
  `plugin.trigger` invokes hooks via `Effect.promise`, which treats a
  rejection as an unrecoverable defect rather than a recoverable error, so a
  bug in this hook must degrade to "no env injected" rather than aborting the
  shell spawn.
- Keep an env-var-name filter, re-justified: not shell-injection safety
  (real env assignment has no parsing step) but POSIX `environ`
  well-formedness — reject keys that are empty or contain `=` or a NUL byte.
  Same identifier-shaped filter as before (`/^[A-Za-z_][A-Za-z0-9_]*$/`).
- Exclude `PWD`, `OLDPWD`, and any `DIRENV_*` key from the injected env.
  Injecting a stale `PWD` would make `$PWD` disagree with the tool's actual
  cwd (set independently by the workdir-injection layer), and leaked
  `DIRENV_*` bookkeeping vars can confuse a direnv-hooked child shell into
  thinking the environment is already applied or stale.
- Remove the `export K=V && ...` command-prefixing logic from
  `tool.execute.before` (the `bash`-specific branch that called
  `buildEnvExports`).
- Remove the now-dead `buildEnvExports` and `shellQuote` helper functions.
- Update every model-visible and human-visible description of the mechanism
  now that it is no longer a command prefix: `experimental.chat.system.transform`
  wording, the `use_cwd`/`use_clear` tool descriptions, the `tool.execute.before`
  JSDoc, and `README.md` (5 locations, not the 3 originally estimated).

No change to `use_cwd`, `use_worktree`, session state shape (`state.env`
itself), or any other hook.

**Explicitly deferred (not in this change):** a diagnostic tripwire that
would detect the case where `shell.env` silently never fires for a session
that has active env (e.g. a future opencode version regresses the hook —
see Compatibility below). Tracking this via `tool.execute.before`/`
tool.execute.after` callID pairing is a bounded, well-understood addition
in the same shape as `add-workdir-injection-diagnostics`, but it is
independent of the mechanism swap this change makes and is left as a
follow-up so this change stays scoped to one thing.

## Capabilities

### Modified Capabilities

- `workdir-injection`: the "Bash Environment Injection" requirement is
  renamed "Shell Environment Injection" and rewritten from describing an
  `export K=V && ...` command-prefix mechanism applied only to the `bash`
  tool, to describing native environment injection via the `shell.env`
  plugin hook for any session-scoped shell invocation.

## Impact

- **Affected code**: `src/index.js` (new `shell.env` hook, removal of the
  `bash`-specific branch in `tool.execute.before`, removal of
  `buildEnvExports`/`shellQuote`, updated wording in
  `experimental.chat.system.transform` and the `use_cwd`/`use_clear` tool
  descriptions and `tool.execute.before` JSDoc), `test/workdir-injection.test.js`
  (the "Bash Environment Injection" test block is rewritten against the new
  hook, not edited in place), `README.md` (env-injection documentation, 5
  locations).
- **Affected APIs**: none — this is an internal plugin implementation detail;
  no tool signature changes.
- **Dependencies**: none added or removed.
- **Compatibility**: the `shell.env` hook is present and wired in the
  currently-shipping `opencode` CLI package (verified against source; the
  installed CLI is `1.18.25`). It is explicitly **not yet wired** in
  opencode's in-progress V2 core rewrite (`packages/core/src/tool/bash.ts`
  carries a `// TODO: Add plugin shell.env environment augmentation once V2
  plugin hooks exist.` comment, and `packages/core/test/tool-bash.test.ts`
  asserts that TODO string exists as its own tripwire). A future opencode
  major version could regress this silently if/when V2 becomes the shipping
  implementation — the failure mode is silent (a downstream "command not
  found" or wrong-tool-version symptom with nothing pointing at the plugin),
  and this change trades today's version-independent string-manipulation
  mechanism for a version-coupled one. Two heavier mitigations were
  considered and rejected: always running both mechanisms (reintroduces the
  clutter this change exists to remove) and falling back to prefixing only
  after observing the hook never fired (leaves the first `bash` call of every
  session without env — worse than the risk it mitigates). This is accepted
  as a known risk, with a diagnostic tripwire deferred as a documented
  follow-up (see What Changes) rather than solved in this change.
