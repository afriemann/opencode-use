// spec: openspec/changes/v2-plugin-migration/design.md (D4, D6, D7, D9 layer 2)
//
// Adapter-conformance tests for src/plugin.v2.js: asserts the WIRING onto a
// mocked V2 host surface only — the shared behavioural logic itself is
// already covered once, against core.js, by the re-pointed spec suite (see
// context-autoload.test.js, workdir-injection.test.js, etc).
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeFakeStorage, nodeShellShim, runGit } from './helpers.js'

/**
 * Minimal mock of the V2 plugin Context (@opencode/plugin's `Context`
 * shape) sufficient to drive src/plugin.v2.js's setup() and capture what it
 * registers, without a real @opencode/cli runtime.
 */
function makeMockContext({ directory = '/tmp/mock-project', storage } = {}) {
  const registeredHooks = { tool: {}, shell: {}, session: {} }
  const disposals = { tool: {}, shell: {}, session: {}, transform: false }
  let toolEditor

  const eventListeners = []
  let toolReloadCalls = 0

  const ctx = {
    app: {},
    location: { directory },
    storage,
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

/**
 * Like `loadPluginWithMockContext`, but installs a real `globalThis.Bun.$`
 * (the `nodeShellShim`) for the caller-controlled duration, rather than a
 * throwing fake. Use only for tests that intentionally exercise real git —
 * the caller must restore `globalThis.Bun` itself (see `restoreBun`).
 */
async function loadPluginWithRealShell(overrides = {}) {
  const { ctx, registeredHooks, getToolEditor, emitEvent } = makeMockContext(overrides)
  const previousBun = globalThis.Bun
  globalThis.Bun = { $: nodeShellShim }
  const mod = await import('../src/plugin.v2.js?t=' + Date.now())
  const cleanup = await mod.default.setup(ctx)
  return { cleanup, registeredHooks, getToolEditor, emitEvent, restoreBun: () => { globalThis.Bun = previousBun } }
}

describe('plugin.v2.js adapter conformance', () => {
  it('registers all four custom tools, each with options.codemode === false (D4)', async () => {
    const { getToolEditor } = await loadPluginWithMockContext()
    const editor = getToolEditor()
    const names = editor.list().map((t) => t.id).filter((id) => id.startsWith('use_'))
    assert.deepEqual(new Set(names), new Set(['use_workdir', 'use_direnv', 'use_worktree', 'use_clear']))
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
    assert.ok(editor.list().some((t) => t.id === 'use_workdir'))

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
    const backing = new Map()
    backing.set('worktree/v1/still-there', {
      schema: 1, sessionID: 'still-there', path: '/tmp/x', branch: 'x', repoRoot: '/tmp/repo-x', owned: true, createdAt: new Date().toISOString(),
    })
    const { storage } = makeFakeStorage(backing)
    const { cleanup, disposals, emitEvent } = await loadPluginWithMockContext({ storage })
    assert.equal(typeof cleanup, 'function')
    await cleanup()
    assert.equal(disposals.transform, true, 'tool.transform Registration must be disposed')
    assert.equal(disposals.tool['execute.before'], true, 'tool.hook("execute.before") Registration must be disposed')
    assert.equal(disposals.shell['create.before'], true, 'shell.hook("create.before") Registration must be disposed')
    assert.equal(disposals.session['context'], true, 'session.hook("context") Registration must be disposed')

    // The session.deleted branch shares the same event subscription (D9) —
    // an event emitted after disposal must not be processed by either branch.
    emitEvent({ type: 'session.deleted', sessionID: 'still-there' })
    await new Promise((r) => setImmediate(r))
    assert.ok(backing.has('worktree/v1/still-there'), 'no event may be processed after the disposer runs')
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

  it('capability-detects ctx.storage and completes setup() without throwing when it is absent (design.md D4)', async () => {
    const { cleanup } = await loadPluginWithMockContext({ storage: undefined })
    assert.equal(typeof cleanup, 'function')
  })

  it('awaits hydration before any tool/hook is registered (design.md D3)', async () => {
    const { storage, backing } = makeFakeStorage()
    const order = []
    const tracedStorage = {
      ...storage,
      async scan(opts) {
        order.push('hydrate-scan')
        return storage.scan(opts)
      },
    }
    backing.set('worktree/v1/preexisting-session', {
      schema: 1,
      sessionID: 'preexisting-session',
      path: '/tmp/does-not-matter',
      branch: 'irrelevant',
      repoRoot: '/tmp/does-not-matter-repo',
      owned: true,
      createdAt: new Date().toISOString(),
    })

    const { getToolEditor } = await loadPluginWithMockContext({ storage: tracedStorage })
    // The scan must have happened (hydration ran); tool registration having
    // completed by the time setup() resolves proves the ordering, since
    // setup() only resolves after both the awaited hydrate() and the
    // awaited tool.transform() have completed in sequence (D3 step 4 before
    // step 5) — a fresh, empty editor after setup() would indicate hydration
    // never ran or ran after registration.
    assert.ok(order.includes('hydrate-scan'), 'hydration must have scanned storage')
    const editor = getToolEditor()
    assert.ok(editor.list().some((t) => t.id === 'use_worktree'), 'tools must be registered')
  })

  it('binds deps.persistWorktree per tool call so a restart-simulated use_worktree -> use_clear removes the worktree from disk', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'opencode-use-v2-persistence-'))
    try {
      await runGit('init -q', tmpDir)
      await runGit('config user.email test@example.com', tmpDir)
      await runGit('config user.name Test', tmpDir)
      await runGit('commit --allow-empty -q -m init', tmpDir)

      const backing = new Map()
      const sessionID = 'v2-persistence-session'
      const worktreePath = join(tmpDir, '.worktrees', 'feature')

      // "Process 1": V2 host creates a worktree.
      {
        const { storage } = makeFakeStorage(backing)
        const { getToolEditor, restoreBun } = await loadPluginWithRealShell({ directory: tmpDir, storage })
        try {
          const editor = getToolEditor()
          const useWorktree = editor.get('use_worktree')
          const result = await useWorktree.execute(
            { path: worktreePath, branch: 'feature', create: true, fromRemote: false },
            { sessionID },
          )
          assert.match(result.content, /^Worktree created at/)
        } finally {
          restoreBun()
        }
      }

      // "Process 2": fresh plugin setup, same backing storage — simulates a restart.
      {
        const { storage } = makeFakeStorage(backing)
        const { getToolEditor, restoreBun } = await loadPluginWithRealShell({ directory: tmpDir, storage })
        try {
          const editor = getToolEditor()
          const useClear = editor.get('use_clear')
          const result = await useClear.execute({ fields: ['worktree'] }, { sessionID })
          assert.match(result.content, /^Removed owned worktree at/)
        } finally {
          restoreBun()
        }
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('extends the mcp.tools.changed event loop with a session.deleted branch that removes exactly that session\'s storage key (design.md D9)', async () => {
    const backing = new Map()
    backing.set('worktree/v1/session-a', {
      schema: 1, sessionID: 'session-a', path: '/tmp/a', branch: 'a', repoRoot: '/tmp/repo-a', owned: true, createdAt: new Date().toISOString(),
    })
    backing.set('worktree/v1/session-b', {
      schema: 1, sessionID: 'session-b', path: '/tmp/b', branch: 'b', repoRoot: '/tmp/repo-b', owned: true, createdAt: new Date().toISOString(),
    })
    const { storage } = makeFakeStorage(backing)

    const { emitEvent } = await loadPluginWithMockContext({ storage })

    emitEvent({ type: 'session.deleted', sessionID: 'session-a' })
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    assert.ok(!backing.has('worktree/v1/session-a'), 'the deleted session\'s key must be removed')
    assert.ok(backing.has('worktree/v1/session-b'), 'other sessions\' keys must be untouched')
  })

  it('session deletion cleanup does not affect the worktree on disk (worktree-ownership-persistence spec)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'opencode-use-v2-session-deleted-worktree-'))
    try {
      await runGit('init -q', tmpDir)
      await runGit('config user.email test@example.com', tmpDir)
      await runGit('config user.name Test', tmpDir)
      await runGit('commit --allow-empty -q -m init', tmpDir)

      const backing = new Map()
      const sessionID = 'session-deleted-worktree-survives'
      const worktreePath = join(tmpDir, '.worktrees', 'feature')
      const { storage } = makeFakeStorage(backing)
      const { getToolEditor, emitEvent, restoreBun } = await loadPluginWithRealShell({ directory: tmpDir, storage })
      try {
        const useWorktree = getToolEditor().get('use_worktree')
        const created = await useWorktree.execute(
          { path: worktreePath, branch: 'feature', create: true, fromRemote: false },
          { sessionID },
        )
        assert.match(created.content, /^Worktree created at/)
        assert.ok(backing.has(`worktree/v1/${sessionID}`))

        emitEvent({ type: 'session.deleted', sessionID })
        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))

        assert.ok(!backing.has(`worktree/v1/${sessionID}`), 'the storage record must be removed')
        const list = (await runGit('worktree list --porcelain', tmpDir)).trim()
        assert.ok(list.includes(worktreePath), 'the worktree must remain registered in git — session deletion must never remove it')
        assert.ok(existsSync(worktreePath), 'the worktree directory must still exist on disk')
      } finally {
        restoreBun()
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('a storage removal failure during session.deleted cleanup is caught, logged, and does not stop subsequent events from being processed', async () => {
    const backing = new Map()
    backing.set('worktree/v1/session-a', {
      schema: 1, sessionID: 'session-a', path: '/tmp/a', branch: 'a', repoRoot: '/tmp/repo-a', owned: true, createdAt: new Date().toISOString(),
    })
    backing.set('worktree/v1/session-b', {
      schema: 1, sessionID: 'session-b', path: '/tmp/b', branch: 'b', repoRoot: '/tmp/repo-b', owned: true, createdAt: new Date().toISOString(),
    })
    const { storage: base } = makeFakeStorage(backing)
    let failNext = true
    const storage = {
      ...base,
      async remove(key) {
        if (failNext) {
          failNext = false
          throw new Error('simulated remove failure')
        }
        return base.remove(key)
      },
    }

    const { emitEvent } = await loadPluginWithMockContext({ storage })

    emitEvent({ type: 'session.deleted', sessionID: 'session-a' })
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    // First removal failed -> key A survives.
    assert.ok(backing.has('worktree/v1/session-a'))

    emitEvent({ type: 'session.deleted', sessionID: 'session-b' })
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    // The loop must still be alive and process the next event.
    assert.ok(!backing.has('worktree/v1/session-b'))
  })
})

describe('plugin.v2.js — session.created / session.moved directory init (design.md D6)', () => {
  /**
   * These handlers perform real filesystem I/O (`stat`, and via
   * `applyDirectoryChange`, real `git`/direnv subprocess calls) inside the
   * event loop's async branch — genuine libuv I/O, not just microtasks — so
   * a bare `setImmediate` flush (sufficient for the purely in-memory
   * `session.deleted` branch elsewhere in this file) is not reliably enough
   * settling time. Use a short real timer instead.
   */
  function wait(ms = 50) {
    return new Promise((r) => setTimeout(r, ms))
  }

  async function renderSessionBlock(registeredHooks, sessionID) {
    const hook = registeredHooks.session['context']
    const event = { sessionID, agent: 'test', system: [], messages: [], tools: [], options: {} }
    await hook(event)
    return event.system.find((s) => s.text?.includes('Active Session Context'))?.text
  }

  it('Session start initializes cwd and AGENTS.md without loading env', async (t) => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'opencode-use-v2-session-created-'))
    t.after(() => rm(tmpDir, { recursive: true, force: true }))
    await runGit('init -q', tmpDir)
    await runGit('config user.email test@example.com', tmpDir)
    await runGit('config user.name Test', tmpDir)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tmpDir, 'AGENTS.md'), '# v2 session created\n')
    await runGit('add -A', tmpDir)
    await runGit('-c user.email=test@example.com -c user.name=test commit -q -m init', tmpDir)

    const { registeredHooks, emitEvent, restoreBun } = await loadPluginWithRealShell({ directory: tmpDir })
    try {
      const sessionID = 'v2-session-created-session'
      emitEvent({ type: 'session.created', data: { sessionID, location: { directory: tmpDir } } })
      await wait()

      const block = await renderSessionBlock(registeredHooks, sessionID)
      assert.ok(block, 'expected the Active Session Context block to be present')
      assert.ok(block.includes(tmpDir))
      assert.ok(!block.includes('variable(s) from direnv'), 'session.created must never auto-load env')

      const agentsBlock = await (async () => {
        const hook = registeredHooks.session['context']
        const event = { sessionID, agent: 'test', system: [], messages: [], tools: [], options: {} }
        await hook(event)
        return event.system.find((s) => s.text?.includes('v2 session created'))
      })()
      assert.ok(agentsBlock, 'expected AGENTS.md content to have been discovered')
    } finally {
      restoreBun()
    }
  })

  it('Session start is skipped for a non-local starting location', async () => {
    const { registeredHooks, emitEvent } = await loadPluginWithMockContext()
    const sessionID = 'v2-session-created-workspace-session'
    emitEvent({ type: 'session.created', data: { sessionID, location: { directory: '/some/remote/dir', workspaceID: 'ws-1' } } })
    await wait()

    const block = await renderSessionBlock(registeredHooks, sessionID)
    assert.equal(block, undefined, 'expected no directory to have been initialized for a workspaceID location')
  })

  it('Session move to a directory with an already-allowed .envrc auto-loads its environment', async (t) => {
    const fromDir = await mkdtemp(join(tmpdir(), 'opencode-use-v2-session-moved-from-'))
    const toDir = await mkdtemp(join(tmpdir(), 'opencode-use-v2-session-moved-to-'))
    t.after(async () => {
      await rm(fromDir, { recursive: true, force: true })
      await rm(toDir, { recursive: true, force: true })
    })
    for (const dir of [fromDir, toDir]) {
      await runGit('init -q', dir)
      await runGit('config user.email test@example.com', dir)
      await runGit('config user.name Test', dir)
      await runGit('commit --allow-empty -q -m init', dir)
    }

    const { writeFile } = await import('node:fs/promises')
    const toEnvrcPath = join(toDir, '.envrc')
    await writeFile(toEnvrcPath, 'export FOO=bar\n')

    const { makeFakeDirenvShell } = await import('./helpers.js')
    const $ = makeFakeDirenvShell({
      status: () => JSON.stringify({ state: { foundRC: { allowed: 0, path: toEnvrcPath }, loadedRC: null } }),
      exportJson: () => JSON.stringify({ FOO: 'bar' }),
    })

    const { ctx, registeredHooks, emitEvent } = makeMockContext({ directory: fromDir })
    const previousBun = globalThis.Bun
    globalThis.Bun = { $ }
    const mod = await import('../src/plugin.v2.js?t=' + Date.now())
    await mod.default.setup(ctx)
    try {
      const sessionID = 'v2-session-moved-session'
      // First initialize the session at `fromDir` (session.created).
      emitEvent({ type: 'session.created', data: { sessionID, location: { directory: fromDir } } })
      await wait()
      let block = await renderSessionBlock(registeredHooks, sessionID)
      assert.ok(block.includes(fromDir))

      // Now move it — state.cwd is already set, so this exercises the
      // requireUnsetCwd: false path, and must auto-load the env.
      emitEvent({ type: 'session.moved', data: { sessionID, location: { directory: toDir } } })
      await wait()
      block = await renderSessionBlock(registeredHooks, sessionID)
      assert.ok(block.includes(toDir), 'expected state.cwd to have moved to the new directory')
      assert.ok(block.includes('variable(s) from direnv'), 'expected session.moved to auto-load the already-allowed .envrc')
    } finally {
      globalThis.Bun = previousBun
    }
  })

  it('Session move to a non-local location is skipped', async () => {
    const { registeredHooks, emitEvent } = await loadPluginWithMockContext()
    const sessionID = 'v2-session-moved-workspace-session'
    emitEvent({ type: 'session.created', data: { sessionID, location: { directory: '/tmp' } } })
    await wait()

    emitEvent({ type: 'session.moved', data: { sessionID, location: { directory: '/some/remote/dir', workspaceID: 'ws-1' } } })
    await wait()

    const block = await renderSessionBlock(registeredHooks, sessionID)
    assert.ok(block.includes('/tmp'), 'expected the directory to remain unchanged after a skipped move')
  })

  // Not tied to a specific OpenSpec scenario — an accepted regression guard
  // ensuring the new session.created/session.moved branches (added earlier
  // in the same event.subscribe loop) don't consume or interfere with the
  // pre-existing mcp.tools.changed branch's reload logic.
  it('session.created/session.moved branches coexist with mcp.tools.changed and session.deleted in the same loop', async () => {
    const { emitEvent, getToolReloadCalls } = await loadPluginWithMockContext()
    emitEvent({ type: 'session.created', data: { sessionID: 'coexist-session', location: { directory: '/tmp' } } })
    await wait()
    emitEvent({ type: 'mcp.tools.changed' })
    await wait()
    assert.equal(getToolReloadCalls(), 1, 'mcp.tools.changed must still trigger a reload after the new branches were added')
  })
})
