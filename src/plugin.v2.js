// src/plugin.v2.js — opencode-use, V2 plugin entrypoint
//
// Thin adapter over src/core.js (see design.md D1), mapping the same
// runtime-agnostic business logic onto opencode's real V2 plugin SDK
// (`@opencode/plugin`, `Plugin.define({ id, setup(ctx) })`).
//
//   V1 hook                                V2 destination
//   tool map                               ctx.tool.transform(editor.add(...))
//   tool.definition                        same transform, editor.update(...) on mcp.tools.changed
//   tool.execute.before                    ctx.tool.hook("execute.before", ...)
//   shell.env                              ctx.shell.hook("create.before", ...)
//   experimental.chat.system.transform      ctx.session.hook("context", ...)
//
// Key differences from V1 (see design.md D2–D8 for the full analysis):
//   - Tool schemas are ALWAYS plain JSON Schema — no raw-Zod source exists.
//   - The built-in shell tool is named `shell`, not `bash`.
//   - `$` (shell exec) is not on ctx; resolved once from `globalThis.Bun.$`
//     at setup() and injected into core, failing loudly if absent (D2).
//   - Every custom tool descriptor MUST carry `options: { codemode: false }`
//     (D4) — confirmed empirically: a V2 tool with no `options.codemode` set
//     is Code-Mode-only (reachable only via the separate `execute` JS tool),
//     not directly/natively callable. `pinned: true` does NOT fix this.
//   - `ShellCreateBefore` carries no `sessionID` (D6) — env-session
//     resolution uses the fail-closed ladder in core.js instead of a direct
//     sessionID lookup.

import { Plugin } from '@opencode/plugin'
import {
  createSessionStore,
  SELF_TOOL_NAMES,
  isEligibleJsonSchemaProp,
  annotateJsonSchemaProp,
  filterInjectableEnv,
  decideWorkdirInjection,
  resolveEnvSessionForShell,
  buildActiveSessionContextBlock,
  buildAgentsMdBlock,
  V2_ENV_INJECTION_CAVEAT,
  V2_TOOL_OPTIONS,
  V2_CUSTOM_TOOL_NAMES,
  TOOL_TEXT,
  executeUseWorkdir,
  executeUseDirenv,
  executeUseWorktree,
  executeUseClear,
} from './core.js'

/** V2 renamed the built-in `bash` tool to `shell` (confirmed empirically). */
const ALWAYS_ELIGIBLE_TOOL_NAME = 'shell'

/**
 * V2's tool schema is always JSON Schema (`Tool.Info.input`) — resolve
 * eligibility and log detail directly from it, with no source ladder.
 */
function resolveWorkdirEligibilityV2(inputSchema) {
  const eligible = isEligibleJsonSchemaProp(inputSchema)
  const prop = inputSchema?.properties?.workdir
  const required = inputSchema?.required
  return { eligible, prop, required }
}

/** Returns a logger function; falls back to stderr if the client log call fails. */
function makeLogger(ctx) {
  return (message, err, level = err ? 'error' : 'info') => {
    const detail = err ? `: ${err instanceof Error ? (err.stack ?? err.message) : err}` : ''
    const msg = `[opencode-use] ${message}${detail}`
    try {
      const maybePromise = ctx?.app?.log?.({ service: 'opencode-use', level, message: msg })
      maybePromise?.catch?.(() => process.stderr.write(msg + '\n'))
      if (!ctx?.app?.log) process.stderr.write(msg + '\n')
    } catch {
      process.stderr.write(msg + '\n')
    }
  }
}

export default Plugin.define({
  id: 'opencode-use',
  async setup(ctx) {
    const log = makeLogger(ctx)
    const { sessions, getState } = createSessionStore()
    const directory = ctx.location?.directory ?? process.cwd()

    // design.md D2: V2's Context has no shell-exec member. Fail loudly at
    // load time — not at first tool call — if the Bun global is absent.
    const $ = globalThis.Bun?.$
    if (!$) {
      throw new Error(
        'opencode-use (V2): globalThis.Bun.$ is not available. This plugin requires a ' +
        'Bun-hosted opencode V2 runtime for shell execution (git, direnv). ' +
        'If you are running a non-Bun V2 host, this plugin cannot function — please report this.',
      )
    }

    const deps = { $, log, directory }

    /** @type {Map<string, boolean>} keyed by effective tool id (see D8) */
    const workdirCapable = new Map()

    // -----------------------------------------------------------------------
    // Tool registration (D4: options.codemode: false is mandatory)
    // -----------------------------------------------------------------------

    function toolDescriptors() {
      return [
        {
          name: 'use_workdir',
          description: TOOL_TEXT.use_workdir.description,
          input: {
            type: 'object',
            properties: {
              path: { type: 'string', description: TOOL_TEXT.use_workdir.path },
            },
            required: ['path'],
            additionalProperties: false,
          },
          options: V2_TOOL_OPTIONS.use_workdir,
          async execute(input, toolCtx) {
            const state = getState(toolCtx.sessionID)
            return { content: await executeUseWorkdir(input, state, deps) }
          },
        },
        {
          name: 'use_direnv',
          description: TOOL_TEXT.use_direnv.description,
          input: {
            type: 'object',
            properties: {
              path: { type: 'string', description: TOOL_TEXT.use_direnv.path },
            },
            required: ['path'],
            additionalProperties: false,
          },
          options: V2_TOOL_OPTIONS.use_direnv,
          async execute(input, toolCtx) {
            const state = getState(toolCtx.sessionID)
            return { content: await executeUseDirenv(input, state, deps) }
          },
        },
        {
          name: 'use_worktree',
          description: TOOL_TEXT.use_worktree.description,
          input: {
            type: 'object',
            properties: {
              path: { type: 'string', description: TOOL_TEXT.use_worktree.path },
              branch: { type: 'string', description: TOOL_TEXT.use_worktree.branch },
              create: { type: 'boolean', description: TOOL_TEXT.use_worktree.create },
              fromRemote: { type: 'boolean', description: TOOL_TEXT.use_worktree.fromRemote },
              base: { type: 'string', description: TOOL_TEXT.use_worktree.base },
            },
            required: ['path', 'branch'],
            additionalProperties: false,
          },
          options: V2_TOOL_OPTIONS.use_worktree,
          async execute(input, toolCtx) {
            const state = getState(toolCtx.sessionID)
            return { content: await executeUseWorktree(input, state, deps) }
          },
        },
        {
          name: 'use_clear',
          description: TOOL_TEXT.use_clear.description,
          input: {
            type: 'object',
            properties: {
              fields: {
                type: 'array',
                items: { type: 'string', enum: ['cwd', 'env', 'worktree'] },
                description: TOOL_TEXT.use_clear.fields,
              },
              force: { type: 'boolean', description: TOOL_TEXT.use_clear.force },
            },
            additionalProperties: false,
          },
          options: V2_TOOL_OPTIONS.use_clear,
          async execute(input, toolCtx) {
            const state = getState(toolCtx.sessionID)
            return { content: await executeUseClear(input, state, deps) }
          },
        },
      ]
    }

    /**
     * Registers all four custom tools and (re-)annotates every tool's
     * workdir-eligible schema. Idempotent — the WORKDIR_ANNOTATION sentinel
     * in `annotateJsonSchemaProp` guards re-running this against the same
     * definition objects, which is what makes catalog reload safe (D7).
     *
     * D4 guard: after registering, assert every V2_CUSTOM_TOOL_NAMES entry
     * is actually present in the live catalog with codemode: false — this
     * is the adapter-level safety net design.md calls for, catching a
     * tool that's silently missing its options (e.g. a future refactor
     * that stops spreading V2_TOOL_OPTIONS) before it reaches production
     * silently as Code-Mode-only.
     */
    function registerAndAnnotate(editor) {
      for (const descriptor of toolDescriptors()) {
        editor.add(descriptor)
      }

      for (const toolName of V2_CUSTOM_TOOL_NAMES) {
        const registered = editor.get(toolName)
        if (!registered || registered.options?.codemode !== false) {
          throw new Error(
            `opencode-use (V2): tool "${toolName}" is missing options.codemode: false after registration — ` +
            `it would silently become Code-Mode-only (indirect-call-only). This is a bug in plugin.v2.js/core.js, ` +
            `not a runtime condition — please report it.`,
          )
        }
      }

      for (const t of editor.list()) {
        // D8: key the self-tool exclusion set on whatever list() actually
        // reports. Verified empirically: editor.list() returns ids equal to
        // the registered `name` with no namespace prefix when no
        // `editor.namespace(...)` call is made (this plugin makes none).
        if (SELF_TOOL_NAMES.has(t.id)) continue

        const { eligible, prop, required } = resolveWorkdirEligibilityV2(t.input)
        const previouslyRecorded = workdirCapable.get(t.id)
        workdirCapable.set(t.id, eligible)
        if (previouslyRecorded === undefined || previouslyRecorded !== eligible) {
          const detail = eligible
            ? ' (via input schema)'
            : ` (via input schema; workdir prop: ${JSON.stringify(prop)}, required: ${JSON.stringify(required)})`
          log(`workdir-capability: ${t.id} => ${eligible}${detail}`)
        }
        if (!eligible) continue

        editor.update(t.id, (tool) => {
          annotateJsonSchemaProp(tool.input)
        })
      }
    }

    const toolRegistration = await ctx.tool.transform((editor) => {
      registerAndAnnotate(editor)
    })

    // -----------------------------------------------------------------------
    // Catalog re-scan on mcp.tools.changed (D7), with a re-entrancy guard
    // -----------------------------------------------------------------------
    //
    // Corrected from an earlier draft's `catalog.updated`, which does not
    // exist in the real event manifest (verified against the installed
    // @opencode/schema package's event-manifest.d.ts — the exhaustive union
    // of every event type the host can emit). `mcp.tools.changed` is the
    // real event fired when an MCP server's tool set changes (including on
    // initial connect), which is what actually needs a re-scan for
    // newly-appeared tools' workdir eligibility.

    const abortController = new AbortController()
    let reloadInFlight = false

    ;(async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abortController.signal })) {
          if (event?.type !== 'mcp.tools.changed') continue
          if (reloadInFlight) continue // re-entrancy guard: a reload already in flight
          reloadInFlight = true
          try {
            await ctx.tool.reload()
          } catch (err) {
            log('mcp.tools.changed reload failed', err)
          } finally {
            reloadInFlight = false
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) log('event subscription failed', err)
      }
    })()

    // -----------------------------------------------------------------------
    // tool.execute.before → ctx.tool.hook("execute.before", ...)
    // -----------------------------------------------------------------------

    const executeBeforeRegistration = await ctx.tool.hook('execute.before', (event) => {
      try {
        const state = sessions.get(event.sessionID)
        if (!state) return
        if (!state.cwd) return

        const input = event.input
        if (!input || typeof input !== 'object') return

        const cachedEligibility = workdirCapable.get(event.tool)
        const { inject, reason } = decideWorkdirInjection({
          toolName: event.tool,
          alwaysEligibleToolName: ALWAYS_ELIGIBLE_TOOL_NAME,
          cachedEligibility,
          hasExplicitWorkdir: Boolean(input.workdir),
        })

        if (inject) {
          input.workdir = state.cwd
          log(`workdir-injection: ${event.tool} => ${state.cwd}`)
        } else {
          log(`workdir-injection: ${event.tool} ${reason}`)
        }
      } catch (err) {
        log('execute.before failed', err)
      }
    })

    // -----------------------------------------------------------------------
    // shell.env → ctx.shell.hook("create.before", ...)
    // D6: no sessionID on this payload — use the fail-closed resolution ladder.
    // -----------------------------------------------------------------------

    const createBeforeRegistration = await ctx.shell.hook('create.before', (event) => {
      try {
        const resolved = resolveEnvSessionForShell(sessions, { cwd: event.cwd })
        if (!resolved) return
        if (resolved.ambiguous) {
          log(`shell-env-injection: skipped — ambiguous among sessions [${resolved.candidates.join(', ')}]`)
          return
        }

        const injectable = filterInjectableEnv(resolved.state.env)
        if (Object.keys(injectable).length === 0) return

        if (!event.env || typeof event.env !== 'object') event.env = {}
        Object.assign(event.env, injectable)
      } catch (err) {
        log('create.before (shell env) failed', err)
      }
    })

    // -----------------------------------------------------------------------
    // experimental.chat.system.transform → ctx.session.hook("context", ...)
    // -----------------------------------------------------------------------

    const contextRegistration = await ctx.session.hook('context', (event) => {
      try {
        const state = sessions.get(event.sessionID)
        if (!state) return

        // D6: surface the best-effort env-injection caveat in-band, only
        // when more than one session is concurrently tracked with a
        // non-empty environment (the only situation the ladder can fail to
        // disambiguate).
        const envBearingCount = [...sessions.values()].filter(
          (s) => Object.keys(s.env).length > 0,
        ).length
        const envInjectionCaveat = envBearingCount > 1 ? V2_ENV_INJECTION_CAVEAT : undefined

        const sessionBlock = buildActiveSessionContextBlock(state, { envInjectionCaveat })
        if (sessionBlock) event.system.push({ type: 'text', text: sessionBlock })

        const agentsMdBlock = buildAgentsMdBlock(state)
        if (agentsMdBlock) event.system.push({ type: 'text', text: agentsMdBlock })
      } catch (err) {
        log('session context hook failed', err)
      }
    })

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    return async () => {
      abortController.abort()
      await toolRegistration?.dispose?.()
      await executeBeforeRegistration?.dispose?.()
      await createBeforeRegistration?.dispose?.()
      await contextRegistration?.dispose?.()
    }
  },
})
