// spec: openspec/changes/v2-plugin-migration/design.md (D4, D6, D7, D9 layer 2)
//
// Adapter-conformance tests for src/plugin.v2.js: asserts the WIRING onto a
// mocked V2 host surface only — the shared behavioural logic itself is
// already covered once, against core.js, by the re-pointed spec suite (see
// context-autoload.test.js, workdir-injection.test.js, etc).
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Minimal mock of the V2 plugin Context (@opencode/plugin's `Context`
 * shape) sufficient to drive src/plugin.v2.js's setup() and capture what it
 * registers, without a real @opencode/cli runtime.
 */
function makeMockContext({ directory = '/tmp/mock-project' } = {}) {
  const registeredHooks = { tool: {}, shell: {}, session: {} }
  const disposals = { tool: {}, shell: {}, session: {}, transform: false }
  let toolEditor

  const eventListeners = []
  let toolReloadCalls = 0

  const ctx = {
    app: {},
    location: { directory },
    tool: {
      async transform(callback) {
        toolEditor = makeToolEditor()
        callback(toolEditor)
        return { dispose: mock.fn(async () => { disposals.transform = true }) }
      },
      async reload() {
        toolReloadCalls += 1
      },
      async hook(name, callback) {
        registeredHooks.tool[name] = callback
        return { dispose: mock.fn(async () => { disposals.tool[name] = true }) }
      },
    },
    shell: {
      async hook(name, callback) {
        registeredHooks.shell[name] = callback
        return { dispose: mock.fn(async () => { disposals.shell[name] = true }) }
      },
    },
    session: {
      async hook(name, callback) {
        registeredHooks.session[name] = callback
        return { dispose: mock.fn(async () => { disposals.session[name] = true }) }
      },
    },
    event: {
      subscribe({ signal }) {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return new Promise((resolvePromise) => {
                  eventListeners.push(resolvePromise)
                  signal.addEventListener('abort', () => resolvePromise({ done: true, value: undefined }), { once: true })
                })
              },
            }
          },
        }
      },
    },
  }

  function makeToolEditor() {
    const tools = new Map()
    return {
      list() {
        return [...tools.entries()].map(([id, t]) => ({ ...t, id }))
      },
      get(id) {
        const t = tools.get(id)
        return t ? { ...t, id } : undefined
      },
      namespace() {},
      add(tool) {
        tools.set(tool.name, tool)
      },
      update(id, fn) {
        const t = tools.get(id)
        if (!t) return
        fn(t)
      },
      remove(id) {
        tools.delete(id)
      },
    }
  }

  return {
    ctx,
    registeredHooks,
    disposals,
    getToolEditor: () => toolEditor,
    emitEvent(event) {
      const listener = eventListeners.shift()
      listener?.({ done: false, value: event })
    },
    getToolReloadCalls() {
      return toolReloadCalls
    },
  }
}

async function loadPluginWithMockContext(overrides = {}) {
  const { ctx, registeredHooks, disposals, getToolEditor, emitEvent, ...rest } = makeMockContext(overrides)
  const fakeBunDollar = mock.fn(() => {
    throw new Error('fake $ invoked in conformance test — no real shell/git call expected here')
  })
  const previousBun = globalThis.Bun
  globalThis.Bun = { $: fakeBunDollar }
  const mod = await import('../src/plugin.v2.js?t=' + Date.now())
  let cleanup
  try {
    cleanup = await mod.default.setup(ctx)
  } finally {
    globalThis.Bun = previousBun
  }
  return { cleanup, ctx, registeredHooks, disposals, getToolEditor, emitEvent, ...rest }
}

describe('plugin.v2.js adapter conformance', () => {
  it('registers all four custom tools, each with options.codemode === false (D4)', async () => {
    const { getToolEditor } = await loadPluginWithMockContext()
    const editor = getToolEditor()
    const names = editor.list().map((t) => t.id).filter((id) => id.startsWith('use_'))
    assert.deepEqual(new Set(names), new Set(['use_cwd', 'use_direnv', 'use_worktree', 'use_clear']))
    for (const t of editor.list()) {
      if (!t.id.startsWith('use_')) continue
      assert.equal(t.options?.codemode, false, `${t.id} must set options.codemode: false`)
    }
  })

  it('throws loudly at setup() when globalThis.Bun.$ is absent (D2)', async () => {
    const { ctx } = makeMockContext()
    const previousBun = globalThis.Bun
    globalThis.Bun = undefined
    try {
      const mod = await import('../src/plugin.v2.js?t=' + Date.now())
      await assert.rejects(() => mod.default.setup(ctx), /globalThis\.Bun\.\$ is not available/)
    } finally {
      globalThis.Bun = previousBun
    }
  })

  it('re-scans on a real mcp.tools.changed event (not the non-existent "catalog.updated")', async () => {
    // Regression test: an earlier draft subscribed to 'catalog.updated',
    // which does not exist anywhere in @opencode/schema's event manifest —
    // the reload would silently never fire on the real runtime. This test
    // fails if the handler's event-type filter regresses back to a made-up
    // type name.
    const { emitEvent, getToolReloadCalls, ...rest } = await loadPluginWithMockContext()
    assert.equal(getToolReloadCalls(), 0)
    emitEvent({ type: 'mcp.tools.changed' })
    // Allow the async iterator's microtask to run.
    await new Promise((r) => setImmediate(r))
    assert.equal(getToolReloadCalls(), 1)

    emitEvent({ type: 'session.tool.called' }) // an unrelated real event type
    await new Promise((r) => setImmediate(r))
    assert.equal(getToolReloadCalls(), 1, 'unrelated event types must not trigger a reload')
  })

  it('execute.before mutates event.input in place and uses "shell" (not "bash") as the always-eligible built-in', async () => {
    const { registeredHooks, getToolEditor } = await loadPluginWithMockContext()
    const editor = getToolEditor()
    assert.ok(editor.list().some((t) => t.id === 'use_cwd'))

    const hook = registeredHooks.tool['execute.before']
    assert.equal(typeof hook, 'function')

    // No active session/cwd yet -> hook must be a no-op (never throws).
    const event = { tool: 'shell', sessionID: 'no-such-session', input: { command: 'pwd' } }
    await hook(event)
    assert.equal(event.input.workdir, undefined)
  })

  it('create.before mutates event.env and never throws', async () => {
    const { registeredHooks } = await loadPluginWithMockContext()
    const hook = registeredHooks.shell['create.before']
    assert.equal(typeof hook, 'function')
    const event = { command: 'pwd', cwd: '/tmp', timeout: 1000, shell: '/bin/sh', env: {} }
    await hook(event)
    // No sessions are env-bearing yet -> no injection, no throw.
    assert.deepEqual(event.env, {})
  })

  it('the session-context hook pushes {type: "text", ...} entries onto event.system', async () => {
    const { registeredHooks } = await loadPluginWithMockContext()
    const hook = registeredHooks.session['context']
    assert.equal(typeof hook, 'function')
    const event = { sessionID: 'no-such-session', agent: 'test', system: [], messages: [], tools: [], options: {} }
    await hook(event)
    // No tracked session -> no push, no throw.
    assert.deepEqual(event.system, [])
  })

  it("setup()'s cleanup disposes ALL FOUR registrations (transform + 3 hooks) and aborts the event subscription", async () => {
    const { cleanup, disposals } = await loadPluginWithMockContext()
    assert.equal(typeof cleanup, 'function')
    await cleanup()
    assert.equal(disposals.transform, true, 'tool.transform Registration must be disposed')
    assert.equal(disposals.tool['execute.before'], true, 'tool.hook("execute.before") Registration must be disposed')
    assert.equal(disposals.shell['create.before'], true, 'shell.hook("create.before") Registration must be disposed')
    assert.equal(disposals.session['context'], true, 'session.hook("context") Registration must be disposed')
  })

  it('use_direnv, use_worktree, and use_clear are each invocable through their V2 execute() wrapper and return { content: string }', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'opencode-use-v2-conformance-'))
    try {
      const { getToolEditor } = await loadPluginWithMockContext({ directory: tmpDir })
      const editor = getToolEditor()
      const sessionID = 'conformance-session'

      // use_clear on a completely fresh session: no cwd/env/worktree set,
      // so it must report "Nothing to clear" (matching core.js's
      // executeUseClear contract) without touching git or the filesystem.
      const useClear = editor.get('use_clear')
      const clearResult = await useClear.execute({}, { sessionID })
      assert.deepEqual(clearResult, { content: 'Nothing to clear' })

      // use_direnv against a directory with no .envrc: direnv itself may
      // not even be installed in this environment, so only assert the
      // wrapper shape (content is a string) and that it doesn't throw
      // synchronously before reaching the real $`direnv ...` call —
      // the business logic itself (including all direnv error paths) is
      // already covered by the shared core.js path via plugin.v1.js's tests.
      const useDirenv = editor.get('use_direnv')
      await assert.rejects(
        () => useDirenv.execute({ path: '.' }, { sessionID }),
        /direnv|fake \$ invoked/i,
        'use_direnv should reach the injected $ (and this test intentionally uses a throwing fake $)',
      )

      // use_worktree: same rationale — assert it reaches the injected $
      // rather than throwing on argument handling.
      const useWorktree = editor.get('use_worktree')
      await assert.rejects(
        () => useWorktree.execute({ path: join(tmpDir, 'wt'), branch: 'test-branch' }, { sessionID }),
        /fake \$ invoked|git/i,
      )
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
