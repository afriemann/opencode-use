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
 * Choose the best base directory for git operations.
 * Priority: state.cwd (user's explicit choice) → ctx.worktree (session git root) → ctx.directory.
 * This handles the common case where opencode is opened from ~ (not a git repo) but the
 * user has called use_cwd to point at a git repo first.
 */
function gitRoot(state, ctx) {
  return state.cwd ?? ctx.worktree ?? ctx.directory
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
      'The plugin automatically injects this as workdir into every bash call via tool.execute.before — ' +
      'you do NOT need to pass workdir to bash calls yourself; doing so is redundant. ' +
      'Non-bash tools (read, write, edit, glob, grep) receive this path in the system prompt — ' +
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
      'Pass an existing branch name (create=false, default), or pass create=true to create a new branch with `git worktree add -b`. ' +
      'The target path must not already exist as a directory. ' +
      'Relative paths resolve against the project directory first, then the current active working directory as fallback. ' +
      'Git operations run against state.cwd if set (e.g. from a prior use_cwd call), ' +
      'falling back to the session git root and then the project directory — ' +
      'call use_cwd with the target repo path first if opencode was opened outside a git repo. ' +
      'STOP if a worktree is already active for this session — ' +
      'call use_clear (fields: ["cwd", "worktree"]) to remove it first, then call use_worktree again. ' +
      'Sets the active working directory to the new worktree path AND records it so use_clear can remove it from disk later. ' +
      'Returns: "Worktree created at <path> on branch \'<branch>\'. Active working directory set to <path>."',
    args: {
      path: tool.schema.string().describe('Path where the new worktree directory will be created (must not already exist)'),
      branch: tool.schema
        .string()
        .describe('Branch to check out in the worktree (must exist unless create=true)'),
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
            `STOP — call use_clear (fields: ["cwd", "worktree"]) to remove it first, then call use_worktree again.`,
          )
        }

        const resolved = resolvePath(path, ctx.directory, state.cwd)
        const root = gitRoot(state, ctx)

        try {
          if (create) {
            await $`git worktree add -b ${branch} ${resolved}`.cwd(root).quiet()
          } else {
            await $`git worktree add ${resolved} ${branch}`.cwd(root).quiet()
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
      'Reset one or more fields of the active session state (cwd, env, worktree). ' +
      'Omit fields to reset all three. Pass a subset to reset specific fields. ' +
      'Worktrees created by use_worktree in this session are "owned" — clearing "worktree" removes them from disk ' +
      'with `git worktree remove` (no --force). Worktrees not created by this session are unowned and are NOT removed from disk. ' +
      'WARNING: clearing "worktree" alone does NOT reset the working directory. ' +
      'Because use_worktree sets cwd and worktree to the same path, ' +
      'you almost always want fields: ["cwd", "worktree"] together — ' +
      'clearing only "worktree" leaves bash commands pointing at the now-removed directory. ' +
      'STOP if git worktree remove fails (uncommitted changes or untracked files) — ' +
      'clean up the worktree first, then call use_clear again. ' +
      'Returns a newline-separated list of what was cleared, or "Nothing to clear".',
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
            const root = gitRoot(state, ctx)
            try {
              await $`git worktree remove ${worktreePath}`.cwd(root).quiet()
              results.push(`Removed owned worktree at ${worktreePath}`)
            } catch (err) {
              throw new Error(
                `Failed to remove worktree at ${worktreePath}. ` +
                `It likely has uncommitted changes or untracked files. ` +
                `Clean up or stash changes first, then call use_clear again. ` +
                `Git error: ${err.stderr ?? err.message}`,
              )
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
     * Intercept every bash tool call to inject the session's active env and cwd.
     *
     * Layer 1 (env): prepend `export K=V && ...` to the command string.
     * Layer 2 (cwd): set output.args.workdir — the process-level working directory
     *   for the bash invocation. Only set when the agent did not pass workdir explicitly.
     */
    /**
     * Annotate the bash tool's `workdir` parameter schema so the model sees,
     * at parameter-fill time, that it must not use workdir when this plugin is active.
     * This fires at every LLM call and is more authoritative than a system-prompt hint
     * because the model reads tool schemas while choosing parameter values.
     */
    'tool.definition': async ({ toolID }, output) => {
      try {
        if (toolID !== 'bash') return
        const workdirProp = output.parameters?.properties?.workdir
        if (!workdirProp) return
        workdirProp.description =
          (workdirProp.description ?? '') +
          ' When "## Active Session Context (opencode-use)" is present in your system prompt,' +
          ' the active working directory is injected into this parameter automatically by the plugin' +
          ' before the call executes — you do not need to set it.' +
          ' Previous bash calls in your context may show a workdir value; that was injected by the' +
          ' plugin after you submitted the call, not set by you — write your next call without it.' +
          ' Exception: set this explicitly if you intentionally need a different directory for this' +
          ' one specific call — your value will be honored for that call only.'
      } catch (err) {
        log('tool.definition failed', err)
      }
    },

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
     *
     * NOTE: bash calls receive workdir and env injection automatically via tool.execute.before.
     * Models write clean bash calls; the plugin injects context silently. An explicit workdir
     * set by the model is honored for that one call only (see !output.args.workdir guard).
     */
    'experimental.chat.system.transform': async (input, output) => {
      try {
        const sessionID = input.sessionID
        if (!sessionID) return
        const state = sessions.get(sessionID)
        if (!state) return

        const lines = []
        if (state.cwd) {
          lines.push(`- **Working directory**: \`${state.cwd}\` — automatically set as \`workdir\` on every bash call`)
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
              'The following are **automatically injected into every bash call** by the plugin.',
              'Write clean commands — do not add these yourself:',
              '',
              ...lines,
              '',
              'Note: bash calls in your context may show `workdir` and `export …` statements.',
              'Those were added by the plugin after execution, not written by you.',
              'Your next bare `bash(command="…")` call will receive the same treatment automatically.',
              '',
              'Override: if you intentionally need a **different** directory for one specific bash call,',
              `set \`workdir\` explicitly — your value will be used for that call only.`,
              '',
              'For read, write, edit, glob, grep: construct absolute paths using the working directory above.',
            ].join('\n'),
          )
        }
      } catch (err) {
        log('chat.system.transform failed', err)
      }
    },
  }
}
