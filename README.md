# opencode-use

An [opencode](https://opencode.ai) plugin that gives agents a **persistent, per-session working context** — active directory, environment variables, and git worktrees — automatically injected into every tool call that accepts a `workdir` parameter.

Without this plugin, every such tool call starts from opencode's launch directory and carries no environment, making multi-repository tasks and direnv-managed projects awkward. With it, you call `use_cwd` once and every subsequent call to a workdir-aware tool (including `bash`) runs from that directory automatically.

## Features

- **`use_cwd`** — set the active working directory for the session; auto-injected into every tool call that accepts a `workdir` parameter; automatically discovers and loads the target repository's `AGENTS.md` and detects an `.envrc`
- **`use_direnv`** — load a `.envrc` file via `direnv`; all exported variables applied to the process environment of every shell command run for the session
- **`use_worktree`** — create (or reuse) a git worktree and set it as cwd in one call; idempotent; same auto-discovery as `use_cwd`
- **`use_clear`** — tear down the session context; removes owned worktrees from disk
- **Transparent injection** — two independent mechanisms, both silent to the agent: env (any shell opencode spawns for the session, via the native `shell.env` hook) and workdir (any eligible tool, via `tool.execute.before`; a tool is eligible when its schema declares an optional, unconstrained `workdir` string parameter) — the agent writes clean calls and never has to repeat itself
- **System prompt context** — tools with no `workdir` parameter (read, write, edit, glob, grep) see the active path injected into the system prompt so they resolve file paths correctly
- **Repository context auto-load** — whenever `use_cwd`/`use_worktree` moves the session to a genuinely new directory, the plugin searches upward (bounded by the git root) for an `AGENTS.md` and injects it into the system prompt as clearly-labeled advisory context, and detects (never executes) an `.envrc` to remind the agent to load it explicitly

## Requirements

- **Node.js** `>= 22.5`
- **opencode** with `@opencode-ai/plugin >= 1.15.0`
- **direnv** on `PATH` (only required when using `use_direnv`)
- **git** on `PATH` (only required when using `use_worktree` / `use_clear`)

## Installation

### 1. Clone the repository

```bash
git clone git@github.com:afriemann/opencode-use.git ~/git/opencode-use
```

### 2. Resolve the peer dependency

The plugin lives outside `~/.config/opencode/`, so Bun cannot walk up to find `@opencode-ai/plugin` there. Create a one-time symlink into the plugin's own `node_modules`:

```bash
mkdir -p ~/git/opencode-use/node_modules/@opencode-ai
ln -s ~/.config/opencode/node_modules/@opencode-ai/plugin \
      ~/git/opencode-use/node_modules/@opencode-ai/plugin
```

The test suite also needs `zod` (dev-only — the production code has no `zod`
dependency) to build fixtures matching the real schema shapes plugin-authored
tools present to opencode. Symlink it the same way:

```bash
ln -s ~/.config/opencode/node_modules/zod ~/git/opencode-use/node_modules/zod
```

Repeat both steps after a fresh opencode install or re-bootstrap.

### 3. Symlink the plugin into opencode's plugins directory

```bash
ln -s ~/git/opencode-use/src/index.js \
      ~/.config/opencode/plugins/opencode-use.js
```

opencode discovers any `.js` file in `~/.config/opencode/plugins/` automatically — no config changes are needed.

### 4. Verify

Start (or restart) opencode. You should see `use_cwd`, `use_direnv`, `use_worktree`, and `use_clear` listed as available tools.

## Tools

### `use_cwd`

Set the active working directory for the session.

```
use_cwd(path: string) → "Working directory set to: <resolved-path>"
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute or relative path. Relative paths resolve against the project directory first, then the current active cwd as fallback. |

After this call the plugin silently sets `workdir` on every subsequent bash invocation. The agent does **not** need to pass `workdir` to bash calls — doing so is redundant (and the tool schema annotation says so).

When the resolved directory differs from the session's current one, the plugin also runs [repository context auto-load](#repository-context-auto-load) — see that section for details. The return value includes any resulting notes, e.g.:

```
Working directory set to: /home/user/git/some-repo
Loaded AGENTS.md from /home/user/git/some-repo/AGENTS.md.
Found .envrc at /home/user/git/some-repo/.envrc — call use_direnv('/home/user/git/some-repo') to load it (not loaded automatically).
```

---

### `use_direnv`

Load environment variables from a `.envrc` file in the given directory.

```
use_direnv(path: string) → "<N> variable(s) loaded: ..."
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Directory containing the `.envrc` to load. |

- Runs `direnv export json` and captures the environment delta.
- **Replaces** any previously loaded env — does not merge.
- If the `.envrc` is blocked (not yet `direnv allow`-ed), the tool fails with an actionable message asking the user to allow it.
- All loaded variables are applied to the process environment of every shell command run for the session (the `bash` tool, and shell parts opencode spawns from the prompt path), except `PWD`, `OLDPWD`, and any `DIRENV_*` key — see [Hook: `shell.env`](#hook-shellenv).
- This tool only loads the environment — it never changes the session's active working directory. Call `use_cwd` separately if you also need to move there (and note that `use_cwd` already detects an `.envrc`'s presence for you and reminds you to call this tool).

---

### `use_worktree`

Create a git worktree and set it as the active working directory.

```
use_worktree(path: string, branch: string, create?: boolean, fromRemote?: boolean, base?: string)
  → "Worktree created at <path> on branch '<branch>' [(from <remote-base>)]. Active working directory set to <path>. Repository root: <root>."
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Path where the worktree will be created (or already exists). |
| `branch` | string | yes | Branch to check out. Must exist unless `create=true`. |
| `create` | boolean | no | Create a new branch with `git worktree add -b`. Default: `false`. If the branch already exists but isn't checked out anywhere, it's checked out into `path` instead of failing; if it's already checked out at a different worktree path, an error names that path. |
| `fromRemote` | boolean | no | When `create=true`, fetch from origin first and base the new branch on the remote default branch (auto-detected from the remote) instead of local HEAD. Default: `true`. Pass `false` to create from local HEAD without fetching. |
| `base` | string | no | Override which remote ref to use as the base when `fromRemote=true` (e.g. `"origin/develop"`). Defaults to the auto-detected remote default branch. Has no effect when `fromRemote=false` or `create=false`. |

- **Idempotent**: if the worktree at the given path is already registered for the given branch, it is reused without error. If the same path is already the active worktree for this session, returns a no-op message.
- **Cross-repo contamination guard**: when reusing an existing worktree, the tool verifies the worktree actually belongs to the same repository as the current session (by inspecting which primary worktree it reports). If a prior session placed a *different* repo's worktree at the same path, an error is raised that names both repos and gives the exact `git worktree remove` command to clean up.
- If a *different* worktree is already active, it fails with a `use_clear` hint.
- The repository root itself is rejected as the worktree path — always use a subdirectory (e.g. `.worktrees/<branch>`).
- If the branch is already checked out at the repository root (main worktree), fails early with a clear error — switch to a different branch in the root first, then call `use_worktree` again.
- Worktrees created by this tool are marked **owned** — `use_clear` will remove them from disk.
- Git operations run against the active working directory (set via `use_cwd`) → `ctx.worktree` → `ctx.directory` in priority order, so calling `use_cwd` first lets this work even when opencode was opened outside a git repo.
- When the resolved worktree directory differs from the session's current one, the plugin also runs [repository context auto-load](#repository-context-auto-load) — the return value includes any resulting notes, same as `use_cwd`.

---

### `use_clear`

Reset one or more fields of the active session state.

```
use_clear(fields?: Array<"cwd" | "env" | "worktree">, force?: boolean)
  → newline-separated list of cleared items, or "Nothing to clear"
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fields` | array | no | Which fields to reset. Omit to reset all three. |
| `force` | boolean | no | Pass `--force` to `git worktree remove`, discarding uncommitted changes and untracked files. Also clears the session reference if the path is no longer a registered git worktree. Default: `false`. |

- Clearing `worktree` removes **owned** worktrees from disk with `git worktree remove`. If the worktree has uncommitted changes or untracked files the command fails loudly — pass `force=true` to discard them, or clean up first and call `use_clear` again. If the path is no longer registered with git, `force=true` clears the session reference without attempting removal.
- Clearing `worktree` also clears `cwd` when cwd was pointing at the worktree (prevents bash commands from targeting a now-deleted directory).
- Clearing `cwd` (directly, or indirectly via `worktree`) also clears any auto-loaded `AGENTS.md` repository context, so a cleared session doesn't keep injecting a stale repository's instructions into the system prompt.
- Worktrees not created by this plugin in the current session are **unowned** — their directory is never removed.

**Common pattern after finishing a feature branch:**

```
use_clear(fields: ["cwd", "worktree"])
```

## Repository Context Auto-Load

Whenever `use_cwd` or `use_worktree` moves the session's active directory to a **genuinely new path** (not on an idempotent no-op/reuse call), the plugin automatically:

1. **Searches for `AGENTS.md`.** It resolves the new directory's git root (`git rev-parse --show-toplevel`) and searches upward from the directory to that root (or just the directory itself if it isn't inside a git repository), using the **nearest** match if more than one `AGENTS.md` exists along the way. The found content is injected into the system prompt as a distinct, clearly-labeled block:
   - It states the **repository path** and the **file path**.
   - It is explicitly framed as **advisory, repository-provided context that does not override the agent's own operating instructions** — because it may come from a branch the *agent itself* navigated to (e.g. an unreviewed PR branch via `use_worktree`), not a directory the user chose. The agent is told to treat it as untrusted input, never as commands.
   - Content is size-capped: files up to 16 KiB are injected in full; files up to 1 MiB are truncated to 16 KiB at a line boundary with a marker; files larger than 1 MiB are not read at all (a note in the tool's return value says so).
   - The content is wrapped in a fenced code block whose backtick count is computed from the content itself, so a crafted `AGENTS.md` cannot terminate the fence early and impersonate system text.
   - A directory change always **replaces** the previously injected content (including clearing it entirely when the new directory has no `AGENTS.md`) — a session that moves between repositories never shows two repositories' instructions at once, or a stale one.
2. **Detects (never loads) an `.envrc`.** Using the same upward search, the plugin checks — via a plain filesystem existence check only, **no `direnv` subprocess is ever invoked for this** — whether an `.envrc` exists between the directory and the git root. If one is found, a non-blocking note is appended to the tool's return value suggesting the agent call `use_direnv` explicitly. The `.envrc`'s contents are never read or executed by this detection.

No failure in this process (git unavailable, permission errors, an unreadable file) can fail the triggering `use_cwd`/`use_worktree` call — discovery is entirely best-effort.

## How It Works

### Hook: `tool.execute.before`

Fires before every tool call whose schema was cached as workdir-capable (see [Hook: `tool.definition`](#hook-tooldefinition) below): if the session has an active cwd and the agent did not set `workdir` explicitly, sets `output.args.workdir = state.cwd`.

The plugin never modifies the agent's `command` string, under any circumstance. An explicit `workdir` from the agent is always honoured for that one call only.

### Hook: `shell.env`

Fires whenever opencode is about to spawn a shell process for a session with a known `sessionID` — the `bash` tool, and shell parts opencode spawns from its own prompt path. If the session has active environment variables loaded via `use_direnv`, they are merged into `output.env`, filtered to POSIX-portable identifier names and excluding `PWD`, `OLDPWD`, and any `DIRENV_*` key (owned by the shell itself or by direnv's own bookkeeping, and would otherwise conflict with the independently-set `workdir` or confuse a direnv-hooked child shell). opencode merges this into the real child process environment before spawning — the variables are never visible as part of the command string. Interactive terminals (pty) trigger this hook without a `sessionID` and so continue to receive no injected env. The hook never throws; any internal fault is caught, logged, and leaves the environment for that call unmodified.

### Hook: `tool.definition`

Annotates the bash tool's `workdir` parameter description at every LLM call, telling the model it must not supply `workdir` when the plugin is active. This is more authoritative than a system-prompt note because the model reads tool schemas while choosing parameter values.

### Hook: `experimental.chat.system.transform`

When any session context is active, appends an `## Active Session Context (opencode-use)` block to the system prompt listing the current working directory, environment source, and active worktree. This allows non-bash tools (read, write, edit, glob, grep) to resolve file paths correctly — the model constructs absolute paths from the injected base.

When the session has auto-loaded `AGENTS.md` content, this hook also appends a second, distinct `## Repository-Provided Instructions (opencode-use, advisory)` block — see [Repository Context Auto-Load](#repository-context-auto-load).

### Session State

State is stored in a `Map` keyed by `sessionID`. Each session has:

```js
{
  cwd: string | null,
  env: Record<string, string>,
  envSource: string | null,
  worktree: { path: string, owned: boolean } | null,
  agentsMd: { repoPath: string, filePath: string, content: string } | null
}
```

State is in-process only — it does not persist across opencode restarts.

## Development

### Syntax check

```bash
npm test
# node --check src/index.js && echo 'Syntax OK'
```

CI runs this against Node.js 22 and 24 on every push and pull request.

### Extending the plugin

The plugin exports a single async factory function `OpenCodeUse({ client, $ })`. Each tool is created with `tool()` from `@opencode-ai/plugin`. Hooks are returned as properties of the plain object the factory resolves to — matching the hook event name as the key.

**`src/index.js` (the file symlinked into `~/.config/opencode/plugins/`) must export nothing but `default`.** opencode's legacy-plugin loader treats *every* top-level named export of a scanned plugin file that is a function as an independent plugin factory, and invokes it as `server(input, options)` regardless of that function's real signature. A stray named export here is silently misinterpreted as its own broken "plugin" — at best a benign, always-failing no-op; at worst (if it happens to sort alphabetically before `default`) it aborts the loader before the real plugin ever registers, taking down all four tools. Internal helper functions that need direct unit-test access (`nearestExistingDir`, `resolveGitRoot`, `discoverGitRoot`, `resolveRepoContext`, `applyDirectoryChange`) live in `src/lib.js` instead, which is never symlinked into opencode's plugins directory and therefore never scanned. `test/plugin-export-surface.test.js` guards against this regressing.

See the [opencode plugin API documentation](https://opencode.ai/docs/plugins) for the full hook surface and `tool()` schema API.

## License

MIT
