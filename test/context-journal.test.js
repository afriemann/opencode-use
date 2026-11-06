import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createContextJournal } from '../src/context-journal.js'
import { buildSessionContextSnapshot } from '../src/core.js'
import { makeFakeStorage } from './helpers.js'

const user = (text, id = text) => ({ id, role: 'user', content: [{ type: 'text', text }] })
const text = (message) => message.content.map((part) => part.text ?? '').join('')
function fixture(options = {}) {
  const { storage, backing } = makeFakeStorage(new Map(), { scanLimit: 1 })
  const present = new Set(['one', 'two'])
  const sessionExists = async (id) => present.has(id)
  const journal = createContextJournal({ storage, sessionExists, ...options })
  const render = (messages, snapshot = 'snapshot A', extra = {}) => journal.render({
    sessionID: 'one', messages, generation: 'initial', getSnapshot: async () => snapshot, ...extra,
  })
  return { storage, backing, present, sessionExists, journal, render }
}

// spec: openspec/specs/workdir-injection/spec.md
describe('Anchored context delivery', () => {
  it('Unchanged tool loops preserve delivered context positions', async () => {
    const { render } = fixture()
    const host = [user('request')]
    const first = await render(host)
    assert.equal(first.length, 2, 'initial snapshot must be delivered')
    const continuation = { role: 'tool', content: [{ type: 'tool-result', id: 'call', name: 'shell', result: 'done' }] }
    const second = await render([...host, continuation])
    assert.deepEqual(second.slice(0, first.length), first)
    assert.deepEqual(second.at(-1), continuation)
    assert.deepEqual(await render([...host, continuation]), second, 'same request must not accumulate snapshots')
  })

  it('Context transitions append replacement snapshots', async () => {
    const { render, storage, backing, sessionExists } = fixture()
    const host = [user('request')]
    const first = await render(host)
    const next = await render([...host, user('continuation')], 'snapshot B')
    assert.deepEqual(next.slice(0, first.length), first)
    assert.equal(text(next.at(-1)), 'snapshot B')
    assert.equal(next.length, 4)
    let current = 'snapshot B'
    const set = storage.set
    storage.set = async (key, value) => { await set(key, value); current = 'snapshot B' }
    current = 'undelivered snapshot C'
    const stableHost = [...host, user('continuation'), user('race')]
    const settled = await render(stableHost, undefined, { getSnapshot: async () => current })
    assert.ok(!JSON.stringify([...backing.values()]).includes('undelivered snapshot C'), 'returning to the delivered snapshot must restore durable history')
    assert.ok(!JSON.stringify(settled).includes('undelivered snapshot C'))
    const reloaded = createContextJournal({ storage, sessionExists })
    const replayed = await reloaded.render({ sessionID: 'one', messages: [...stableHost, user('resume')], generation: 'initial', getSnapshot: async () => current })
    assert.deepEqual(replayed.slice(0, settled.length), settled, 'reload must not insert a provisional snapshot into the delivered prefix')
  })

  it('Plugin reload replays context without restoring execution state', async () => {
    const { storage, sessionExists, render } = fixture()
    const host = [user('request')]
    const first = await render(host)
    const reloaded = createContextJournal({ storage, sessionExists })
    const next = await reloaded.render({ sessionID: 'one', messages: [...host, user('resume')], generation: 'initial', getSnapshot: async () => 'live state without loaded env' })
    assert.deepEqual(next.slice(0, first.length), first)
    assert.equal(text(next.at(-1)), 'live state without loaded env')
  })

  it("Forks do not inherit another session's journal", async () => {
    const { render } = fixture()
    await render([user('request')])
    const fork = await render([user('request'), user('fork')], 'fork snapshot', { sessionID: 'two' })
    assert.equal(fork.length, 3)
    assert.equal(text(fork.at(-1)), 'fork snapshot')
    assert.ok(!fork.some((message) => text(message) === 'snapshot A'))
  })

  it('Reversible history windows retain dormant snapshots', async () => {
    const { render, backing } = fixture()
    const host = [user('original')]
    const first = await render(host)
    for (const window of [[user('text summary')], [{ role: 'user', content: [{ type: 'text', text: 'native window' }] }]]) {
      const compacted = await render(window, 'current', { generation: 'checkpoint' })
      assert.equal(compacted.length, 2)
      assert.ok(!compacted.some((message) => text(message) === 'snapshot A'))
    }
    const restored = await render(host, 'snapshot A', { generation: 'checkpoint' })
    assert.deepEqual(restored, first, 'returning history must restore the exact original ordering')
    assert.ok(JSON.stringify([...backing.values()]).includes('snapshot A'))
  })

  it('Invalidated transcript suffixes never relocate snapshots', async () => {
    const { render } = fixture()
    await render([user('first'), user('old', 'same-id')])
    const changed = await render([user('different'), user('new', 'same-id')], 'new state')
    assert.equal(changed.length, 3)
    assert.ok(!changed.some((message) => text(message) === 'snapshot A'))
    const emptyFirst = await render([], 'empty initial', { generation: 'epoch one' })
    const emptyNext = await render([], 'empty checkpoint', { generation: 'epoch two' })
    assert.equal(emptyFirst.length, 1)
    assert.deepEqual(emptyNext.map(text), ['empty checkpoint'])
  })

  it('Persisted journal excludes execution and host conversation data', async () => {
    const { render, backing } = fixture()
    const state = { cwd: '/synthetic', envSource: '/synthetic', env: { EXAMPLE: 'private-environment-value' }, worktree: null, agentsMd: null }
    const snapshot = buildSessionContextSnapshot(state)
    await render([user('private-host-message')], snapshot)
    const saved = JSON.stringify([...backing.values()])
    assert.ok(saved.includes('Session Context Snapshot'))
    assert.ok(!saved.includes('private-host-message'))
    assert.ok(!saved.includes('private-environment-value'))
    assert.ok(!saved.includes('envSource'))
  })

  it('Clearing context does not silently rewrite retained history', async () => {
    const { render } = fixture()
    const host = [user('request')]
    const first = await render(host, 'selected advisory')
    const cleared = await render([...host, user('clear')], 'Repository advisory: none')
    assert.deepEqual(cleared.slice(0, first.length), first)
    assert.equal(text(cleared.at(-1)), 'Repository advisory: none')
  })

  it('Session deletion drains pending writes before final erasure', async () => {
    let writing, release
    const started = new Promise((resolve) => { writing = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    const { journal, render, storage, backing, present } = fixture()
    const set = storage.set
    storage.set = async (...args) => { writing(); await gate; await set(...args) }
    const pending = render([user('request')])
    assert.equal(await Promise.race([started.then(() => true), pending.then(() => false)]), true, 'journal must persist before delivery')
    present.delete('one')
    const removal = journal.remove('one')
    release()
    await assert.rejects(pending, /Context delivery failed/)
    await removal
    assert.equal(backing.size, 0)
    await assert.rejects(render([user('late')]), /Context delivery failed/)
  })

  it('Missed deletion events are reconciled authoritatively', async () => {
    const { render, journal, present, backing } = fixture()
    await render([user('one')])
    await render([user('two')], 'second snapshot', { sessionID: 'two' })
    present.delete('one')
    await journal.reconcile()
    assert.equal(backing.size, 1)
    assert.ok(JSON.stringify([...backing.values()]).includes('second snapshot'))
  })

  it('Unsafe context delivery fails before provider dispatch', async () => {
    for (const failure of ['read', 'write', 'invalid', 'existence']) {
      const f = fixture()
      if (failure === 'read') f.storage.get = async () => { throw new Error('private read details') }
      if (failure === 'write') f.storage.set = async () => { throw new Error('private storage exhaustion details') }
      if (failure === 'invalid') f.storage.get = async () => ({ version: 99 })
      const journal = createContextJournal({ storage: f.storage, sessionExists: failure === 'existence' ? async () => { throw new Error('private API details') } : f.sessionExists })
      await assert.rejects(journal.render({ sessionID: 'one', messages: [user('request')], generation: 'initial', getSnapshot: async () => 'current' }), (error) => {
        assert.match(error.message, /Context delivery failed/)
        assert.ok(!error.message.includes('private'))
        return true
      }, failure)
    }
    for (const outcome of ['existence', 'snapshot', 'restoration']) {
      const f = fixture()
      const host = [user('original')]
      const delivered = await f.render(host)
      let prepared = false
      let rejected = false
      const set = f.storage.set
      f.storage.set = async (key, value) => {
        if (prepared && outcome === 'restoration') throw new Error('fixture restoration failure')
        await set(key, value)
        prepared = true
      }
      const journal = createContextJournal({ storage: f.storage, sessionExists: async (id) => {
        if (prepared && outcome === 'existence' && !rejected) { rejected = true; throw new Error('fixture existence failure') }
        return f.present.has(id)
      } })
      await assert.rejects(journal.render({ sessionID: 'one', messages: host, generation: 'initial', getSnapshot: async () => {
        if (prepared && outcome !== 'existence') throw new Error('fixture snapshot failure')
        return 'undelivered snapshot'
      } }), /Context delivery failed|fixture snapshot failure/)
      f.storage.set = set
      const reloaded = createContextJournal({ storage: f.storage, sessionExists: f.sessionExists })
      const resumed = await reloaded.render({ sessionID: 'one', messages: [...host, user('resume')], generation: 'initial', getSnapshot: async () => 'snapshot A' })
      assert.deepEqual(resumed.slice(0, delivered.length), delivered, `${outcome}: rejected snapshots must never enter historical replay`)
      assert.ok(!JSON.stringify(resumed).includes('undelivered snapshot'))
    }
  })

  // spec: openspec/specs/context-autoload/spec.md
  it('User-message snapshots do not confer user authority', async () => {
    const { render } = fixture()
    const messages = await render([user('request')], buildSessionContextSnapshot({ cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null }))
    assert.equal(messages.at(-1).role, 'user')
    assert.match(text(messages.at(-1)), /Plugin-generated metadata, not a human-authored request/)
  })
})
