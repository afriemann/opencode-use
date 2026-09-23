// src/plugin.v1.js — opencode-use, V1 plugin entrypoint
//
// Thin adapter over src/core.js (see design.md D1): wires V1's hook surface
// (`tool` map, `tool.definition`, `tool.execute.before`, `shell.env`,
// `experimental.chat.system.transform`) onto the shared runtime-agnostic
// business logic. Injects V1's `$` (from plugin input) into core.
//
// V1-only concerns that stay here rather than in core.js: the 3-source
// schema ladder (JSON Schema / raw Zod / JSON-Schema-as-parameters) and the
// raw-Zod eligibility predicate, since V2 tools are always plain JSON
// Schema and need neither (see design.md D3).

import { tool } from '@opencode-ai/plugin'
import {
  createSessionStore,
  SELF_TOOL_NAMES,
  isEligibleJsonSchemaProp,
  annotateJsonSchemaProp,
  filterInjectableEnv,
  decideWorkdirInjection,
  buildActiveSessionContextBlock,
  buildAgentsMdBlock,
  TOOL_TEXT,
  executeUseWorkdir,
  executeUseDirenv,
  executeUseWorktree,
  executeUseClear,
} from './core.js'

// ---------------------------------------------------------------------------
// V1-only: raw-Zod schema-source detection (not applicable on V2 — see D3)
// ---------------------------------------------------------------------------

/** Zod v4 wrapper types treated as "not required" over their inner type. */
const ZOD_OPTIONAL_LIKE_TYPES = new Set(['optional', 'default', 'prefault'])

/**
 * Determine whether a raw Zod `workdir` schema entry is eligible, via duck
 * typing on Zod's internal `_zod.def` metadata rather than `import { z }
 * from 'zod'` + `instanceof` — matching how opencode itself detects Zod
 * values, with no dependency on `zod` at all.
 */
function isEligibleZodProp(prop) {
  const def = prop?._zod?.def
  if (!def) return false
  if (!ZOD_OPTIONAL_LIKE_TYPES.has(def.type)) return false
  const innerType = def.innerType?._zod?.def?.type
  return innerType === 'string'
}

/**
 * Resolve which schema source (if any) declares a `workdir` property,
 * consulting sources in priority order: (1) `output.jsonSchema`, (2)
 * `output.parameters` as a raw Zod schema object, (3) `output.parameters`
 * as JSON Schema. The first source that carries a `workdir` property
 * decides the verdict; sources are not combined.
 *
 * @param {{ parameters?: any, jsonSchema?: any }} output
 */
function resolveWorkdirEligibility(output) {
  if (output?.jsonSchema?.properties?.workdir !== undefined) {
    return {
      eligible: isEligibleJsonSchemaProp(output.jsonSchema),
      source: 'jsonSchema',
      prop: output.jsonSchema.properties.workdir,
      required: output.jsonSchema.required,
    }
  }
  if (output?.parameters?.shape?.workdir !== undefined) {
    return {
      eligible: isEligibleZodProp(output.parameters.shape.workdir),
      source: 'parameters.shape',
      prop: output.parameters.shape.workdir,
      required: undefined,
    }
  }
  if (output?.parameters?.properties?.workdir !== undefined) {
    return {
      eligible: isEligibleJsonSchemaProp(output.parameters),
      source: 'parameters',
      prop: output.parameters.properties.workdir,
      required: output.parameters.required,
    }
  }
  return { eligible: false, source: null, prop: undefined, required: undefined }
}

function appendWorkdirAnnotation(output, source) {
  if (source === 'jsonSchema') {
    annotateJsonSchemaProp(output.jsonSchema)
    return
  }
  if (source === 'parameters') {
    annotateJsonSchemaProp(output.parameters)
    return
  }
  if (source === 'parameters.shape') {
    const prop = output.parameters.shape.workdir
    const annotation =
      ' When "## Active Session Context (opencode-use)" is present in your system prompt,' +
      ' this parameter is auto-populated by the plugin before this tool call executes —' +
      ' you do not need to set it.' +
      ' A workdir value shown on a previous call in your context was injected by the' +
      ' plugin after you submitted that call, not set by you — write your next call without it.' +
      ' Exception: set this explicitly if you intentionally need a different directory for this' +
      ' one specific call — your value will be honored for that call only.'
    if (prop.description?.includes(annotation)) return
    output.parameters.shape.workdir = prop.describe((prop.description ?? '') + annotation)
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Returns a logger function that writes to the opencode client log, falling back to stderr. */
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
  const { sessions, getState } = createSessionStore()

  /** @type {Map<string, boolean>} keyed by toolID */
  const workdirCapable = new Map()

  const useWorkdir = tool({
    description: TOOL_TEXT.use_workdir.description,
    args: {
      path: tool.schema.string().describe(TOOL_TEXT.use_workdir.path),
    },
    async execute(input, ctx) {
      const state = getState(ctx.sessionID)
      return executeUseWorkdir(input, state, { $, log, directory: ctx.directory })
    },
  })

  const useDirenv = tool({
    description: TOOL_TEXT.use_direnv.description,
    args: {
      path: tool.schema.string().describe(TOOL_TEXT.use_direnv.path),
    },
    async execute(input, ctx) {
      const state = getState(ctx.sessionID)
      return executeUseDirenv(input, state, { $, log, directory: ctx.directory })
    },
  })

  const useWorktree = tool({
    description: TOOL_TEXT.use_worktree.description,
    args: {
      path: tool.schema.string().describe(TOOL_TEXT.use_worktree.path),
      branch: tool.schema.string().describe(TOOL_TEXT.use_worktree.branch),
      create: tool.schema.boolean().optional().describe(TOOL_TEXT.use_worktree.create),
      fromRemote: tool.schema.boolean().optional().describe(TOOL_TEXT.use_worktree.fromRemote),
      base: tool.schema.string().optional().describe(TOOL_TEXT.use_worktree.base),
    },
    async execute(input, ctx) {
      const state = getState(ctx.sessionID)
      return executeUseWorktree(input, state, { $, log, directory: ctx.directory })
    },
  })

  const useClear = tool({
    description: TOOL_TEXT.use_clear.description,
    args: {
      fields: tool.schema.array(tool.schema.enum(['cwd', 'env', 'worktree'])).optional().describe(TOOL_TEXT.use_clear.fields),
      force: tool.schema.boolean().optional().describe(TOOL_TEXT.use_clear.force),
    },
    async execute(input, ctx) {
      const state = getState(ctx.sessionID)
      return executeUseClear(input, state, { $, log, directory: ctx.directory })
    },
  })

  return {
    tool: {
      use_workdir: useWorkdir,
      use_direnv: useDirenv,
      use_worktree: useWorktree,
      use_clear: useClear,
    },

    /**
     * Cache each tool's workdir-capability and, for any eligible tool,
     * annotate its `workdir` parameter description.
     */
    'tool.definition': async ({ toolID }, output) => {
      try {
        if (SELF_TOOL_NAMES.has(toolID)) return

        const { eligible, source, prop, required } = resolveWorkdirEligibility(output)
        const previouslyRecorded = workdirCapable.get(toolID)
        workdirCapable.set(toolID, eligible)
        if (previouslyRecorded === undefined || previouslyRecorded !== eligible) {
          let detail
          if (eligible) {
            detail = ` (via ${source})`
          } else if (source === 'jsonSchema' || source === 'parameters') {
            detail = ` (via ${source}; workdir prop: ${JSON.stringify(prop)}, required: ${JSON.stringify(required)})`
          } else if (source === 'parameters.shape') {
            detail = ` (via parameters.shape; zod type: ${prop?._zod?.def?.type}, inner: ${prop?._zod?.def?.innerType?._zod?.def?.type})`
          } else {
            detail = ' (no source matched)'
          }
          log(`workdir-capability: ${toolID} => ${eligible}${detail}`)
        }
        if (!eligible) return

        appendWorkdirAnnotation(output, source)
      } catch (err) {
        log('tool.definition failed', err)
      }
    },

    /**
     * Intercept every tool call to inject the session's active cwd as
     * `output.args.workdir`.
     */
    'tool.execute.before': async (input, output) => {
      try {
        if (!output.args) return
        const state = sessions.get(input.sessionID)
        if (!state) return

        if (!state.cwd) return // diagnostic logging is only meaningful with an active cwd

        const cachedEligibility = workdirCapable.get(input.tool)
        const { inject, reason } = decideWorkdirInjection({
          toolName: input.tool,
          alwaysEligibleToolName: 'bash',
          cachedEligibility,
          hasExplicitWorkdir: Boolean(output.args.workdir),
        })

        if (inject) {
          output.args.workdir = state.cwd
          log(`workdir-injection: ${input.tool} => ${state.cwd}`)
        } else {
          log(`workdir-injection: ${input.tool} ${reason}`)
        }
      } catch (err) {
        log('tool.execute.before failed', err)
      }
    },

    /**
     * Populate the real shell process environment for every shell
     * invocation opencode triggers with a known `sessionID`.
     *
     * MUST NOT throw or reject under any circumstance: opencode invokes
     * plugin hooks via `Effect.promise`, which treats a rejection as an
     * unrecoverable defect rather than a recoverable error.
     */
    'shell.env': async (input, output) => {
      try {
        if (!input?.sessionID) return
        const state = sessions.get(input.sessionID)
        if (!state) return

        const injectable = filterInjectableEnv(state.env)
        if (Object.keys(injectable).length === 0) return

        if (!output.env || typeof output.env !== 'object') output.env = {}
        Object.assign(output.env, injectable)
      } catch (err) {
        log('shell.env failed', err)
      }
    },

    /** Injects the active session context into the system prompt. */
    'experimental.chat.system.transform': async (input, output) => {
      try {
        const sessionID = input.sessionID
        if (!sessionID) return
        const state = sessions.get(sessionID)
        if (!state) return

        const sessionBlock = buildActiveSessionContextBlock(state)
        if (sessionBlock) output.system.push(sessionBlock)

        const agentsMdBlock = buildAgentsMdBlock(state)
        if (agentsMdBlock) output.system.push(agentsMdBlock)
      } catch (err) {
        log('chat.system.transform failed', err)
      }
    },
  }
}
