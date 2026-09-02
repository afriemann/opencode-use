import { tool } from '@opencode-ai/plugin'
import { resolve, isAbsolute, dirname } from 'node:path'
import { stat } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/** @type {Map<string, { cwd: string|null, env: Record<string,string>, envSource: string|null, worktree: { path: string, owned: boolean }|null }>} */
const sessions = new Map()

function getState(sessionID) {
  if (!sessions.has(sessionID)) {
    sessions.set(sessionID, { cwd: null, env: {}, envSource: null, worktree: null })
  }
  return sessions.get(sessionID)
}

/**
 * Cache of tool-schema workdir-capability, populated by the `tool.definition`
 * hook and consumed by `tool.execute.before`. Keyed by bare toolID. A tool's
 * definition is always sent to the model before the model can call it, so
 * this cache is repopulated from the authoritative schema on every turn in
 * which the tool is callable at all — no TTL or cross-session invalidation
 * is needed. A missing entry is falsy and means "do not inject" (fail-closed).
 *
 * @type {Map<string, boolean>}
 */
const workdirCapable = new Map()

/**
 * The plugin's own tool IDs. Excluded from workdir-capability recording as
 * defensive coding against ever injecting into the plugin's own tools —
 * none currently declares a `workdir` parameter.
 */
const SELF_TOOL_IDS = new Set(['use_cwd', 'use_direnv', 'use_worktree', 'use_clear'])

/**
 * Appended to a workdir-capable tool's `workdir` parameter description.
 * Also serves as its own idempotency sentinel: checked against the live
 * description string before appending, so re-firing `tool.definition` for
 * the same object never duplicates it. Names no specific tool so it reads
 * correctly for any eligible tool, including `bash`.
 */
const WORKDIR_ANNOTATION =
  ' When "## Active Session Context (opencode-use)" is present in your system prompt,' +
  ' this parameter is auto-populated by the plugin before this tool call executes —' +
  ' you do not need to set it.' +
  ' A workdir value shown on a previous call in your context was injected by the' +
  ' plugin after you submitted that call, not set by you — write your next call without it.' +
  ' Exception: set this explicitly if you intentionally need a different directory for this' +
  ' one specific call — your value will be honored for that call only.'

/**
 * Determine whether a tool's schema declares an eligible `workdir`
 * parameter: an optional string with no `enum` constraint. Rejecting
 * non-string, enum-constrained, or required `workdir` parameters avoids
 * producing a schema-invalid argument or a self-contradicting annotation
 * (see design.md decision #2).
 *
 * @param {any} parameters
 * @returns {boolean}
 */
function isWorkdirEligible(parameters) {
  const prop = parameters?.properties?.workdir
  if (!prop) return false
  if (prop.type !== 'string') return false
  if ('enum' in prop) return false
  const required = parameters?.required
  if (Array.isArray(required) && required.includes('workdir')) return false
  return true
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a path against a base directory.
 * Absolute paths are returned as-is.
 * Relative paths resolve against ctxDirectory first, stateCwd as fallback.
 */
function resolvePath(inputPath, ctxDirectory, stateCwd) {
  if (isAbsolute(inputPath)) return inputPath
  if (ctxDirectory) return resolve(ctxDirectory, inputPath)
  if (stateCwd) return resolve(stateCwd, inputPath)
  throw new Error(`Cannot resolve relative path '${inputPath}': no base directory available`)
}

/**
 * Choose the best base directory for git operations.
 * Priority: state.cwd (user's explicit choice) → ctx.worktree (session git root) → ctx.directory.
 * This handles the common case where opencode is opened from ~ (not a git repo) but the
 * user has called use_cwd to point at a git repo first.
 */
function gitRoot(state, ctx) {
  return state.cwd ?? ctx.worktree ?? ctx.directory
}

/**
 * Find the nearest existing ancestor directory of `path`, walking upward past
 * path segments that don't exist yet (e.g. an un-created `.worktrees/<branch>`
 * destination). Returns the filesystem root if no ancestor exists.
 */
export async function nearestExistingDir(path) {
  let dir = path
  while (true) {
    try {
      if ((await stat(dir)).isDirectory()) return dir
    } catch {
      // Doesn't exist yet — keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) return dir
    dir = parent
  }
}

/**
 * Resolve a validated git root for worktree operations.
 * Tries `candidateRoot` (the session's gitRoot()) first; if that isn't
 * actually inside a git repository, falls back to discovering one by walking
 * up from the nearest existing ancestor of the target worktree path. Throws a
 * clear, actionable error if neither yields a real repository, instead of
 * letting a raw git subprocess error (e.g. "origin does not appear to be a
 * git repository") leak through from a later command run in the wrong place.
 */
export async function resolveGitRoot($, candidateRoot, resolvedWorktreePath) {
  const nearestExisting = await nearestExistingDir(dirname(resolvedWorktreePath))
  for (const cwd of [candidateRoot, nearestExisting]) {
    try {
      return (await $`git rev-parse --show-toplevel`.cwd(cwd).quiet().text()).trim()
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `Cannot determine a git repository for this operation.\n` +
    `  Session git root candidate: '${candidateRoot}' is not inside a git repository.\n` +
    `  Target worktree path's nearest existing ancestor '${nearestExisting}' is not inside one either.\n` +
    `Call use_cwd('<path-to-the-target-repo>') first, then call use_worktree again.`,
  )
}

/**
 * POSIX-safe single-quoting for injecting values into a bash -c string.
 * Wraps the value in single quotes, escaping any embedded single quotes.
 */
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/**
 * Build an `export K=V && ...` prefix string from the session env map.
 * Only variable names matching [A-Za-z_][A-Za-z0-9_]* are emitted.
 */
function buildEnvExports(env) {
  const entries = Object.entries(env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
  if (entries.length === 0) return ''
  return entries.map(([k, v]) => `export ${k}=${shellQuote(v)}`).join(' && ')
}

/**
 * Returns a logger function that writes to the opencode client log,
 * falling back to process.stderr on failure.
 */
function makeLogger(client) {
  return (message, err, level = err ? 'error' : 'info') => {
    const detail = err ? `: ${err instanceof Error ? (err.stack ?? err.message) : err}` : ''
    const msg = `[opencode-use] ${message}${detail}`
    try {
      const p = client.app.log({ body: { service: 'opencode-use', level, message: msg } })
      p?.catch?.(() => process.stderr.write(msg + '\n'))
    } catch {
      process.stderr.write(msg + '\n')
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export default async function OpenCodeUse({ client, $ }) {
  const log = makeLogger(client)

  // -------------------------------------------------------------------------
  // use_cwd — set active working directory
  // -------------------------------------------------------------------------

  const useCwd = tool({
    description:
      'Set the active working directory for this session. ' +
      'The plugin automatically injects this as workdir into every tool call that accepts a ' +
      'workdir parameter (including bash) via tool.execute.before — ' +
      'you do NOT need to pass workdir to such calls yourself; doing so is redundant. ' +
      'Tools with no workdir parameter (read, write, edit, glob, grep) receive this path in the system prompt — ' +
      'use it as the base when constructing file paths for those tools. ' +
      'Relative paths resolve against the project directory first, ' +
      'then the current active working directory as fallback. ' +
      'Path must exist and be a directory. ' +
      'Returns: "Working directory set to: <resolved-path>".',
    args: {
      path: tool.schema.string().describe('Absolute or relative path to set as the working directory'),
    },
    async execute({ path }, ctx) {
      try {
        const state = getState(ctx.sessionID)
        const resolved = resolvePath(path, ctx.directory, state.cwd)
        const info = await stat(resolved)
        if (!info.isDirectory()) throw new Error(`Not a directory: ${resolved}`)
        state.cwd = resolved
        return `Working directory set to: ${resolved}`
      } catch (err) {
        log('use_cwd failed', err)
        throw err
      }
    },
  })

  // -------------------------------------------------------------------------
  // use_direnv — load direnv .envrc into session env
  // -------------------------------------------------------------------------

  const useDirenv = tool({
    description:
      'Load environment variables from a direnv .envrc file in the given directory. ' +
      'Runs `direnv export json` to capture the environment delta. ' +
      'Requires direnv on PATH. ' +
      'REPLACES any previously loaded environment — calling this again overwrites the prior env entirely; it does not merge. ' +
      'Relative paths resolve against the project directory first, then the current active working directory as fallback. ' +
      'IMPORTANT: if the .envrc is blocked (not yet allowed by direnv), ' +
      'STOP and ask the user to run `direnv allow` in that directory before calling this again — ' +
      'do not proceed without user approval. ' +
      'Pass changeCwd=true to also set the active working directory to the given path. ' +
      'Returns: "Loaded N variable(s): name1, name2, …" or "direnv loaded — no environment changes exported". ' +
      'When changeCwd=true, appends ". Working directory set to: <resolved-path>".',
    args: {
      path: tool.schema.string().describe('Directory containing the .envrc file to load'),
      changeCwd: tool.schema
        .boolean()
        .optional()
        .describe('Also set the active working directory to this path. Default: false'),
    },
    async execute({ path, changeCwd = false }, ctx) {
      try {
        const state = getState(ctx.sessionID)
        const resolved = resolvePath(path, ctx.directory, state.cwd)

        let stdout
        try {
          stdout = await $`direnv export json`.cwd(resolved).quiet().text()
        } catch (err) {
          const stderr = err.stderr ?? ''
          if (
            stderr.includes('is blocked') ||
            stderr.includes('direnv allow') ||
            stderr.includes('not allowed')
          ) {
            throw new Error(
              `The .envrc at ${resolved} is not allowed by direnv. ` +
              `STOP — ask the user to approve it, then run: direnv allow ${resolved} ` +
              `Once allowed, call use_direnv again.`,
            )
          }
          if (err.code === 'ENOENT') {
            throw new Error('direnv is not installed or not on PATH')
          }
          throw new Error(`direnv export json failed in ${resolved}: ${err.stderr ?? err.message}`)
        }

        const trimmed = stdout.trim()
        const raw = trimmed ? JSON.parse(trimmed) : {}
        const envDelta = {}
        for (const [k, v] of Object.entries(raw)) {
          if (v !== null) envDelta[k] = String(v)
        }

        state.env = envDelta
        state.envSource = `direnv:${resolved}`
        if (changeCwd) state.cwd = resolved

        const names = Object.keys(envDelta)
        const summary =
          names.length > 0
            ? `Loaded ${names.length} variable(s): ${names.join(', ')}`
            : 'direnv loaded — no environment changes exported'
        return changeCwd ? `${summary}. Working directory set to: ${resolved}` : summary
      } catch (err) {
        log('use_direnv failed', err)
        throw err
      }
    },
  })

  // -------------------------------------------------------------------------
  // use_worktree — create a git worktree and set it as cwd
  // -------------------------------------------------------------------------

  const useWorktree = tool({
    description:
      'Create a git worktree and set it as the active working directory for this session. ' +
      'Pass an existing branch name (create=false, default), or pass create=true to create a new branch with `git worktree add -b`. ' +
      'When create=true, the default behaviour is to fetch from origin and base the new branch on the remote ' +
      'default branch (auto-detected from the remote) instead of local HEAD. ' +
      'Pass fromRemote=false to skip the fetch and create from local HEAD instead. ' +
      'Pass the `base` parameter to override which remote ref to use (e.g. `base="origin/develop"`). ' +
      'Idempotent: if the worktree at the given path is already registered for the given branch, it is reused rather than failing. ' +
      'Cross-repo contamination guard: when reusing an existing worktree, the tool verifies the worktree belongs to the same repository as the current session; if it does not (e.g. a prior session placed a different repo\'s worktree at the same path), an error is raised describing the mismatch and the cleanup command. ' +
      'If the same path is already the active worktree for this session, returns a no-op message. ' +
      'Relative paths resolve against the project directory first, then the current active working directory as fallback. ' +
      'Git operations run against the active working directory if set (via a prior use_cwd call), ' +
      'falling back to the session git root and then the project directory — ' +
      'call use_cwd with the target repo path first if opencode was opened outside a git repo. ' +
      'STOP if a *different* worktree is already active for this session — call use_clear (fields: ["cwd", "worktree"]) ' +
      'to remove it first, then call use_worktree again. ' +
      'Cannot use the repository root itself as the worktree path — always specify a subdirectory (e.g. .worktrees/<branch>). ' +
      'If the branch is already checked out at the repository root, fails early with a clear error — switch to a different branch in the root first, then call use_worktree again. ' +
      'Sets the active working directory to the new worktree path AND records it so use_clear can remove it from disk later. ' +
      'Returns: "Worktree created at <path> on branch \'<branch>\' [(from <remote-base>)]. Active working directory set to <path>."',
    args: {
      path: tool.schema.string().describe('Path where the worktree directory will be created (or already exists)'),
      branch: tool.schema
        .string()
        .describe('Branch to check out in the worktree (must exist unless create=true)'),
      create: tool.schema
        .boolean()
        .optional()
        .describe('Create a new branch with -b. Default: false'),
      fromRemote: tool.schema
        .boolean()
        .optional()
        .describe(
          'When create=true, fetch from origin first and base the new branch on the remote default branch ' +
          '(auto-detected from the remote) instead of local HEAD. ' +
          'Combine with the `base` parameter to target a non-default remote ref. Default: true',
        ),
      base: tool.schema
        .string()
        .optional()
        .describe(
          'Remote ref to base the new branch on when fromRemote=true (e.g. "origin/develop"). ' +
          'Defaults to the remote default branch auto-detected from the remote. ' +
          'Has no effect when fromRemote=false or create=false.',
        ),
    },
    async execute({ path, branch, create = false, fromRemote = true, base }, ctx) {
      try {
        const state = getState(ctx.sessionID)
        const resolved = resolvePath(path, ctx.directory, state.cwd)

        // If a worktree is already tracked in session state, allow it when it's the same path.
        if (state.worktree) {
          if (state.worktree.path === resolved) {
            return (
              `Worktree at ${resolved} on branch '${branch}' is already active. ` +
              `Active working directory is ${resolved}.`
            )
          }
          throw new Error(
            `A worktree is already active at ${state.worktree.path}. ` +
            `STOP — call use_clear (fields: ["cwd", "worktree"]) to remove it first, then call use_worktree again.`,
          )
        }

        const root = await resolveGitRoot($, gitRoot(state, ctx), resolved)

        // Guard: reject the repo root as the worktree destination — agents must use subdirectories.
        if (resolved === root) {
          throw new Error(
            `Cannot create a worktree at the repository root ('${root}'). ` +
            `Specify a subdirectory path instead, e.g. '${root}/.worktrees/${branch}'.`,
          )
        }

        // Pre-check: if the branch is already checked out at the repository root, fail early.
        // Any other existing sub-worktree path is fine (idempotency handles same-path reuse;
        // git will give its own error for genuine conflicts in other sub-worktrees).
        try {
          const listOutput = await $`git worktree list --porcelain`.cwd(root).quiet().text()
          for (const block of listOutput.trim().split('\n\n')) {
            const lines = block.split('\n')
            const wtPath = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length)
            const wtBranch = lines.find(l => l.startsWith('branch '))?.slice('branch '.length)
            if (wtBranch === `refs/heads/${branch}` && wtPath === root) {
              throw new Error(
                `Branch '${branch}' is checked out at the repository root ('${root}'). ` +
                `Working in the repo root is not permitted — use a worktree subdirectory. ` +
                `Switch the repo root to a different branch first, then call use_worktree again.`,
              )
            }
          }
        } catch (checkErr) {
          if (checkErr.message.includes('is checked out at the repository root')) throw checkErr
          // Ignore git list failures — git worktree add will error with its own message if needed.
        }

        // When creating from remote: detect the remote default branch (or use the caller-supplied base),
        // then fetch origin so the ref is current before creating the worktree.
        let remoteBase = null
        if (create && fromRemote) {
          if (base) {
            remoteBase = base
          } else {
            try {
              const raw = await $`git ls-remote --symref origin HEAD`.cwd(root).quiet().text()
              const match = raw.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)
              if (!match) throw new Error(`Unexpected ls-remote output: ${raw.trim()}`)
              remoteBase = `origin/${match[1]}`
            } catch (lsErr) {
              throw new Error(
                `Could not detect remote default branch: ${lsErr.stderr ?? lsErr.message}`,
              )
            }
          }
          try {
            await $`git fetch origin`.cwd(root).quiet()
          } catch (fetchErr) {
            throw new Error(`git fetch origin failed: ${fetchErr.stderr ?? fetchErr.message}`)
          }
        }

        try {
          if (create) {
            if (remoteBase) {
              await $`git worktree add -b ${branch} ${resolved} ${remoteBase}`.cwd(root).quiet()
            } else {
              await $`git worktree add -b ${branch} ${resolved}`.cwd(root).quiet()
            }
          } else {
            await $`git worktree add ${resolved} ${branch}`.cwd(root).quiet()
          }
        } catch (err) {
          const errMsg = err.stderr ?? err.message ?? ''
          // Idempotency: path already exists — check if it's a registered worktree for this branch.
          if (errMsg.includes('already exists')) {
            let crossRepoError = null
            try {
              const listOutput = await $`git worktree list --porcelain`.cwd(root).quiet().text()
              const isRegistered = listOutput.trim().split('\n\n').some(block => {
                const lines = block.split('\n')
                const wtPath = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length)
                const wtBranch = lines.find(l => l.startsWith('branch '))?.slice('branch '.length)
                return wtPath === resolved && wtBranch === `refs/heads/${branch}`
              })
              if (isRegistered) {
                // Guard: verify the registered worktree actually belongs to the expected repo.
                // A prior session may have placed a worktree from a *different* repo at this path
                // (cross-repo contamination). git worktree list from inside a linked worktree always
                // lists the main (primary) worktree first — compare its path against the expected root.
                try {
                  const wtListFromInside = await $`git worktree list --porcelain`.cwd(resolved).quiet().text()
                  const firstBlock = wtListFromInside.trim().split('\n\n')[0] ?? ''
                  const mainWtPath = firstBlock.split('\n').find(l => l.startsWith('worktree '))?.slice('worktree '.length)
                  if (mainWtPath && resolve(mainWtPath) !== resolve(root)) {
                    // Capture outside the inner try so it survives the outer catch {}.
                    crossRepoError = new Error(
                      `Worktree at ${resolved} is registered for branch '${branch}' but belongs to a different repository.\n` +
                      `  This session's repo:    ${resolve(root)}\n` +
                      `  Worktree's actual repo: ${resolve(mainWtPath)}\n` +
                      `This is cross-repo worktree contamination — a prior session likely placed this ` +
                      `worktree in the wrong directory. ` +
                      `Run \`git worktree remove ${resolved}\` from ${resolve(mainWtPath)} to clean it up, ` +
                      `then call use_worktree again.`,
                    )
                  } else {
                    state.cwd = resolved
                    state.worktree = { path: resolved, owned: false }
                    return (
                      `Worktree at ${resolved} on branch '${branch}' already exists — reusing it. ` +
                      `Active working directory set to ${resolved}.`
                    )
                  }
                } catch {
                  // Cannot verify repo root (git unavailable inside the worktree) — proceed optimistically.
                  state.cwd = resolved
                  state.worktree = { path: resolved, owned: false }
                  return (
                    `Worktree at ${resolved} on branch '${branch}' already exists — reusing it. ` +
                    `Active working directory set to ${resolved}.`
                  )
                }
              }
            } catch {
              // If worktree list fails, fall through to the original error.
            }
            if (crossRepoError) throw crossRepoError
          }
          throw new Error(`git worktree add failed: ${errMsg}`)
        }

        state.cwd = resolved
        state.worktree = { path: resolved, owned: true }

        const fromNote = remoteBase ? ` (from ${remoteBase})` : ''
        return (
          `Worktree created at ${resolved} on branch '${branch}'${fromNote}. ` +
          `Active working directory set to ${resolved}.`
        )
      } catch (err) {
        log('use_worktree failed', err)
        throw err
      }
    },
  })

  // -------------------------------------------------------------------------
  // use_clear — reset session context
  // -------------------------------------------------------------------------

  const useClear = tool({
    description:
      'Call this only after all todos for the current task have been marked complete. ' +
      'Reset one or more fields of the active session state (cwd, env, worktree). ' +
      'Omit fields to reset all three. Pass a subset to reset specific fields. ' +
      'Clearing "env" removes all direnv-loaded variables — they will no longer be prepended to bash commands. ' +
      'Worktrees created by use_worktree in this session are "owned" — clearing "worktree" removes them from disk ' +
      'with `git worktree remove`. Worktrees not created by this session are unowned and are NOT removed from disk. ' +
      'WARNING: clearing "worktree" alone does NOT reset the working directory. ' +
      'Because use_worktree sets cwd and worktree to the same path, ' +
      'you almost always want fields: ["cwd", "worktree"] together — ' +
      'clearing only "worktree" leaves bash commands pointing at the now-removed directory. ' +
      'Pass force=true to run `git worktree remove --force`, discarding uncommitted changes and untracked files; ' +
      'if the path is no longer registered with git ("not a working tree"), force=true clears the session reference without git removal. ' +
      'STOP if git worktree remove fails (uncommitted changes or untracked files) — ' +
      'clean up first, or call use_clear with force=true. ' +
      'Returns a newline-separated list of what was cleared, or "Nothing to clear".',
    args: {
      fields: tool.schema
        .array(tool.schema.enum(['cwd', 'env', 'worktree']))
        .optional()
        .describe('Specific fields to clear. Omit to clear all (cwd, env, worktree).'),
      force: tool.schema
        .boolean()
        .optional()
        .describe(
          'Pass --force to git worktree remove, discarding uncommitted changes and untracked files. ' +
          'If the path is no longer registered with git ("not a working tree"), clears the session reference without attempting removal. ' +
          'Default: false.',
        ),
    },
    async execute({ fields, force = false }, ctx) {
      try {
        const state = getState(ctx.sessionID)
        const toClear = fields ?? ['cwd', 'env', 'worktree']
        const results = []

        if (toClear.includes('worktree') && state.worktree) {
          if (state.worktree.owned) {
            const worktreePath = state.worktree.path
            const root = gitRoot(state, ctx)
            try {
              await (force
                ? $`git worktree remove --force ${worktreePath}`
                : $`git worktree remove ${worktreePath}`
              ).cwd(root).quiet()
              results.push(`Removed owned worktree at ${worktreePath}`)
            } catch (err) {
              const errMsg = err.stderr ?? err.message ?? ''
              if (force && errMsg.includes('is not a working tree')) {
                results.push(
                  `Cleared worktree reference (${worktreePath}) — not a registered git worktree; directory may still exist on disk`,
                )
              } else {
                throw new Error(
                  `Failed to remove worktree at ${worktreePath}. ` +
                  (force
                    ? `Git error: ${errMsg}`
                    : `It likely has uncommitted changes or untracked files. ` +
                      `Pass force=true to discard them, or clean up and call use_clear again. ` +
                      `Git error: ${errMsg}`),
                )
              }
            }
            // If cwd was pointing at the removed worktree, clear it to prevent
            // bash commands from targeting a now-removed directory.
            if (state.cwd === worktreePath) {
              state.cwd = null
              results.push(`Cleared working directory (was pointing at removed worktree)`)
            }
          } else {
            results.push(
              `Cleared worktree reference (${state.worktree.path}) — not owned by plugin, skipping git worktree remove`,
            )
          }
          state.worktree = null
        }

        if (toClear.includes('cwd') && state.cwd) {
          results.push(`Cleared working directory (was: ${state.cwd})`)
          state.cwd = null
        }

        if (toClear.includes('env') && (Object.keys(state.env).length > 0 || state.envSource)) {
          results.push(`Cleared environment (source was: ${state.envSource ?? 'manual'})`)
          state.env = {}
          state.envSource = null
        }

        return results.length > 0 ? results.join('\n') : 'Nothing to clear'
      } catch (err) {
        log('use_clear failed', err)
        throw err
      }
    },
  })

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------

  return {
    tool: {
      use_cwd: useCwd,
      use_direnv: useDirenv,
      use_worktree: useWorktree,
      use_clear: useClear,
    },

    /**
     * Cache each tool's workdir-capability (see `isWorkdirEligible`) and, for
     * any eligible tool, annotate its `workdir` parameter description so the
     * model sees, at parameter-fill time, that it does not need to set it.
     * This fires at every LLM call and is more authoritative than a
     * system-prompt hint because the model reads tool schemas while choosing
     * parameter values.
     */
    'tool.definition': async ({ toolID }, output) => {
      try {
        if (SELF_TOOL_IDS.has(toolID)) return

        const eligible = isWorkdirEligible(output.parameters)
        const previouslyRecorded = workdirCapable.get(toolID)
        workdirCapable.set(toolID, eligible)
        if (previouslyRecorded === undefined || previouslyRecorded !== eligible) {
          log(`workdir-capability: ${toolID} => ${eligible}`)
        }
        if (!eligible) return

        const workdirProp = output.parameters.properties.workdir
        if (workdirProp.description?.includes(WORKDIR_ANNOTATION)) return
        workdirProp.description = (workdirProp.description ?? '') + WORKDIR_ANNOTATION
      } catch (err) {
        log('tool.definition failed', err)
      }
    },

    /**
     * Intercept every tool call whose schema was cached as workdir-capable
     * (see `tool.definition` above) to inject the session's active cwd.
     *
     * Layer 1 (env, `bash`-only): prepend `export K=V && ...` to the command
     *   string — only `bash` has a shell `command` string to prepend to.
     * Layer 2 (workdir, any eligible tool): set output.args.workdir — the
     *   process-level working directory for the call. Only set when the
     *   agent did not pass workdir explicitly.
     */
    'tool.execute.before': async (input, output) => {
      try {
        if (!output.args) return
        const state = sessions.get(input.sessionID)
        if (!state) return

        if (input.tool === 'bash') {
          const envPrefix = buildEnvExports(state.env)
          if (envPrefix) {
            output.args.command = `${envPrefix} && ${output.args.command}`
          }
        }

        // `bash` always qualifies, independent of the schema-detection cache:
        // its real, live-converted schema does not reliably match the
        // eligibility predicate's assumed shape (verified empirically after
        // a live regression — see design.md decision #1 correction), so
        // gating bash's own injection on `workdirCapable` silently broke it.
        // Any other tool must still be positively confirmed eligible.
        const cachedEligibility = workdirCapable.get(input.tool)
        const eligibleForInjection = input.tool === 'bash' || cachedEligibility === true

        // Diagnostic logging: only meaningful when there is an active
        // working directory to potentially inject — silent otherwise.
        if (state.cwd) {
          if (output.args.workdir) {
            log(`workdir-injection: ${input.tool} skipped (explicit workdir already set)`)
          } else if (eligibleForInjection) {
            output.args.workdir = state.cwd
            log(`workdir-injection: ${input.tool} => ${state.cwd}`)
          } else {
            log(`workdir-injection: ${input.tool} skipped (not recorded as workdir-capable; cached=${cachedEligibility})`)
          }
        }
      } catch (err) {
        // Never propagate — do not break the tool execution pipeline
        log('tool.execute.before failed', err)
      }
    },

    /**
     * Inject the active session context into the system prompt so that
     * tools with no `workdir` parameter (read, write, edit, glob, grep)
     * resolve file paths correctly.
     *
     * NOTE: any tool cached as workdir-capable (including `bash`) receives
     * workdir injection automatically via tool.execute.before; `bash` also
     * receives env injection. Models write clean calls; the plugin injects
     * context silently. An explicit workdir set by the model is honored for
     * that one call only (see !output.args.workdir guard).
     */
    'experimental.chat.system.transform': async (input, output) => {
      try {
        const sessionID = input.sessionID
        if (!sessionID) return
        const state = sessions.get(sessionID)
        if (!state) return

        const lines = []
        if (state.cwd) {
          lines.push(
            `- **Working directory**: \`${state.cwd}\` — automatically set as \`workdir\` on every eligible tool call`,
          )
        }
        if (state.envSource) {
          const count = Object.keys(state.env).length
          lines.push(
            `- **Environment** (${count} variable(s) from ${state.envSource})` +
            ` — automatically prepended to every bash command as \`export VAR=val\``,
          )
        }
        if (state.worktree) {
          lines.push(`- **Active worktree**: \`${state.worktree.path}\``)
        }

        if (lines.length > 0) {
          output.system.push(
            [
              '## Active Session Context (opencode-use)',
              '',
              'The following are **automatically injected into every tool call that accepts a `workdir` parameter**',
              '(including `bash`) by the plugin. Write clean calls — do not add these yourself:',
              '',
              ...lines,
              '',
              'Note: tool calls in your context may show a `workdir` value (and, for `bash`, `export …` statements).',
              'Those were added by the plugin after execution, not written by you.',
              'Your next call to a tool that accepts a `workdir` parameter will receive the same treatment automatically.',
              '',
              'Override: if you intentionally need a **different** directory for one specific call,',
              `set \`workdir\` explicitly — your value will be used for that call only.`,
              '',
              'For tools with no `workdir` parameter (e.g. read, write, edit, glob, grep): construct absolute paths using the working directory above.',
            ].join('\n'),
          )
        }
      } catch (err) {
        log('chat.system.transform failed', err)
      }
    },
  }
}
