# worktree-envrc-trust Specification

## Purpose
Automatically extends an already-established `direnv` trust decision to a
newly created git worktree when its `.envrc` is provably byte-identical to
the repository root's already-allowed `.envrc`, in this one narrow case only.

## Requirements

### Requirement: Auto-Trust a Newly Created Worktree's Identical .envrc

When `use_worktree` creates a brand-new worktree (not when it reuses an
existing one, whether owned by the plugin or not), and the newly created
worktree contains a file literally named `.envrc`, the plugin SHALL compare
that file's contents, read at the moment of the check, to the contents of a
file literally named `.envrc` at the repository root, also read at the
moment of the check. If the two are byte-identical, and the repository
root's `.envrc` is, at that same moment, already allowed by `direnv`, the
plugin SHALL run `direnv allow` on the new worktree's `.envrc` without
prompting the user. After running `direnv allow`, the plugin SHALL re-read
the worktree's `.envrc` and compare it to the content it verified before
running `direnv allow`; if the content no longer matches, the plugin SHALL
treat the file as not verified, SHALL NOT treat it as auto-loadable for this
worktree-creation call, and SHALL append a note naming the file and
instructing the user to inspect and re-approve it manually. This comparison
SHALL be performed only between the new worktree's own `.envrc` and the
repository root's own `.envrc` — the plugin SHALL NOT walk any ancestor
directory, or any worktree other than the one just created, when performing
this comparison.

#### Scenario: Newly created worktree's identical, already-allowed .envrc is auto-trusted

- GIVEN `use_worktree` creates a brand-new worktree whose `.envrc` is byte-identical to the repository root's `.envrc`, and the repository root's `.envrc` is already allowed by `direnv` at the moment of the check
- WHEN the worktree creation completes
- THEN the plugin runs `direnv allow` on the new worktree's `.envrc` without prompting the user

#### Scenario: Differing .envrc content is never auto-trusted

- GIVEN `use_worktree` creates a brand-new worktree whose `.envrc` differs in content from the repository root's `.envrc`
- WHEN the worktree creation completes
- THEN the plugin does not run `direnv allow` on the new worktree's `.envrc`, and appends a note stating the content differs from the repository root's

#### Scenario: Auto-trust is skipped when the repository root's .envrc is not itself allowed

- GIVEN `use_worktree` creates a brand-new worktree whose `.envrc` is byte-identical to the repository root's `.envrc`, but the repository root's `.envrc` is not allowed by `direnv` at the moment of the check
- WHEN the worktree creation completes
- THEN the plugin does not run `direnv allow` on the new worktree's `.envrc`

#### Scenario: Reusing an existing worktree never triggers auto-trust

- GIVEN `use_worktree` attaches to a worktree that already existed before the call, whether previously created by the plugin or not
- WHEN the call completes
- THEN the plugin does not perform the byte-identity comparison or run `direnv allow`, regardless of the worktree's `.envrc` content

#### Scenario: Content modified between the allow check and re-verification is caught and not loaded

- GIVEN a newly created worktree's `.envrc` was verified identical and its root counterpart allowed, and `direnv allow` was run
- WHEN the plugin re-reads the worktree's `.envrc` immediately after running `direnv allow` and finds its content no longer matches what was verified
- THEN the plugin does not treat the file as auto-loadable for this call, and appends a note instructing the user to inspect and re-approve it manually

#### Scenario: Comparison is scoped to the repository root and the new worktree only

- GIVEN a newly created worktree whose `.envrc` matches an ancestor directory's `.envrc` other than the repository root's, or matches another worktree's `.envrc`
- WHEN the plugin performs the auto-trust comparison
- THEN the plugin does not treat that match as a basis for auto-trust — only a byte-identical match against the repository root's own `.envrc` is considered

### Requirement: No Unattended direnv Trust Outside This One Case

The plugin SHALL NOT run `direnv allow` in any circumstance other than the
one described above: a `use_worktree` call that creates a brand-new
worktree, whose `.envrc` is byte-identical to an already-allowed repository
root `.envrc` at the moment of the check. In particular, the plugin SHALL
NOT run `direnv allow` in response to `use_direnv`, `use_workdir`, a
worktree-reuse path, session-start initialization, or a V2 session-move
event, regardless of whether the relevant `.envrc` was previously allowed
elsewhere.

#### Scenario: use_direnv never runs direnv allow

- GIVEN a session with an `.envrc` that is not yet allowed by `direnv`
- WHEN the agent calls `use_direnv` for that directory
- THEN the plugin does not run `direnv allow`, and instead surfaces `direnv`'s existing blocked-and-not-allowed error asking the user to run `direnv allow` themselves

#### Scenario: Session-start initialization never runs direnv allow

- GIVEN a new session whose starting directory contains an `.envrc` that is not yet allowed by `direnv`
- WHEN the plugin initializes the session's starting directory
- THEN the plugin does not run `direnv allow`

#### Scenario: A worktree-reuse path never runs direnv allow

- GIVEN `use_worktree` attaches to an existing worktree whose `.envrc` is not yet allowed by `direnv`, and is byte-identical to the repository root's already-allowed `.envrc`
- WHEN the call completes
- THEN the plugin does not run `direnv allow`, because auto-trust applies only to the worktree-creation path
