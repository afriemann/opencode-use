// spec: openspec/specs/workdir-injection/spec.md
// (See also openspec/changes/fix-bash-workdir-injection-regression/ for the
// bash-eligibility correction to this spec.)
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

/** Create a plugin instance with a spy client, returning the plugin and the captured log messages. */
async function makePluginWithLogs($ = fakeDirenvShell('{}')) {
  const logs = []
  const plugin = await OpenCodeUse({
    client: { app: { log: ({ body }) => (logs.push(body.message), Promise.resolve()) } },
    $,
  })
  return { plugin, logs }
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

  it('Bash tool call injects workdir even when its live schema is not detected as eligible', async (t) => {
    // Regression guard: bash's real, live-converted schema does not reliably
    // match the eligibility predicate's assumed shape (see design.md
    // decision #1 correction). bash must therefore always receive workdir
    // injection regardless of what tool.definition recorded for it.
    //
    // Deliberately forces the ineligible outcome via tool.definition rather
    // than relying on "never observed" — the workdirCapable cache is a
    // module-level singleton shared across every test in this process, so an
    // earlier test's tool.definition('bash', ...) call would otherwise leak
    // a cached `true` into this test regardless of test order.
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const cwd = await withActiveCwd(t, plugin, sessionID)

    await plugin['tool.definition'](
      { toolID: 'bash' },
      { description: '', parameters: { properties: { workdir: { type: 'number' } } } },
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

describe('Workdir Injection Diagnostics', () => {
  it("A toolID's workdir-capability is recorded for the first time", async () => {
    const { plugin, logs } = await makePluginWithLogs()
    const toolID = uniqueToolId('diag-first-seen')

    await plugin['tool.definition'](
      { toolID },
      { description: '', parameters: { properties: { workdir: { type: 'string' } } } },
    )

    assert.ok(logs.some((m) => m.includes(`workdir-capability: ${toolID} => true`)))
  })

  it("A toolID's recorded eligibility changes", async () => {
    const { plugin, logs } = await makePluginWithLogs()
    const toolID = uniqueToolId('diag-changed')

    await plugin['tool.definition'](
      { toolID },
      { description: '', parameters: { properties: { workdir: { type: 'string' } } } },
    )
    logs.length = 0

    await plugin['tool.definition'](
      { toolID },
      { description: '', parameters: { properties: { workdir: { type: 'number' } } } },
    )

    assert.ok(logs.some((m) => m.includes(`workdir-capability: ${toolID} => false`)))
  })

  it('A toolID is recorded as ineligible', async () => {
    const { plugin, logs } = await makePluginWithLogs()
    const toolID = uniqueToolId('diag-ineligible-detail')

    await plugin['tool.definition'](
      { toolID },
      {
        description: '',
        parameters: {
          properties: { workdir: { type: 'string' } },
          required: ['workdir'],
        },
      },
    )

    const line = logs.find((m) => m.includes(`workdir-capability: ${toolID} => false`))
    assert.ok(line, 'expected an ineligible capability log line')
    assert.ok(line.includes('workdir prop:'))
    assert.ok(line.includes('"type":"string"'))
    assert.ok(line.includes('required:'))
    assert.ok(line.includes('["workdir"]'))
  })

  it("A toolID's recorded eligibility is unchanged", async () => {
    const { plugin, logs } = await makePluginWithLogs()
    const toolID = uniqueToolId('diag-unchanged')

    await plugin['tool.definition'](
      { toolID },
      { description: '', parameters: { properties: { workdir: { type: 'string' } } } },
    )
    logs.length = 0

    await plugin['tool.definition'](
      { toolID },
      { description: '', parameters: { properties: { workdir: { type: 'string' } } } },
    )

    assert.ok(!logs.some((m) => m.includes('workdir-capability:')))
  })

  it('Injection happens', async (t) => {
    const { plugin, logs } = await makePluginWithLogs()
    const sessionID = uniqueSessionId()
    const cwd = await withActiveCwd(t, plugin, sessionID)
    const toolID = uniqueToolId('diag-inject')

    await plugin['tool.definition'](
      { toolID },
      { description: '', parameters: { properties: { workdir: { type: 'string' } } } },
    )
    logs.length = 0

    await plugin['tool.execute.before']({ tool: toolID, sessionID }, { args: {} })

    assert.ok(logs.some((m) => m.includes(`workdir-injection: ${toolID} => ${cwd}`)))
  })

  it('Injection is skipped because the call already has an explicit workdir', async (t) => {
    const { plugin, logs } = await makePluginWithLogs()
    const sessionID = uniqueSessionId()
    await withActiveCwd(t, plugin, sessionID)
    const toolID = uniqueToolId('diag-explicit')

    await plugin['tool.definition'](
      { toolID },
      { description: '', parameters: { properties: { workdir: { type: 'string' } } } },
    )
    logs.length = 0

    await plugin['tool.execute.before']({ tool: toolID, sessionID }, { args: { workdir: '/explicit' } })

    assert.ok(logs.some((m) => m.includes(`workdir-injection: ${toolID} skipped (explicit workdir already set)`)))
  })

  it('Injection is skipped because the tool is not recorded as workdir-capable', async (t) => {
    const { plugin, logs } = await makePluginWithLogs()
    const sessionID = uniqueSessionId()
    await withActiveCwd(t, plugin, sessionID)
    const toolID = uniqueToolId('diag-ineligible')

    logs.length = 0

    await plugin['tool.execute.before']({ tool: toolID, sessionID }, { args: {} })

    assert.ok(
      logs.some((m) => m.includes(`workdir-injection: ${toolID} skipped (not recorded as workdir-capable`)),
    )
  })

  it('No active working directory', async (t) => {
    const { plugin, logs } = await makePluginWithLogs()
    const sessionID = uniqueSessionId()
    const toolID = uniqueToolId('diag-no-cwd')

    // Establishes session state (via use_direnv) without ever setting cwd,
    // so state.cwd stays falsy while a session entry exists.
    const dir = await makeTempDir(t, 'workdir-injection-diag-no-cwd-')
    await plugin.tool.use_direnv.execute({ path: dir }, { sessionID, directory: dir })
    logs.length = 0

    await plugin['tool.execute.before']({ tool: toolID, sessionID }, { args: {} })

    assert.equal(logs.length, 0)
  })
})
