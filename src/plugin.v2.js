// src/plugin.v2.js — opencode-use, V2 plugin entrypoint
//
// V2 port of plugin.v1.js. Business logic (tool execute bodies, git/worktree
// helpers in lib.js) is reused unchanged — only the registration and hook
// wiring differs, per the V1→V2 API shapes:
//   V1 hook                                V2 equivalent
//   tool map                               ctx.tool.transform(editor.add(...))
//   tool.definition                        ctx.tool.transform(editor.update(...)) + reload on catalog changes
//   tool.execute.before                    ctx.tool.hook("execute.before", ...)
//   shell.env                              ctx.shell.hook("create.before", ...)
//   experimental.chat.system.transform      ctx.session.hook("context", ...)
//
// Known simplifications versus V1 (documented, not silent):
//   - V2 tool schemas are uniformly JSON Schema; V1's Zod/`parameters.shape`
//     detection branches in resolveWorkdirEligibility are dropped as
//     unnecessary — V2 has exactly one schema shape to inspect.
//   - Tool execute bodies use `directory` captured once from
//     `ctx.location.directory` at setup time, in place of V1's per-call
//     `ctx.directory`/`ctx.worktree`. `ctx.location` describes "where this
//     plugin instance loaded" (stable for the plugin's lifetime), not a
//     per-call value — acceptable since a V2 plugin instance is scoped to
//     one project already.
//   - Tool-eligibility re-scanning: registered to re-run via `ctx.tool.reload()`
//     whenever a `catalog.updated` event fires (observed empirically to fire
//     on MCP server connect), keeping newly-appeared tools (e.g. MCP tools)
//     covered without requiring a session restart.

import { Plugin } from '@opencode/plugin'
import { resolve, isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  resolveGitRoot,
  listWorktrees,
  applyDirectoryChange,
} from './lib.js'

// ---------------------------------------------------------------------------
// Session state (keyed by sessionID, same shape as V1)
// ---------------------------------------------------------------------------

/** @type {Map<string, { cwd: string|null, env: Record<string,string>, envSource: string|null, worktree: { path: string, owned: boolean }|null, agentsMd: null }>} */
const sessions = new Map()

function getState(sessionID) {
  if (!sessions.has(sessionID)) {
    sessions.set(sessionID, { cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null })
  }
  return sessions.get(sessionID)
}

const SELF_TOOL_NAMES = new Set(['use_cwd', 'use_direnv', 'use_worktree', 'use_clear'])

const WORKDIR_ANNOTATION =
  ' When "## Active Session Context (opencode-use)" is present in your system prompt,' +
  ' this parameter is auto-populated by the plugin before this tool call executes —' +
  ' you do not need to set it.' +
  ' A workdir value shown on a previous call in your context was injected by the' +
  ' plugin after you submitted that call, not set by you — write your next call without it.' +
  ' Exception: set this explicitly if you intentionally need a different directory for this' +
  ' one specific call — your value will be honored for that call only.'

/**
 * V2-simplified eligibility check: V2 tool schemas are always JSON Schema
 * (`Tool.Info.input`), so this only needs the single check V1 used for its
 * `jsonSchema`/`parameters` (JSON-Schema-shaped) sources.
 */
function isEligibleWorkdirSchema(input) {
  const prop = input?.properties?.workdir
  if (!prop) return false
  if (prop.type !== 'string') return false
  if ('enum' in prop) return false
  const required = input?.required
  if (Array.isArray(required) && required.includes('workdir')) return false
  return true
}

function annotateWorkdirSchema(input) {
  const prop = input.properties.workdir
  if (prop.description?.includes(WORKDIR_ANNOTATION)) return
  prop.description = (prop.description ?? '') + WORKDIR_ANNOTATION
}

// ---------------------------------------------------------------------------
// Path/env helpers (unchanged from V1)
// ---------------------------------------------------------------------------

function expandHome(inputPath) {
  if (inputPath === '~') return homedir()
  if (inputPath.startsWith('~/')) return resolve(homedir(), inputPath.slice(2))
  return inputPath
}

function resolvePath(inputPath, baseDirectory, stateCwd) {
  const expanded = expandHome(inputPath)
  if (isAbsolute(expanded)) return expanded
  if (baseDirectory) return resolve(baseDirectory, expanded)
  if (stateCwd) return resolve(stateCwd, expanded)
  throw new Error(`Cannot resolve relative path '${inputPath}': no base directory available`)
}

function withNotes(primary, notes) {
  return notes.length > 0 ? [primary, ...notes].join('\n') : primary
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_KEY_DENYLIST = new Set(['PWD', 'OLDPWD'])
const ENV_KEY_DENY_PREFIX = 'DIRENV_'

function isInjectableEnvKey(key) {
  if (!ENV_NAME_PATTERN.test(key)) return false
  if (ENV_KEY_DENYLIST.has(key)) return false
  if (key.startsWith(ENV_KEY_DENY_PREFIX)) return false
  return true
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: 'opencode-use',
  async setup(ctx) {
    const directory = ctx.location.directory
    const log = (message, err, level = err ? 'error' : 'info') => {
      const detail = err ? `: ${err instanceof Error ? (err.stack ?? err.message) : err}` : ''
      // V2 has no documented client.app.log equivalent in this ctx surface;
      // fall back directly to stderr (matching V1's own fallback path).
      process.stderr.write(`[opencode-use] ${message}${detail}\n`)
    }

    function gitRootFor(state) {
      return state.cwd ?? directory
    }

    // -------------------------------------------------------------------
    // Tool registration + workdir-eligibility annotation
    // -------------------------------------------------------------------

    /** @type {Map<string, boolean>} keyed by effective tool id */
    const workdirCapable = new Map()

    function scanAndAnnotate(editor) {
      for (const t of editor.list()) {
        if (SELF_TOOL_NAMES.has(t.id)) continue
        const eligible = isEligibleWorkdirSchema(t.input)
        const previouslyRecorded = workdirCapable.get(t.id)
        workdirCapable.set(t.id, eligible)
        if (previouslyRecorded === undefined || previouslyRecorded !== eligible) {
          log(`workdir-capability: ${t.id} => ${eligible}`)
        }
        if (!eligible) continue
        editor.update(t.id, (tool) => {
          annotateWorkdirSchema(tool.input)
        })
      }
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'use_cwd',
        description:
          'Set the active working directory for this session. ' +
          'The plugin automatically injects this as workdir into every tool call that accepts a ' +
          'workdir parameter (including bash) via the tool execute.before hook — ' +
          'you do NOT need to pass workdir to such calls yourself; doing so is redundant. ' +
          'Tools with no workdir parameter (read, write, edit, glob, grep) receive this path in the system prompt — ' +
          'use it as the base when constructing file paths for those tools. ' +
          'Relative paths resolve against the project directory first, ' +
          'then the current active working directory as fallback. ' +
          'Path must exist and be a directory. ' +
          "Returns: \"Working directory set to: <resolved-path>\".",
        input: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute or relative path to set as the working directory (a leading ~ or ~/... expands to the home directory)' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        async execute(input, context) {
          try {
            const state = getState(context.sessionID)
            const resolved = resolvePath(input.path, directory, state.cwd)
            const info = await stat(resolved)
            if (!info.isDirectory()) throw new Error(`Not a directory: ${resolved}`)
            const { notes } = await applyDirectoryChange(Bun.$, state, resolved, log)
            return { content: withNotes(`Working directory set to: ${resolved}`, notes) }
          } catch (err) {
            log('use_cwd failed', err)
            throw err
          }
        },
      })

      editor.add({
        name: 'use_direnv',
        description:
          'Load environment variables from a direnv .envrc file in the given directory. ' +
          'Runs `direnv export json` to capture the environment delta. Requires direnv on PATH. ' +
          'REPLACES any previously loaded environment. ' +
          'This tool only loads the environment — it never changes the working directory.',
        input: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory containing the .envrc file to load (a leading ~ or ~/... expands to the home directory)' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        async execute(input, context) {
          try {
            const state = getState(context.sessionID)
            const resolved = resolvePath(input.path, directory, state.cwd)

            let stdout
            try {
              stdout = await Bun.$`direnv export json`.cwd(resolved).quiet().text()
            } catch (err) {
              const stderr = err.stderr ?? ''
              if (stderr.includes('is blocked') || stderr.includes('direnv allow') || stderr.includes('not allowed')) {
                throw new Error(
                  `The .envrc at ${resolved} is not allowed by direnv. ` +
                  `STOP — ask the user to approve it, then run: direnv allow ${resolved} ` +
                  `Once allowed, call use_direnv again.`,
                )
              }
              if (err.code === 'ENOENT') throw new Error('direnv is not installed or not on PATH')
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

            const names = Object.keys(envDelta)
            return {
              content: names.length > 0
                ? `Loaded ${names.length} variable(s): ${names.join(', ')}`
                : 'direnv loaded — no environment changes exported',
            }
          } catch (err) {
            log('use_direnv failed', err)
            throw err
          }
        },
      })

      editor.add({
        name: 'use_worktree',
        description:
          'Create a git worktree and set it as the active working directory for this session. ' +
          'Pass an existing branch name (create=false, default), or pass create=true to create a new branch. ' +
          'Idempotent: if the worktree at the given path is already registered for the given branch, it is reused.',
        input: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path where the worktree directory will be created (or already exists)' },
            branch: { type: 'string', description: 'Branch to check out in the worktree (must exist unless create=true)' },
            create: { type: 'boolean', description: 'Create a new branch with -b. Default: false' },
            fromRemote: { type: 'boolean', description: 'When create=true, fetch from origin and base on the remote default branch. Default: true' },
            base: { type: 'string', description: 'Remote ref to base the new branch on when fromRemote=true' },
          },
          required: ['path', 'branch'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { path, branch, create = false, fromRemote = true, base } = input
          try {
            const state = getState(context.sessionID)
            const resolved = resolvePath(path, directory, state.cwd)

            if (state.worktree) {
              if (state.worktree.path === resolved) {
                const { notes } = await applyDirectoryChange(Bun.$, state, resolved, log)
                let repoRoot = resolved
                try {
                  repoRoot = (await listWorktrees(Bun.$, resolved))[0]?.path ?? resolved
                } catch { /* best-effort */ }
                return {
                  content: withNotes(
                    `Worktree at ${resolved} on branch '${branch}' is already active. ` +
                    `Active working directory is ${resolved}. Repository root: ${repoRoot}.`,
                    notes,
                  ),
                }
              }
              throw new Error(
                `A worktree is already active at ${state.worktree.path}. ` +
                `STOP — call use_clear (fields: ["cwd", "worktree"]) to remove it first, then call use_worktree again.`,
              )
            }

            const root = await resolveGitRoot(Bun.$, gitRootFor(state), resolved)

            if (resolved === root) {
              throw new Error(
                `Cannot create a worktree at the repository root ('${root}'). ` +
                `Specify a subdirectory path instead, e.g. '${root}/.worktrees/${branch}'.`,
              )
            }

            let remoteBase = null
            if (create && fromRemote) {
              if (base) {
                remoteBase = base
              } else {
                try {
                  const raw = await Bun.$`git ls-remote --symref origin HEAD`.cwd(root).quiet().text()
                  const match = raw.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)
                  if (!match) throw new Error(`Unexpected ls-remote output: ${raw.trim()}`)
                  remoteBase = `origin/${match[1]}`
                } catch (lsErr) {
                  throw new Error(`Could not detect remote default branch: ${lsErr.stderr ?? lsErr.message}`)
                }
              }
              try {
                await Bun.$`git fetch origin`.cwd(root).quiet()
              } catch (fetchErr) {
                throw new Error(`git fetch origin failed: ${fetchErr.stderr ?? fetchErr.message}`)
              }
            }

            try {
              if (create) {
                if (remoteBase) {
                  await Bun.$`git worktree add -b ${branch} ${resolved} ${remoteBase}`.cwd(root).quiet()
                } else {
                  await Bun.$`git worktree add -b ${branch} ${resolved}`.cwd(root).quiet()
                }
              } else {
                await Bun.$`git worktree add ${resolved} ${branch}`.cwd(root).quiet()
              }
            } catch (err) {
              const errMsg = err.stderr ?? err.message ?? ''

              if (create && errMsg.includes(`a branch named '${branch}' already exists`)) {
                let registeredAt = null
                try {
                  const worktrees = await listWorktrees(Bun.$, root)
                  registeredAt = worktrees.find(wt => wt.branch === `refs/heads/${branch}`)?.path ?? null
                } catch { /* fall through */ }

                if (registeredAt && registeredAt !== resolved) {
                  throw new Error(
                    `Branch '${branch}' already exists and is checked out at a different worktree ` +
                    `(${registeredAt}). Call use_worktree with path=${registeredAt}, branch=${branch}, create: false to reuse it.`,
                  )
                }
                if (!registeredAt) {
                  try {
                    await Bun.$`git worktree add ${resolved} ${branch}`.cwd(root).quiet()
                  } catch (retryErr) {
                    throw new Error(`git worktree add failed: ${retryErr.stderr ?? retryErr.message}`)
                  }
                  state.worktree = { path: resolved, owned: true }
                  const { notes } = await applyDirectoryChange(Bun.$, state, resolved, log)
                  return {
                    content: withNotes(
                      `Worktree created at ${resolved} on branch '${branch}' (existing branch checked out). ` +
                      `Active working directory set to ${resolved}. Repository root: ${root}.`,
                      notes,
                    ),
                  }
                }
              }

              if (errMsg.includes('already exists')) {
                let crossRepoError = null
                try {
                  const worktrees = await listWorktrees(Bun.$, root)
                  const isRegistered = worktrees.some(wt => wt.path === resolved && wt.branch === `refs/heads/${branch}`)
                  if (isRegistered) {
                    try {
                      const mainWtPath = (await listWorktrees(Bun.$, resolved))[0]?.path
                      if (mainWtPath && resolve(mainWtPath) !== resolve(root)) {
                        crossRepoError = new Error(
                          `Worktree at ${resolved} is registered for branch '${branch}' but belongs to a different repository.\n` +
                          `  This session's repo:    ${resolve(root)}\n` +
                          `  Worktree's actual repo: ${resolve(mainWtPath)}\n` +
                          `Run \`git worktree remove ${resolved}\` from ${resolve(mainWtPath)} to clean it up, then call use_worktree again.`,
                        )
                      } else {
                        state.worktree = { path: resolved, owned: false }
                        const { notes } = await applyDirectoryChange(Bun.$, state, resolved, log)
                        return {
                          content: withNotes(
                            `Worktree at ${resolved} on branch '${branch}' already exists — reusing it. ` +
                            `Active working directory set to ${resolved}. Repository root: ${root}.`,
                            notes,
                          ),
                        }
                      }
                    } catch {
                      state.worktree = { path: resolved, owned: false }
                      const { notes } = await applyDirectoryChange(Bun.$, state, resolved, log)
                      return {
                        content: withNotes(
                          `Worktree at ${resolved} on branch '${branch}' already exists — reusing it. ` +
                          `Active working directory set to ${resolved}. Repository root: ${root}.`,
                          notes,
                        ),
                      }
                    }
                  }
                } catch { /* fall through to raw error */ }
                if (crossRepoError) throw crossRepoError
              }
              throw new Error(`git worktree add failed: ${errMsg}`)
            }

            state.worktree = { path: resolved, owned: true }
            const { notes } = await applyDirectoryChange(Bun.$, state, resolved, log)
            const fromNote = remoteBase ? ` (from ${remoteBase})` : ''
            return {
              content: withNotes(
                `Worktree created at ${resolved} on branch '${branch}'${fromNote}. ` +
                `Active working directory set to ${resolved}. Repository root: ${root}.`,
                notes,
              ),
            }
          } catch (err) {
            log('use_worktree failed', err)
            throw err
          }
        },
      })

      editor.add({
        name: 'use_clear',
        description:
          'Reset one or more fields of the active session state (cwd, env, worktree). ' +
          'Omit fields to reset all three. ' +
          'Worktrees created by use_worktree in this session are "owned" — clearing "worktree" removes them from disk. ' +
          'Pass force=true to discard uncommitted changes and untracked files during removal.',
        input: {
          type: 'object',
          properties: {
            fields: { type: 'array', items: { type: 'string', enum: ['cwd', 'env', 'worktree'] }, description: 'Specific fields to clear. Omit to clear all.' },
            force: { type: 'boolean', description: 'Discard uncommitted changes/untracked files during worktree removal. Default: false.' },
          },
          additionalProperties: false,
        },
        async execute(input, context) {
          const { fields, force = false } = input
          try {
            const state = getState(context.sessionID)
            const toClear = fields ?? ['cwd', 'env', 'worktree']
            const results = []

            if (toClear.includes('worktree') && state.worktree) {
              if (state.worktree.owned) {
                const worktreePath = state.worktree.path
                const root = gitRootFor(state)
                try {
                  await (force
                    ? Bun.$`git worktree remove --force ${worktreePath}`
                    : Bun.$`git worktree remove ${worktreePath}`
                  ).cwd(root).quiet()
                  results.push(`Removed owned worktree at ${worktreePath}`)
                } catch (err) {
                  const errMsg = err.stderr ?? err.message ?? ''
                  if (force && errMsg.includes('is not a working tree')) {
                    results.push(`Cleared worktree reference (${worktreePath}) — not a registered git worktree; directory may still exist on disk`)
                  } else {
                    throw new Error(
                      `Failed to remove worktree at ${worktreePath}. ` +
                      (force ? `Git error: ${errMsg}` : `It likely has uncommitted changes or untracked files. Pass force=true, or clean up first. Git error: ${errMsg}`),
                    )
                  }
                }
                if (state.cwd === worktreePath) {
                  state.cwd = null
                  results.push(`Cleared working directory (was pointing at removed worktree)`)
                }
              } else {
                results.push(`Cleared worktree reference (${state.worktree.path}) — not owned by plugin, skipping git worktree remove`)
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

            return { content: results.length > 0 ? results.join('\n') : 'Nothing to clear' }
          } catch (err) {
            log('use_clear failed', err)
            throw err
          }
        },
      })

      scanAndAnnotate(editor)
    })

    // Re-scan for newly-appeared tools (e.g. MCP tools connecting after
    // setup) whenever the catalog changes — observed empirically to fire a
    // `catalog.updated` event on MCP server connect.
    const catalogWatcher = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: catalogWatcher.signal })) {
          if (event.type === 'catalog.updated') {
            await ctx.tool.reload()
          }
        }
      } catch {
        // Aborted on plugin unload — expected, not an error.
      }
    })()

    // -------------------------------------------------------------------
    // tool.execute.before equivalent — inject session cwd as workdir
    // -------------------------------------------------------------------

    await ctx.tool.hook('execute.before', (event) => {
      try {
        if (typeof event.input !== 'object' || event.input === null) return
        const state = sessions.get(event.sessionID)
        if (!state) return

        const cachedEligibility = workdirCapable.get(event.tool)
        // V2 renamed the built-in bash tool to "shell" (confirmed empirically
        // via real V2 logs: "workdir-injection: shell skipped...").
        const eligibleForInjection = event.tool === 'shell' || cachedEligibility === true

        if (state.cwd) {
          if (event.input.workdir) {
            log(`workdir-injection: ${event.tool} skipped (explicit workdir already set)`)
          } else if (eligibleForInjection) {
            event.input.workdir = state.cwd
            log(`workdir-injection: ${event.tool} => ${state.cwd}`)
          } else {
            log(`workdir-injection: ${event.tool} skipped (not recorded as workdir-capable; cached=${cachedEligibility})`)
          }
        }
      } catch (err) {
        log('tool.execute.before failed', err)
      }
    })

    // -------------------------------------------------------------------
    // shell.env equivalent
    // -------------------------------------------------------------------

    await ctx.shell.hook('create.before', (event) => {
      try {
        // V2's ShellCreateBefore has no documented sessionID field (unlike
        // V1's shell.env input); apply the most recently active session's
        // env as a best-effort substitute when exactly one session is live.
        // With multiple concurrent sessions this may apply the wrong
        // session's env — a known limitation versus V1, which had a
        // per-invocation sessionID to key off precisely.
        if (sessions.size !== 1) return
        const [state] = sessions.values()

        const injectable = {}
        for (const [key, value] of Object.entries(state.env)) {
          if (isInjectableEnvKey(key)) injectable[key] = value
        }
        if (Object.keys(injectable).length === 0) return

        Object.assign(event.env, injectable)
      } catch (err) {
        log('shell.env failed', err)
      }
    })

    // -------------------------------------------------------------------
    // experimental.chat.system.transform equivalent
    // -------------------------------------------------------------------

    await ctx.session.hook('context', (event) => {
      try {
        const state = sessions.get(event.sessionID)
        if (!state) return

        const lines = []
        if (state.cwd) {
          lines.push(`- **Working directory**: \`${state.cwd}\` — automatically set as \`workdir\` on every eligible tool call`)
        }
        if (state.envSource) {
          const count = Object.keys(state.env).length
          lines.push(`- **Environment** (${count} variable(s) from ${state.envSource}) — applied natively to the process environment of shell commands run for this session`)
        }
        if (state.worktree) {
          lines.push(`- **Active worktree**: \`${state.worktree.path}\``)
        }

        if (lines.length > 0) {
          event.system.push({
            type: 'text',
            text: [
              '## Active Session Context (opencode-use)',
              '',
              'The following are **automatically injected into every tool call that accepts a `workdir` parameter**',
              '(including `bash`) by the plugin. Write clean calls — do not add these yourself:',
              '',
              ...lines,
              '',
              'Override: if you intentionally need a **different** directory for one specific call,',
              'set `workdir` explicitly — your value will be used for that call only.',
              '',
              'For tools with no `workdir` parameter (e.g. read, write, edit, glob, grep): construct absolute paths using the working directory above.',
            ].join('\n'),
          })
        }
      } catch (err) {
        log('chat.system.transform failed', err)
      }
    })

    return () => {
      catalogWatcher.abort()
    }
  },
})
