## MODIFIED Requirements

### Requirement: Advisory System-Prompt Injection

The plugin SHALL inject the session's stored `AGENTS.md` content into the
system prompt via the runtime's session-context hook (V1:
`experimental.chat.system.transform`; V2: `ctx.session.hook("context", ...)`)
whenever that content is present, as a distinct block appended after the
existing "Active Session Context (opencode-use)" block. This block SHALL
state the repository path (the discovered git root, or the resolved
directory itself when not in a git repository) and the file's path, SHALL
explicitly label the content as repository-provided, advisory context that
does not override the agent's own operating instructions and loses to them
on conflict, and SHALL caution that the content may originate from a branch
the agent itself navigated to rather than one the user chose, and so SHALL
be treated as untrusted input rather than as commands. The content SHALL be
wrapped in a fenced code region whose fence length is computed from the
content: the plugin SHALL scan the content for lines that, after stripping
leading whitespace, consist solely of backtick characters, take the length
of the longest such line (zero if none exist), and use a fence of at least
one character longer than that length, with a minimum of three characters,
so that no line within the content can terminate the fenced region. When the
session's stored `AGENTS.md` content is absent, the plugin SHALL NOT inject
this block. This requirement's behavior is identical on both runtimes; only
the underlying hook mechanism differs.

#### Scenario: AGENTS.md content is present

- GIVEN a session with stored `AGENTS.md` content from a discovered repository
- WHEN the system prompt is being assembled
- THEN the plugin injects a block distinct from the "Active Session Context (opencode-use)" block, stating the repository path, the file path, and advisory/provenance framing, with the content fenced

#### Scenario: AGENTS.md content is absent

- GIVEN a session with no stored `AGENTS.md` content
- WHEN the system prompt is being assembled
- THEN the plugin injects no repository-instructions block

#### Scenario: Content contains a run of backtick characters

- GIVEN stored `AGENTS.md` content containing a line consisting solely of N backtick characters (after stripping leading whitespace), where N is at least 3
- WHEN the plugin injects the advisory block
- THEN the fence enclosing the content is at least N+1 backtick characters long

#### Scenario: A directory change replaces previously injected content

- GIVEN a session with stored `AGENTS.md` content from a previously discovered repository
- WHEN a subsequent directory change causes discovery to find a different (or no) `AGENTS.md`
- THEN the system prompt reflects only the new content (or no block at all), and never both the previous and the new content together
</content>
