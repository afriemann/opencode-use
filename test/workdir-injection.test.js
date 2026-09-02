// spec: openspec/changes/generalize-workdir-injection/specs/workdir-injection/spec.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import OpenCodeUse from '../src/index.js'
import { makeTempDir } from './helpers.js'

/**
 * Minimal stand-in for the Bun `$` shell interface, used only by `use_direnv`
 * in these tests. Returns a fixed `direnv export json` payload without
 * spawning any subprocess or requiring direnv to be installed.
 */
function fakeDirenvShell(stdoutJson) {
  return function taggedTemplate() {
    const builder = {
      cwd() {
        return builder
      },
      quiet() {
        return builder
      },
      text() {
        return Promise.resolve(stdoutJson)
      },
      then(resolvePromise, reject) {
        return Promise.resolve(stdoutJson).then(resolvePromise, reject)
      },
    }
    return builder
  }
}

let sessionCounter = 0
function uniqueSessionId() {
  sessionCounter += 1
  return `workdir-injection-test-${sessionCounter}`
}

let toolCounter = 0
/** Generate a fresh toolID per test so tests never share module-level cache entries. */
function uniqueToolId(prefix) {
  toolCounter += 1
  return `${prefix}-${toolCounter}`
}

async function makePlugin($ = fakeDirenvShell('{}')) {
  return OpenCodeUse({ client: { app: { log: () => Promise.resolve() } }, $ })
}

/** Set state.cwd for a fresh session via the real use_cwd tool against a real temp dir. */
async function withActiveCwd(t, plugin, sessionID) {
  const dir = await makeTempDir(t, 'workdir-injection-')
  await plugin.tool.use_cwd.execute({ path: dir }, { sessionID, directory: dir })
  return dir
}

describe('Tool Workdir Injection', () => {
  it('Session has an active working directory, an eligible tool, call omits workdir', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const cwd = await withActiveCwd(t, plugin, sessionID)
    const toolID = uniqueToolId('my-tool')

    await plugin['tool.definition'](
      { toolID },
      { description: '', parameters: { properties: { workdir: { type: 'string' } } } },
    )

    const output = { args: {} }
    await plugin['tool.execute.before']({ tool: toolID, sessionID }, output)

    assert.equal(output.args.workdir, cwd)
  })

  it('Call explicitly specifies its own workdir', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    await withActiveCwd(t, plugin, sessionID)
    const toolID = uniqueToolId('my-tool')

    await plugin['tool.definition'](
      { toolID },
      { description: '', parameters: { properties: { workdir: { type: 'string' } } } },
    )

    const output = { args: { workdir: '/explicit/path' } }
    await plugin['tool.execute.before']({ tool: toolID, sessionID }, output)

    assert.equal(output.args.workdir, '/explicit/path')
  })

  it("Tool's workdir parameter is enum-constrained, non-string, or required", async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    await withActiveCwd(t, plugin, sessionID)

    const schemas = [
      { properties: { workdir: { type: 'string', enum: ['a', 'b'] } } },
      { properties: { workdir: { type: 'number' } } },
      { properties: { workdir: { type: 'string' } }, required: ['workdir'] },
    ]

    for (const [i, parameters] of schemas.entries()) {
      const toolID = uniqueToolId('ineligible-tool')
      await plugin['tool.definition']({ toolID }, { description: '', parameters })

      const output = { args: {} }
      await plugin['tool.execute.before']({ tool: toolID, sessionID }, output)

      assert.equal(output.args.workdir, undefined, `schema #${i} must not be injected`)
    }
  })

  it('Tool has no workdir parameter, or was never observed by tool.definition', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    await withActiveCwd(t, plugin, sessionID)

    // Never observed by tool.definition at all.
    const neverSeenToolID = uniqueToolId('never-seen-tool')
    const neverSeen = { args: {} }
    await plugin['tool.execute.before']({ tool: neverSeenToolID, sessionID }, neverSeen)
    assert.equal(neverSeen.args.workdir, undefined)

    // Observed, but with no workdir parameter in its schema.
    const noWorkdirToolID = uniqueToolId('no-workdir-tool')
    await plugin['tool.definition'](
      { toolID: noWorkdirToolID },
      { description: '', parameters: { properties: {} } },
    )
    const noWorkdir = { args: {} }
    await plugin['tool.execute.before']({ tool: noWorkdirToolID, sessionID }, noWorkdir)
    assert.equal(noWorkdir.args.workdir, undefined)
  })

  it("A call's arguments object is missing", async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    await withActiveCwd(t, plugin, sessionID)
    const toolID = uniqueToolId('my-tool')

    await plugin['tool.definition'](
      { toolID },
      { description: '', parameters: { properties: { workdir: { type: 'string' } } } },
    )

    const output = {}
    await assert.doesNotReject(plugin['tool.execute.before']({ tool: toolID, sessionID }, output))
    assert.equal(output.args, undefined)
  })

  it('Bash tool call, session has an active working directory', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const cwd = await withActiveCwd(t, plugin, sessionID)

    await plugin['tool.definition'](
      { toolID: 'bash' },
      {
        description: '',
        parameters: { properties: { command: { type: 'string' }, workdir: { type: 'string' } } },
      },
    )

    const output = { args: { command: 'echo hi' } }
    await plugin['tool.execute.before']({ tool: 'bash', sessionID }, output)

    assert.equal(output.args.workdir, cwd)
  })

  it('The plugin never records its own tools as workdir-capable', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    await withActiveCwd(t, plugin, sessionID)

    for (const selfToolID of ['use_cwd', 'use_direnv', 'use_worktree', 'use_clear']) {
      // Artificially eligible-looking schema, to prove the self-tool guard —
      // not the eligibility predicate — is what blocks recording and injection.
      const def = {
        description: '',
        parameters: { properties: { workdir: { type: 'string', description: 'Original' } } },
      }
      await plugin['tool.definition']({ toolID: selfToolID }, def)
      assert.equal(def.parameters.properties.workdir.description, 'Original', `${selfToolID} must not be annotated`)

      const output = { args: {} }
      await plugin['tool.execute.before']({ tool: selfToolID, sessionID }, output)
      assert.equal(output.args.workdir, undefined, `${selfToolID} must not receive workdir injection`)
    }
  })
})

describe('Bash Environment Injection', () => {
  it('Session has active environment variables', async (t) => {
    const plugin = await makePlugin(fakeDirenvShell(JSON.stringify({ FOO: 'bar', BAZ: 'qux' })))
    const sessionID = uniqueSessionId()
    const dir = await makeTempDir(t, 'workdir-injection-env-')
    await plugin.tool.use_direnv.execute({ path: dir }, { sessionID, directory: dir })

    const output = { args: { command: 'echo hi' } }
    await plugin['tool.execute.before']({ tool: 'bash', sessionID }, output)

    assert.equal(output.args.command, "export FOO='bar' && export BAZ='qux' && echo hi")
  })

  it('A non-bash tool call is made', async (t) => {
    const plugin = await makePlugin(fakeDirenvShell(JSON.stringify({ FOO: 'bar' })))
    const sessionID = uniqueSessionId()
    const dir = await makeTempDir(t, 'workdir-injection-env-nonbash-')
    await plugin.tool.use_direnv.execute({ path: dir }, { sessionID, directory: dir })
    const toolID = uniqueToolId('my-tool')

    await plugin['tool.definition'](
      { toolID },
      { description: '', parameters: { properties: { command: { type: 'string' } } } },
    )

    const output = { args: { command: 'echo hi' } }
    await plugin['tool.execute.before']({ tool: toolID, sessionID }, output)

    assert.equal(output.args.command, 'echo hi')
  })
})

describe('Tool Workdir Schema Annotation', () => {
  it("An eligible tool's schema is requested", async () => {
    const plugin = await makePlugin()
    const def = {
      description: '',
      parameters: { properties: { workdir: { type: 'string', description: 'Original description' } } },
    }

    await plugin['tool.definition']({ toolID: uniqueToolId('my-tool') }, def)

    assert.ok(def.parameters.properties.workdir.description.startsWith('Original description'))
    assert.ok(def.parameters.properties.workdir.description.includes('auto-populated by the plugin'))
  })

  it('The same definition object is annotated twice', async () => {
    const plugin = await makePlugin()
    const def = {
      description: '',
      parameters: { properties: { workdir: { type: 'string', description: 'Original' } } },
    }
    const toolID = uniqueToolId('my-tool')

    await plugin['tool.definition']({ toolID }, def)
    const afterFirst = def.parameters.properties.workdir.description
    await plugin['tool.definition']({ toolID }, def)

    assert.equal(def.parameters.properties.workdir.description, afterFirst)
  })

  it("A tool's workdir parameter is not eligible", async () => {
    const plugin = await makePlugin()

    const enumDef = {
      description: '',
      parameters: { properties: { workdir: { type: 'string', enum: ['a'], description: 'Original' } } },
    }
    await plugin['tool.definition']({ toolID: uniqueToolId('enum-tool') }, enumDef)
    assert.equal(enumDef.parameters.properties.workdir.description, 'Original')

    const numberDef = {
      description: '',
      parameters: { properties: { workdir: { type: 'number', description: 'Original' } } },
    }
    await plugin['tool.definition']({ toolID: uniqueToolId('number-tool') }, numberDef)
    assert.equal(numberDef.parameters.properties.workdir.description, 'Original')

    const requiredDef = {
      description: '',
      parameters: {
        properties: { workdir: { type: 'string', description: 'Original' } },
        required: ['workdir'],
      },
    }
    await plugin['tool.definition']({ toolID: uniqueToolId('required-tool') }, requiredDef)
    assert.equal(requiredDef.parameters.properties.workdir.description, 'Original')

    const noWorkdirDef = { description: '', parameters: { properties: {} } }
    await assert.doesNotReject(plugin['tool.definition']({ toolID: uniqueToolId('no-workdir-tool') }, noWorkdirDef))
  })
})


describe('System Prompt Session Context (workdir wording)', () => {
  it('Session has active context to report', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    await withActiveCwd(t, plugin, sessionID)

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)

    assert.equal(output.system.length, 1)
    assert.ok(output.system[0].includes('every tool call that accepts a `workdir` parameter'))
    assert.ok(!output.system[0].includes('every bash call'))
    assert.ok(!output.system[0].includes('bash calls in your context'))
  })

  it('Session has no active context to report', async () => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)

    assert.equal(output.system.length, 0)
  })
})
