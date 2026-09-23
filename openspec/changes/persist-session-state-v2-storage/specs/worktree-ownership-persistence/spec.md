# Spec Delta

## Purpose

Defines how the V2 runtime persists a session's worktree ownership record to
durable storage and restores it after a process restart, so `use_clear` can
still recognize and remove an owned worktree it created in an earlier
process. Also defines how that persisted record is retired — on explicit
`use_clear`, and on the owning session's own deletion — so storage keys do
not accumulate indefinitely for sessions that can no longer act on them.

## ADDED Requirements

### Requirement: Persisted Worktree Ownership Record

On the V2 runtime, the plugin SHALL persist a session's worktree ownership
record — `path`, `branch`, `repoRoot`, `owned`, and a schema version — to
durable storage whenever `use_worktree` or `use_clear` changes that session's
in-memory worktree reference (created, reused, or cleared), keyed so the
record can be looked up by the session's own identifier. On the V1 runtime,
no such persistence occurs; worktree ownership remains in-memory only, as
before this capability existed.

#### Scenario: Worktree ownership is persisted on creation

- GIVEN the V2 runtime with durable storage available
- WHEN `use_worktree` creates a new worktree for a session (`create: true`)
- THEN a persisted ownership record for that session's worktree is written to
  durable storage, including its path, branch, repository root, and
  `owned: true`

#### Scenario: Worktree ownership is persisted on reuse

- GIVEN the V2 runtime with durable storage available
- WHEN `use_worktree` reuses an already-registered worktree (the `already
  exists` path, whether via `create: false` or a `create: true` retry)
- THEN a persisted ownership record for that session's worktree is written to
  durable storage with `owned: false`

#### Scenario: Worktree ownership record is removed on clear

- GIVEN the V2 runtime with a persisted ownership record for a session's
  worktree
- WHEN `use_clear` is called with `fields` including `"worktree"` for that
  session, regardless of whether the worktree was owned or not
- THEN the persisted ownership record for that session is removed from
  durable storage

#### Scenario: V1 runtime persists nothing

- GIVEN the V1 runtime
- WHEN `use_worktree` creates, reuses, or `use_clear` clears a worktree
- THEN no ownership record is written to or read from any durable storage,
  and behavior is unchanged from before this capability existed

### Requirement: Eager Hydration And Ground-Truth Validation At Startup

The V2 runtime SHALL, before registering any tool or hook, read every
persisted worktree ownership record from durable storage and validate each
one against the actual state of the git repository it claims to belong to
(via the repository's own worktree registration), before treating it as an
active session worktree reference. A record whose target path and branch are
no longer registered in the claimed repository SHALL be treated as invalid:
it SHALL be discarded and its persisted copy removed, rather than restored as
an active reference. A record that cannot be checked at all within a bounded
time (the claimed repository is unreadable, or validation does not complete
in time) SHALL be skipped for this startup — neither restored as an active
reference nor deleted from durable storage — so a later, healthier startup
can still attempt to validate it.

#### Scenario: Valid persisted record is restored

- GIVEN a persisted ownership record whose path and branch are still
  registered as a worktree in the claimed repository
- WHEN the V2 runtime starts
- THEN that session's worktree reference is restored as active before any
  tool or hook becomes available, and a subsequent `use_clear` for that
  session recognizes and removes the worktree from disk

#### Scenario: Stale persisted record is discarded

- GIVEN a persisted ownership record whose target path is no longer
  registered as a worktree in the claimed repository (removed, moved, or
  re-registered under a different branch)
- WHEN the V2 runtime starts
- THEN that record is not restored as an active reference, and its persisted
  copy is removed from durable storage

#### Scenario: Unreadable repository leaves the record neither restored nor deleted

- GIVEN a persisted ownership record whose claimed repository cannot be read
  (e.g. the containing directory no longer exists, or validation does not
  complete within the startup time budget)
- WHEN the V2 runtime starts
- THEN that record is not restored as an active reference for this startup,
  and its persisted copy is left intact in durable storage for a future
  startup to re-attempt validation

#### Scenario: Hydration never blocks or fails startup

- GIVEN any combination of valid, stale, and unreadable persisted records,
  including durable storage itself being unavailable or erroring
- WHEN the V2 runtime starts
- THEN plugin `setup()` completes successfully within its startup time
  budget regardless of the validation outcome for any individual record, and
  every tool and hook becomes available exactly as if no persisted records
  existed

### Requirement: Graceful Degradation When Durable Storage Is Unavailable

The V2 runtime SHALL detect at startup whether durable storage is fully
available (able to read, write, remove, and enumerate records) and SHALL NOT
raise an error or otherwise fail plugin `setup()` when it is not. When
durable storage is unavailable, the plugin SHALL behave exactly as it did
before this capability existed — worktree ownership tracked in-memory only,
for the lifetime of the process.

#### Scenario: Storage absent at startup

- GIVEN a V2 host that does not provide a durable storage capability
- WHEN the plugin starts
- THEN `setup()` completes without error, no persisted-record hydration is
  attempted, and `use_worktree`/`use_clear` behave exactly as they did before
  this capability existed

#### Scenario: A storage write fails after a successful worktree operation

- GIVEN durable storage that rejects a write
- WHEN `use_worktree` successfully creates a worktree but the ownership
  record cannot be persisted
- THEN the tool still reports the worktree as successfully created, and its
  response additionally discloses that the ownership record could not be
  persisted and will not survive a restart

### Requirement: Retention On Session Deletion

The V2 runtime SHALL remove a session's persisted worktree ownership record
from durable storage when that session itself is deleted, in addition to the
existing removal on `use_clear`. This removal SHALL affect only the
persisted storage record — it SHALL NOT remove the worktree from disk, run
any git operation against it, or otherwise treat session deletion as an
instruction to clean up the worktree itself.

#### Scenario: Session deletion removes its persisted ownership record

- GIVEN a persisted ownership record for a session's worktree
- WHEN that session is deleted (without `use_clear` having been called for
  its worktree first)
- THEN the persisted ownership record for that session is removed from
  durable storage, and no `git worktree remove` or other filesystem/git
  operation is performed against the worktree it referenced

#### Scenario: Session deletion cleanup does not affect the worktree on disk

- GIVEN a persisted, owned worktree ownership record for a deleted session
- WHEN the session-deletion cleanup runs
- THEN the worktree directory and its git registration remain exactly as
  they were, so a later session can still call `use_worktree` with
  `create: false` against the same branch and reattach to it

#### Scenario: Storage failure during session-deletion cleanup does not affect the host

- GIVEN durable storage that rejects a removal
- WHEN a session is deleted and its ownership-record removal fails
- THEN the failure is logged and does not raise an error to the host, is not
  surfaced as a tool response (there is no in-flight tool call), and does not
  stop the cleanup subscription from processing subsequent `session.deleted`
  events
