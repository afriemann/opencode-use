// spec: openspec/changes/persist-session-state-v2-storage/specs/worktree-ownership-persistence/spec.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  createSessionStore,
  createWorktreePersistence,
  executeUseWorktree,
  executeUseClear,
  HYDRATION_TIMEOUT_MS,
} from '../src/core.js'
import {
  makeTempRepo,
  nodeShellShim,
  runGit,
  makeFakeStorage,
  makeFailingStorage,
} from './helpers.js'

function makeDeps({ repo, persistWorktree } = {}) {
  return {
    $: nodeShellShim,
    log: () => {},
    directory: repo,
    persistWorktree,
  }
}

describe('Persisted Worktree Ownership Record', () => {
  it('worktree ownership is persisted on creation', async (t) => {
    const repo = await makeTempRepo(t, 'wop-create-')
    const { storage, backing } = makeFakeStorage()
    const persistence = createWorktreePersistence(storage)
    const sessionID = 'wop-create-session'
    const state = { cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null }
    const deps = makeDeps({ repo, persistWorktree: persistence.forSession(sessionID) })
    const worktreePath = join(repo, '.worktrees', 'feature')

    await executeUseWorktree({ path: worktreePath, branch: 'feature', create: true, fromRemote: false }, state, deps)

    const record = backing.get(`worktree/v1/${sessionID}`)
    assert.ok(record, 'a persisted record must exist')
    assert.equal(record.schema, 1)
    assert.equal(record.sessionID, sessionID)
    assert.equal(record.path, worktreePath)
    assert.equal(record.branch, 'feature')
    assert.equal(record.repoRoot, repo)
    assert.equal(record.owned, true)
  })

  it('worktree ownership is persisted on reuse', async (t) => {
    const repo = await makeTempRepo(t, 'wop-reuse-')
    const worktreePath = join(repo, '.worktrees', 'feature')
    await runGit(`worktree add -b feature ${worktreePath}`, repo)

    const { storage, backing } = makeFakeStorage()
    const persistence = createWorktreePersistence(storage)
    const sessionID = 'wop-reuse-session'
    const state = { cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null }
    const deps = makeDeps({ repo, persistWorktree: persistence.forSession(sessionID) })

    await executeUseWorktree({ path: worktreePath, branch: 'feature', create: false }, state, deps)

    const record = backing.get(`worktree/v1/${sessionID}`)
    assert.ok(record)
    assert.equal(record.owned, false)
  })

  it('worktree ownership record is removed on clear', async (t) => {
    const repo = await makeTempRepo(t, 'wop-clear-')
    const { storage, backing } = makeFakeStorage()
    const persistence = createWorktreePersistence(storage)
    const sessionID = 'wop-clear-session'
    const state = { cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null }
    const deps = makeDeps({ repo, persistWorktree: persistence.forSession(sessionID) })
    const worktreePath = join(repo, '.worktrees', 'feature')

    await executeUseWorktree({ path: worktreePath, branch: 'feature', create: true, fromRemote: false }, state, deps)
    assert.ok(backing.has(`worktree/v1/${sessionID}`))

    await executeUseClear({ fields: ['worktree'] }, state, deps)
    assert.ok(!backing.has(`worktree/v1/${sessionID}`), 'the persisted record must be removed')
  })

  it('V1 runtime persists nothing (no persistWorktree bound)', async (t) => {
    const repo = await makeTempRepo(t, 'wop-v1-')
    const state = { cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null }
    const deps = makeDeps({ repo }) // no persistWorktree — simulates V1
    const worktreePath = join(repo, '.worktrees', 'feature')

    const result = await executeUseWorktree(
      { path: worktreePath, branch: 'feature', create: true, fromRemote: false },
      state,
      deps,
    )

    assert.match(result, /^Worktree created at/)
    assert.ok(!result.includes('could not be persisted'), 'no disclosure note when persistence was never requested')
  })

  it('per-session writes are serialized in issue order even when interleaved without awaiting', async (t) => {
    const repo = await makeTempRepo(t, 'wop-fifo-')
    const { storage } = makeFakeStorage()
    const seenOrder = []
    const tracedStorage = {
      ...storage,
      async set(key, value) {
        seenOrder.push(`set:${value.owned}`)
        return storage.set(key, value)
      },
      async remove(key) {
        seenOrder.push('remove')
        return storage.remove(key)
      },
    }
    const persistence = createWorktreePersistence(tracedStorage)
    const sessionID = 'wop-fifo-session'
    const persistWorktree = persistence.forSession(sessionID)

    // Fire three calls back-to-back without awaiting the first two — the
    // persistence layer's per-session FIFO chain (design.md D6) must still
    // land them at the underlying storage in issue order.
    const p1 = persistWorktree.save({ path: '/tmp/a', branch: 'a', repoRoot: repo, owned: true })
    const p2 = persistWorktree.remove()
    const p3 = persistWorktree.save({ path: '/tmp/a', branch: 'a', repoRoot: repo, owned: false })
    await Promise.all([p1, p2, p3])

    assert.deepEqual(seenOrder, ['set:true', 'remove', 'set:false'])
  })
})

describe('Eager Hydration And Ground-Truth Validation At Startup', () => {
  it('restart-then-use_clear: a worktree owned by a prior process is still recognized and removed (headline regression)', async (t) => {
    const repo = await makeTempRepo(t, 'wop-restart-')
    const backing = new Map()
    const sessionID = 'wop-restart-session'
    const worktreePath = join(repo, '.worktrees', 'feature')

    // "Process 1": creates the worktree.
    {
      const { storage } = makeFakeStorage(backing)
      const persistence = createWorktreePersistence(storage)
      const state = { cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null }
      const deps = makeDeps({ repo, persistWorktree: persistence.forSession(sessionID) })
      await executeUseWorktree({ path: worktreePath, branch: 'feature', create: true, fromRemote: false }, state, deps)
    }

    // "Process 2": fresh session store + fresh persistence over the same backing Map.
    const { sessions, getState } = createSessionStore()
    const { storage } = makeFakeStorage(backing)
    const persistence = createWorktreePersistence(storage)
    const result = await persistence.hydrate({ sessions, $: nodeShellShim, log: () => {} })
    assert.equal(result.restored, 1)

    const restoredState = getState(sessionID)
    assert.deepEqual(restoredState.worktree, { path: worktreePath, owned: true })

    const deps = makeDeps({ repo, persistWorktree: persistence.forSession(sessionID) })
    const clearResult = await executeUseClear({ fields: ['worktree'] }, restoredState, deps)
    assert.match(clearResult, /^Removed owned worktree at/)

    const list = (await runGit('worktree list --porcelain', repo)).trim()
    assert.ok(!list.includes(worktreePath), 'worktree must be deregistered from git')
  })

  it('a record for a worktree removed from disk/git is dropped and its key deleted', async (t) => {
    const repo = await makeTempRepo(t, 'wop-stale-')
    const worktreePath = join(repo, '.worktrees', 'feature')
    const { storage, backing } = makeFakeStorage()
    backing.set('worktree/v1/stale-session', {
      schema: 1,
      sessionID: 'stale-session',
      path: worktreePath,
      branch: 'feature',
      repoRoot: repo,
      owned: true,
      createdAt: new Date().toISOString(),
    })

    const persistence = createWorktreePersistence(storage)
    const { sessions, getState } = createSessionStore()
    const result = await persistence.hydrate({ sessions, $: nodeShellShim, log: () => {} })

    assert.equal(result.dropped, 1)
    assert.equal(result.restored, 0)
    assert.ok(!backing.has('worktree/v1/stale-session'))
    assert.equal(getState('stale-session').worktree, null)
  })

  it('a record whose branch no longer matches the registered branch at that path is dropped', async (t) => {
    const repo = await makeTempRepo(t, 'wop-branch-mismatch-')
    const worktreePath = join(repo, '.worktrees', 'other-branch')
    await runGit(`worktree add -b other-branch ${worktreePath}`, repo)

    const { storage, backing } = makeFakeStorage()
    backing.set('worktree/v1/mismatch-session', {
      schema: 1,
      sessionID: 'mismatch-session',
      path: worktreePath,
      branch: 'expected-branch', // does not match what's actually registered
      repoRoot: repo,
      owned: true,
      createdAt: new Date().toISOString(),
    })

    const persistence = createWorktreePersistence(storage)
    const { sessions, getState } = createSessionStore()
    const result = await persistence.hydrate({ sessions, $: nodeShellShim, log: () => {} })

    assert.equal(result.dropped, 1)
    assert.ok(!backing.has('worktree/v1/mismatch-session'))
    assert.equal(getState('mismatch-session').worktree, null)
  })

  it('hydration across two distinct repoRoots only restores the valid one when the other repo is unreadable', async (t) => {
    const goodRepo = await makeTempRepo(t, 'wop-multi-good-')
    const goodPath = join(goodRepo, '.worktrees', 'feature')
    await runGit(`worktree add -b feature ${goodPath}`, goodRepo)

    const vanishedRepo = '/nonexistent/definitely-not-a-repo-xyz'
    const vanishedPath = join(vanishedRepo, '.worktrees', 'feature')

    const { storage, backing } = makeFakeStorage()
    backing.set('worktree/v1/good-session', {
      schema: 1, sessionID: 'good-session', path: goodPath, branch: 'feature',
      repoRoot: goodRepo, owned: true, createdAt: new Date().toISOString(),
    })
    backing.set('worktree/v1/vanished-session', {
      schema: 1, sessionID: 'vanished-session', path: vanishedPath, branch: 'feature',
      repoRoot: vanishedRepo, owned: true, createdAt: new Date().toISOString(),
    })

    const persistence = createWorktreePersistence(storage)
    const { sessions, getState } = createSessionStore()
    const result = await persistence.hydrate({ sessions, $: nodeShellShim, log: () => {} })

    assert.equal(result.restored, 1)
    assert.deepEqual(getState('good-session').worktree, { path: goodPath, owned: true })
    assert.equal(getState('vanished-session').worktree, null)
    // Unreadable repo -> skipped, key kept (not removed) for a future retry.
    assert.ok(backing.has('worktree/v1/vanished-session'))
  })

  it('hydration never blocks or fails startup, even with storage errors and mixed record validity', async (t) => {
    const repo = await makeTempRepo(t, 'wop-never-blocks-')
    const { storage, backing } = makeFakeStorage()
    backing.set('worktree/v1/malformed', { not: 'a valid record' })

    const persistence = createWorktreePersistence(storage)
    const { sessions } = createSessionStore()
    const start = Date.now()
    const result = await persistence.hydrate({ sessions, $: nodeShellShim, log: () => {} })
    const elapsed = Date.now() - start

    assert.ok(elapsed < HYDRATION_TIMEOUT_MS, 'hydration must complete well within the timeout budget for a small scan')
    assert.equal(result.dropped, 1)
    assert.ok(!backing.has('worktree/v1/malformed'))
  })

  it('an artificially slow git call is bounded by HYDRATION_TIMEOUT_MS: hydration completes on time, restores nothing for that repo, and leaves its key intact', async (t) => {
    const repo = await makeTempRepo(t, 'wop-slow-')
    const worktreePath = join(repo, '.worktrees', 'feature')
    await runGit(`worktree add -b feature ${worktreePath}`, repo)

    const { storage, backing } = makeFakeStorage()
    backing.set('worktree/v1/slow-session', {
      schema: 1, sessionID: 'slow-session', path: worktreePath, branch: 'feature',
      repoRoot: repo, owned: true, createdAt: new Date().toISOString(),
    })

    const slowShim = (strings, ...values) => {
      const builder = nodeShellShim(strings, ...values)
      const originalText = builder.text.bind(builder)
      builder.text = () =>
        new Promise((resolvePromise) => setTimeout(() => resolvePromise(originalText()), HYDRATION_TIMEOUT_MS + 500))
      return builder
    }

    const persistence = createWorktreePersistence(storage)
    const { sessions, getState } = createSessionStore()
    const start = Date.now()
    const result = await persistence.hydrate({ sessions, $: slowShim, log: () => {} })
    const elapsed = Date.now() - start

    assert.ok(elapsed < HYDRATION_TIMEOUT_MS + 400, 'hydration must not wait for the slow git call to finish')
    assert.equal(result.restored, 0)
    assert.equal(getState('slow-session').worktree, null, 'not restored for this startup')
    assert.ok(backing.has('worktree/v1/slow-session'), 'key must be kept — inconclusive, not invalid')

    // Regression guard: the slow git call is still resolving in the
    // background even after hydrate() returned. It must remain a pure
    // no-op — never restoring the session late and racing a tool call that
    // already assumed no worktree was set (design.md D4's cancellation guard).
    await new Promise((r) => setTimeout(r, 700))
    assert.equal(getState('slow-session').worktree, null, 'a late-resolving validation must not mutate state after hydrate() has returned')
  })
})

describe('Graceful Degradation When Durable Storage Is Unavailable', () => {
  it('storage absent at startup: createWorktreePersistence returns null and callers no-op', async (t) => {
    assert.equal(createWorktreePersistence(undefined), null)
    assert.equal(createWorktreePersistence({}), null)
    assert.equal(createWorktreePersistence({ get: async () => {}, set: async () => {} }), null, 'partial adapter must also degrade to null')

    const repo = await makeTempRepo(t, 'wop-absent-')
    const state = { cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null }
    const deps = makeDeps({ repo, persistWorktree: undefined })
    const worktreePath = join(repo, '.worktrees', 'feature')

    const result = await executeUseWorktree(
      { path: worktreePath, branch: 'feature', create: true, fromRemote: false },
      state,
      deps,
    )
    assert.match(result, /^Worktree created at/)
  })

  it('a storage write fails after a successful worktree operation: the tool still succeeds, with a disclosure note', async (t) => {
    const repo = await makeTempRepo(t, 'wop-write-fails-')
    const { storage } = makeFailingStorage(new Map(), { failOn: ['set'] })
    const persistence = createWorktreePersistence(storage)
    const sessionID = 'wop-write-fails-session'
    const state = { cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null }
    const deps = makeDeps({ repo, persistWorktree: persistence.forSession(sessionID) })
    const worktreePath = join(repo, '.worktrees', 'feature')

    const result = await executeUseWorktree(
      { path: worktreePath, branch: 'feature', create: true, fromRemote: false },
      state,
      deps,
    )

    assert.match(result, /^Worktree created at/)
    assert.ok(result.includes('could not be persisted'), 'the save failure must be disclosed')
    assert.deepEqual(state.worktree, { path: worktreePath, owned: true }, 'the in-memory state must still reflect success')
  })
})
