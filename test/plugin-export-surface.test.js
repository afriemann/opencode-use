// spec: openspec/changes/fix-plugin-export-scan/proposal.md
//
// opencode's legacy-plugin loader (`getLegacyPlugins` in
// packages/opencode/src/plugin/index.ts) invokes EVERY top-level named
// export that is a function as an independent plugin factory, called as
// `server(input, load.options)`. Any named export from src/index.js besides
// `default` is therefore misinterpreted as its own "plugin" and invoked with
// the wrong argument shape -- this file guards against that class of defect.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('plugin module export surface (opencode legacy-plugin loader safety)', () => {
  it('src/index.js exports nothing but default', async () => {
    const mod = await import('../src/index.js')
    assert.deepEqual(Object.keys(mod), ['default'])
  })

  it('every export getLegacyPlugins would invoke succeeds only via its real contract (default), and no phantom candidate exists', async () => {
    // Mirrors opencode's actual invocation for EVERY function-typed export of
    // the module (getLegacyPlugins does not special-case `default`): each is
    // called as `server(input, load.options)` -- i.e. `fn(fakeInput, undefined)`,
    // not with whatever arguments that export's own signature actually expects.
    const mod = await import('../src/index.js')
    const fakeInput = {
      client: { app: { log: () => Promise.resolve() } },
      project: {},
      worktree: '/tmp',
      directory: '/tmp',
      $: () => { throw new Error('fake $ invoked') },
    }

    let defaultAsserted = false
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function') continue

      if (name === 'default') {
        // The real plugin factory MUST succeed when invoked exactly the way
        // getLegacyPlugins invokes it, since its signature (`{ client, $ }`)
        // is exactly `input`'s shape -- this is the success path opencode's
        // loader actually depends on, not just an exemption from the guard.
        const hooks = await value(fakeInput, undefined)
        assert.ok(hooks.tool, 'default export must register tools when invoked as (input, options)')
        defaultAsserted = true
        continue
      }

      // Any OTHER function-typed export must not exist per the export-surface
      // test above -- this loop exists purely so that if one is ever
      // reintroduced, it is caught here with a clear failure message too.
      await assert.rejects(
        () => Promise.resolve(value(fakeInput, undefined)),
        `unexpected non-default export '${name}' would be invoked as a phantom plugin by opencode's loader`,
      )
    }

    assert.ok(defaultAsserted, 'expected the module to have a default export to assert against')
  })
})
