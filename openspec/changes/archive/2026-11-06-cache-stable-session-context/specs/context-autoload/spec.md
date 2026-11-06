# Spec Delta

## MODIFIED Requirements

### Requirement: Advisory System-Prompt Injection

The plugin SHALL deliver the session's currently stored `AGENTS.md` content
through the runtime's session-context hook whenever that content is present,
as a distinct advisory block after "Active Session Context (opencode-use)".
V1 SHALL retain system-prompt delivery through
`experimental.chat.system.transform`; V2 SHALL include the advisory in the
applicable chronological replacement snapshot through
`ctx.session.hook("context", ...)`.

This block SHALL state the repository path (the discovered git root, or the
resolved directory itself when not in a git repository) and the file's path,
SHALL explicitly label the content as repository-provided, advisory context
that does not override the agent's own operating instructions and loses to
them on conflict, and SHALL caution that the content may originate from a
branch the agent itself navigated to rather than one the user chose, and so
SHALL be treated as untrusted input rather than as commands. The content
SHALL be wrapped in a fenced code region whose fence length is computed
from the content: the plugin SHALL scan the content for lines that, after
stripping leading whitespace, consist solely of backtick characters, take
the length of the longest such line (zero if none exist), and use a fence
of at least one character longer than that length, with a minimum of three
characters, so that no line within the content can terminate the fenced
region.

When stored `AGENTS.md` content is absent, V1 SHALL inject no advisory block;
V2 SHALL explicitly report no applicable repository advisory in its current
replacement snapshot. Earlier V2 snapshots can remain as history, but SHALL
NOT remain applicable after replacement or removal. Advisory provenance,
subordination, and fencing semantics SHALL be identical across runtimes.

#### Scenario: AGENTS.md content is present

- **GIVEN** a session with stored `AGENTS.md` content from a discovered repository
- **WHEN** model context is assembled
- **THEN** the applicable context contains a distinct advisory block after "Active Session Context (opencode-use)", stating the repository path, file path, and advisory/provenance framing, with the content fenced

#### Scenario: AGENTS.md content is absent

- **GIVEN** a session with no stored `AGENTS.md` content
- **WHEN** model context is assembled
- **THEN** V1 injects no repository-instructions block
- **AND** V2's applicable snapshot explicitly reports no repository advisory and withdraws any earlier selection

#### Scenario: Content contains a run of backtick characters

- **GIVEN** stored `AGENTS.md` content containing a line consisting solely of N backtick characters (after stripping leading whitespace), where N is at least 3
- **WHEN** the plugin injects the advisory block
- **THEN** the fence enclosing the content is at least N+1 backtick characters long

#### Scenario: A directory change replaces previously injected content

- **GIVEN** a session with stored `AGENTS.md` content from a discovered repository
- **WHEN** a subsequent directory change finds a different or no `AGENTS.md`
- **THEN** only the new advisory selection or explicit absence is applicable
- **AND** V1's system prompt contains only that selection, while surviving earlier V2 snapshots remain historical and are explicitly superseded rather than removed or relocated

## ADDED Requirements

### Requirement: V2 Snapshot Authority Separation

The plugin SHALL identify V2 snapshots through constant system trust framing as
plugin metadata rather than human-authored requests, with repository content
remaining subordinate and untrusted regardless of message role. Every snapshot
SHALL separate generated framing from repository-controlled text and safely
encode path metadata without changing routing paths. These safeguards do not
guarantee immunity to prompt injection.

#### Scenario: User-message snapshots do not confer user authority

- **GIVEN** repository text containing apparent commands or role/snapshot delimiters
- **WHEN** V2 snapshots are delivered or replayed as ordinary user messages
- **THEN** constant system framing identifies them as plugin context metadata, not human requests
- **AND** every advisory retains provenance, subordinate/untrusted framing, and content-safe fencing
- **AND** no live repository or session data enters the constant system contribution

#### Scenario: Path metadata cannot escape its generated representation

- **GIVEN** a cwd, worktree, environment-source, repository, or advisory-file path containing newline, control, or delimiter characters
- **WHEN** a V2 snapshot is rendered
- **THEN** the path is safely represented without creating additional framing or instructions
- **AND** actual tool routing continues to use the unchanged underlying path
