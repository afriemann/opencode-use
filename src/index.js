import { tool } from '@opencode-ai/plugin'
import { resolve, isAbsolute } from 'node:path'
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
      'All subsequent bash commands will run in this directory. ' +
      'Non-bash tools (read, write, edit, glob, grep) also receive this path via the system prompt ' +
      'so they resolve file paths correctly. ' +
      'Relative paths are resolved against the project directory first, ' +
      'then the current active working directory as fallback. ' +
      'Returns the resolved absolute path.',
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
      'Load environment variables from a direnv .envrc file in the given directory into the session. ' +
      'Runs `direnv export json` to capture the environment delta. ' +
      'IMPORTANT: if the .envrc is blocked (not yet allowed by direnv), ' +
      'you MUST stop and ask the user to run `direnv allow <path>` before calling this again — ' +
      'do not proceed without user approval. ' +
      'Optional changeCwd (default false): also set the active working directory to the given path. ' +
      'Returns a summary of loaded variable names.',
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
      'The branch argument is required. ' +
      'Pass create=true to create a new branch with `git worktree add -b`; ' +
      'otherwise the branch must already exist. ' +
      'Fails if a worktree is already active for this session — call use_clear first. ' +
      'Relative paths are resolved against the project directory first. ' +
      'Sets both the active working directory and the session worktree context. ' +
      'Returns the resolved worktree path.',
    args: {
      path: tool.schema.string().describe('Path where the new worktree directory will be created'),
      branch: tool.schema
        .string()
        .describe('Branch to check out in the worktree (must exist, unless create=true)'),
      create: tool.schema
        .boolean()
        .optional()
        .describe('Create a new branch with -b. Default: false'),
    },
    async execute({ path, branch, create = false }, ctx) {
      try {
        const state = getState(ctx.sessionID)

        if (state.worktree) {
          throw new Error(
            `A worktree is already active at ${state.worktree.path}. ` +
            `Call use_clear (fields: ["worktree"]) to remove it before creating a new one.`,
          )
        }

        const resolved = resolvePath(path, ctx.directory, state.cwd)
        const gitRoot = ctx.worktree ?? ctx.directory

        try {
          if (create) {
            await $`git worktree add -b ${branch} ${resolved}`.cwd(gitRoot).quiet()
          } else {
            await $`git worktree add ${resolved} ${branch}`.cwd(gitRoot).quiet()
          }
        } catch (err) {
          throw new Error(`git worktree add failed: ${err.stderr ?? err.message}`)
        }

        state.cwd = resolved
        state.worktree = { path: resolved, owned: true }

        return (
          `Worktree created at ${resolved} on branch '${branch}'. ` +
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
      'Clear session context. ' +
      'Omit fields to clear everything (cwd, env, worktree). ' +
      'Pass fields to clear specific parts only. ' +
      'Clearing an owned worktree runs `git worktree remove` without --force. ' +
      'If the worktree has uncommitted changes or untracked files, this fails loudly — ' +
      'clean up or stash changes first, then call use_clear again.',
    args: {
      fields: tool.schema
        .array(tool.schema.enum(['cwd', 'env', 'worktree']))
        .optional()
        .describe('Specific fields to clear. Omit to clear all (cwd, env, worktree).'),
    },
    async execute({ fields }, ctx) {
      try {
        const state = getState(ctx.sessionID)
        const toClear = fields ?? ['cwd', 'env', 'worktree']
        const results = []

        if (toClear.includes('worktree') && state.worktree) {
          if (state.worktree.owned) {
            const worktreePath = state.worktree.path
            const gitRoot = ctx.worktree ?? ctx.directory
            try {
              await $`git worktree remove ${worktreePath}`.cwd(gitRoot).quiet()
              results.push(`Removed owned worktree at ${worktreePath}`)
            } catch (err) {
              throw new Error(
                `Failed to remove worktree at ${worktreePath}. ` +
                `It likely has uncommitted changes or untracked files. ` +
                `Clean up or stash changes first, then call use_clear again. ` +
                `Git error: ${err.stderr ?? err.message}`,
              )
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
     * Intercept every bash tool call to inject the session's active env and cwd.
     *
     * Layer 1 (env): prepend `export K=V && ...` to the command string.
     * Layer 2 (cwd): set output.args.workdir — the process-level working directory
     *   for the bash invocation. Only set when the agent did not pass workdir explicitly.
     */
    'tool.execute.before': async (input, output) => {
      try {
        if (input.tool !== 'bash') return
        const state = sessions.get(input.sessionID)
        if (!state) return

        const envPrefix = buildEnvExports(state.env)
        if (envPrefix) {
          output.args.command = `${envPrefix} && ${output.args.command}`
        }

        if (state.cwd && !output.args.workdir) {
          output.args.workdir = state.cwd
        }
      } catch (err) {
        // Never propagate — do not break the bash execution pipeline
        log('tool.execute.before failed', err)
      }
    },

    /**
     * Inject the active session context into the system prompt so that
     * non-bash tools (read, write, edit, glob, grep) resolve file paths correctly.
     */
    'experimental.chat.system.transform': async (input, output) => {
      try {
        const sessionID = input.sessionID
        if (!sessionID) return
        const state = sessions.get(sessionID)
        if (!state) return

        const lines = []
        if (state.cwd) lines.push(`- Working directory: \`${state.cwd}\``)
        if (state.envSource) lines.push(`- Active environment: ${state.envSource}`)
        if (state.worktree) lines.push(`- Active worktree: \`${state.worktree.path}\``)

        if (lines.length > 0) {
          output.system.push(
            [
              '## Active Session Context (opencode-use)',
              'Use the paths below when resolving files for read, write, edit, glob, and grep tools:',
              ...lines,
            ].join('\n'),
          )
        }
      } catch (err) {
        log('chat.system.transform failed', err)
      }
    },
  }
}
