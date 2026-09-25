// spec: openspec/changes/direnv-automation/specs/context-autoload/spec.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import OpenCodeUse from '../src/plugin.v1.js'
import { makeTempRepo, nodeShellShim } from './helpers.js'

function fakeClient() {
  return { app: { log: () => Promise.resolve() } }
}

describe('V1 plugin — session.created event hook (design.md D6)', () => {
  it('Session start initializes cwd and AGENTS.md without loading env', async (t) => {
    const repoRoot = await makeTempRepo(t, 'plugin-v1-events-')
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(join(repoRoot, 'AGENTS.md'), '# hello from v1 session-created\n')

    const plugin = await OpenCodeUse({ client: fakeClient(), $: nodeShellShim })
    const sessionID = 'plugin-v1-events-session-1'

    await plugin.event({
      event: {
        type: 'session.created',
        properties: { info: { id: sessionID, directory: repoRoot } },
      },
    })

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)
    const block = output.system.find((s) => s.includes('Active Session Context'))
    assert.ok(block, 'expected the Active Session Context block to be present')
    assert.ok(block.includes(repoRoot), 'expected the block to name the initialized cwd')
    assert.ok(!block.includes('variable(s) from direnv'), 'session-start init must never auto-load env')

    const agentsMdBlock = output.system.find((s) => s.includes('hello from v1 session-created'))
    assert.ok(agentsMdBlock, 'expected AGENTS.md content to have been discovered')
  })

  it('a malformed session.created payload is swallowed without throwing', async () => {
    const plugin = await OpenCodeUse({ client: fakeClient(), $: nodeShellShim })

    await assert.doesNotReject(plugin.event({ event: { type: 'session.created', properties: {} } }))
    await assert.doesNotReject(plugin.event({ event: { type: 'session.created' } }))
    await assert.doesNotReject(plugin.event({ event: null }))
    await assert.doesNotReject(plugin.event({}))
  })

  it('an unrelated event type is ignored', async (t) => {
    const repoRoot = await makeTempRepo(t, 'plugin-v1-events-ignore-')
    const plugin = await OpenCodeUse({ client: fakeClient(), $: nodeShellShim })
    const sessionID = 'plugin-v1-events-session-2'

    await plugin.event({
      event: { type: 'file.watcher.updated', properties: { file: repoRoot, event: 'change' } },
    })

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)
    assert.equal(output.system.length, 0, 'expected no session state to have been initialized')
  })

  it('V1 has no session-move equivalent', async (t) => {
    const repoRoot = await makeTempRepo(t, 'plugin-v1-events-no-move-')
    const plugin = await OpenCodeUse({ client: fakeClient(), $: nodeShellShim })
    const sessionID = 'plugin-v1-events-session-3'

    // A V2-shaped session.moved event, if it ever reached V1's `event` hook
    // (it cannot, since V1 has no such event — see design.md D6), must still
    // be a no-op here: the hook only branches on 'session.created'.
    await plugin.event({
      event: { type: 'session.moved', data: { sessionID, location: { directory: repoRoot } } },
    })

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)
    assert.equal(output.system.length, 0, 'expected session.moved to have no effect on V1')
  })
})
