# opencode-use

An [opencode](https://opencode.ai) plugin that gives agents a **persistent, per-session working context** — active directory, environment variables, and git worktrees — automatically injected into every tool call that accepts a `workdir` parameter.

Without this plugin, every such tool call starts from opencode's launch directory and carries no environment, making multi-repository tasks and direnv-managed projects awkward. With it, you call `use_cwd` once and every subsequent call to a workdir-aware tool (including `bash`) runs from that directory automatically.

## Features

- **`use_cwd`** — set the active working directory for the session; auto-injected into every tool call that accepts a `workdir` parameter
- **`use_direnv`** — load a `.envrc` file via `direnv`; all exported variables prepended to every bash command
- **`use_worktree`** — create (or reuse) a git worktree and set it as cwd in one call; idempotent
- **`use_clear`** — tear down the session context; removes owned worktrees from disk
- **Transparent injection** — env (bash-only) and workdir (any eligible tool) are injected silently via `tool.execute.before`; a tool is eligible when its schema declares an optional, unconstrained `workdir` string parameter — the agent writes clean calls and never has to repeat itself
- **System prompt context** — tools with no `workdir` parameter (read, write, edit, glob, grep) see the active path injected into the system prompt so they resolve file paths correctly

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

---

### `use_direnv`

Load environment variables from a `.envrc` file in the given directory.

```
use_direnv(path: string, changeCwd?: boolean) → "<N> variable(s) loaded: ..."
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Directory containing the `.envrc` to load. |
| `changeCwd` | boolean | no | Also set cwd to this path. Default: `false`. |

- Runs `direnv export json` and captures the environment delta.
- **Replaces** any previously loaded env — does not merge.
- If the `.envrc` is blocked (not yet `direnv allow`-ed), the tool fails with an actionable message asking the user to allow it.
- All loaded variables are prepended to every bash command as `export K=V && ...`.

---

### `use_worktree`

Create a git worktree and set it as the active working directory.

```
use_worktree(path: string, branch: string, create?: boolean, fromRemote?: boolean, base?: string)
  → "Worktree created at <path> on branch '<branch>' [(from <remote-base>)]. Active working directory set to <path>."
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Path where the worktree will be created (or already exists). |
| `branch` | string | yes | Branch to check out. Must exist unless `create=true`. |
| `create` | boolean | no | Create a new branch with `git worktree add -b`. Default: `false`. |
| `fromRemote` | boolean | no | When `create=true`, fetch from origin first and base the new branch on the remote default branch (auto-detected from the remote) instead of local HEAD. Default: `true`. Pass `false` to create from local HEAD without fetching. |
| `base` | string | no | Override which remote ref to use as the base when `fromRemote=true` (e.g. `"origin/develop"`). Defaults to the auto-detected remote default branch. Has no effect when `fromRemote=false` or `create=false`. |

- **Idempotent**: if the worktree at the given path is already registered for the given branch, it is reused without error. If the same path is already the active worktree for this session, returns a no-op message.
- **Cross-repo contamination guard**: when reusing an existing worktree, the tool verifies the worktree actually belongs to the same repository as the current session (by inspecting which primary worktree it reports). If a prior session placed a *different* repo's worktree at the same path, an error is raised that names both repos and gives the exact `git worktree remove` command to clean up.
- If a *different* worktree is already active, it fails with a `use_clear` hint.
- The repository root itself is rejected as the worktree path — always use a subdirectory (e.g. `.worktrees/<branch>`).
- If the branch is already checked out at the repository root (main worktree), fails early with a clear error — switch to a different branch in the root first, then call `use_worktree` again.
- Worktrees created by this tool are marked **owned** — `use_clear` will remove them from disk.
- Git operations run against the active working directory (set via `use_cwd`) → `ctx.worktree` → `ctx.directory` in priority order, so calling `use_cwd` first lets this work even when opencode was opened outside a git repo.

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
- Worktrees not created by this plugin in the current session are **unowned** — their directory is never removed.

**Common pattern after finishing a feature branch:**

```
use_clear(fields: ["cwd", "worktree"])
```

## How It Works

### Hook: `tool.execute.before`

Fires before every bash call with two layers of injection:

1. **Env layer** — if the session has loaded variables, prepends `export K=V && export K2=V2 && ...` to the command string.
2. **Cwd layer** — if the session has an active cwd and the agent did not set `workdir` explicitly, sets `output.args.workdir = state.cwd`.

The agent's command is never modified beyond the env prefix. An explicit `workdir` from the agent is always honoured for that one call only.

### Hook: `tool.definition`

Annotates the bash tool's `workdir` parameter description at every LLM call, telling the model it must not supply `workdir` when the plugin is active. This is more authoritative than a system-prompt note because the model reads tool schemas while choosing parameter values.

### Hook: `experimental.chat.system.transform`

When any session context is active, appends an `## Active Session Context (opencode-use)` block to the system prompt listing the current working directory, environment source, and active worktree. This allows non-bash tools (read, write, edit, glob, grep) to resolve file paths correctly — the model constructs absolute paths from the injected base.

### Session State

State is stored in a `Map` keyed by `sessionID`. Each session has:

```js
{
  cwd: string | null,
  env: Record<string, string>,
  envSource: string | null,
  worktree: { path: string, owned: boolean } | null
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

See the [opencode plugin API documentation](https://opencode.ai/docs/plugins) for the full hook surface and `tool()` schema API.

## License

MIT
