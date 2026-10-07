# opencode-use

opencode plugin giving agents a persistent per-session working context (directory, direnv environment, git worktrees) injected into every eligible tool call.

- Runtimes: V1 (`@opencode-ai/plugin`) via `src/plugin.v1.js` (package `main`), V2 (`@opencode/plugin`) via `src/plugin.v2.js`. Both are thin adapters over shared logic in `src/core.js` and `src/lib.js`; keep behaviour identical across them.
- Provides: tools `use_workdir`, `use_direnv`, `use_worktree`, `use_clear`; V1 hooks `tool.execute.before`, `shell.env`, `experimental.chat.system.transform`, `event`, with V2 equivalents (`ctx.tool.hook`, `ctx.shell.hook`, `ctx.session.hook`). Auto-loads the target repo's `AGENTS.md`.
- Layout: `src/` plugin code, `test/` tests, `docs/v2-compat-audit.md` V1→V2 hook mapping, `openspec/` specs and changes (behaviour contract).
- Test: `npm test` (E2E: `npm run test:e2e`). No lint or build script. CI: `.github/workflows/ci.yml`.
- Gotcha: it never runs `direnv allow`, except for a newly created worktree whose `.envrc` is byte-identical to an already-allowed root `.envrc`.
- Usage, install and configuration: see `README.md`.
