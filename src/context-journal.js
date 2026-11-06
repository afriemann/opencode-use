import { createHash, randomUUID } from 'node:crypto'

const PREFIX = 'context-journal/'
const VERSION = 1
const fingerprint = (value) => createHash('sha256').update(value).digest('hex')
const failure = (operation) => new Error(`Context delivery failed (${operation}); no request was sent.`)

function canonical(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
  })
}

function prefixes(messages) {
  const hashes = [fingerprint('opencode-use:host-prefix')]
  for (const message of messages) hashes.push(fingerprint(hashes.at(-1) + canonical(message)))
  return hashes
}

function validate(value) {
  if (value === undefined) return { version: VERSION, entries: [] }
  const keysAre = (item, keys) => item && typeof item === 'object' &&
    Object.keys(item).sort().join(',') === [...keys].sort().join(',')
  if ((!keysAre(value, ['version', 'entries']) && !keysAre(value, ['version', 'entries', 'prepared'])) || value.version !== VERSION || !Array.isArray(value.entries)) throw failure('journal schema')
  const ids = new Set()
  for (const record of value.prepared === undefined ? value.entries : [...value.entries, value.prepared]) {
    if (!keysAre(record, ['id', 'generation', 'offset', 'prefix', 'text']) ||
        typeof record.id !== 'string' || ids.has(record.id) ||
        typeof record.generation !== 'string' ||
        !Number.isSafeInteger(record.offset) || record.offset < 0 ||
        typeof record.prefix !== 'string' || !/^[a-f0-9]{64}$/.test(record.prefix) ||
        typeof record.text !== 'string') throw failure('journal schema')
    ids.add(record.id)
  }
  return value
}

/** Host conversation content is hashed transiently, never included in durable records. */
export function createContextJournal({ storage, sessionExists, onAbsent = async () => {} }) {
  const queues = new Map()
  const closed = new Set() // Admission tombstones live only for this plugin instance.

  function enqueue(sessionID, action) {
    const prior = queues.get(sessionID) ?? Promise.resolve()
    const next = prior.catch(() => {}).then(action)
    queues.set(sessionID, next)
    const clear = () => { if (queues.get(sessionID) === next) queues.delete(sessionID) }
    next.then(clear, clear)
    return next
  }

  async function io(operation, run) {
    try { return await run() } catch { throw failure(operation) }
  }

  async function exists(sessionID) {
    const present = await io('session existence', () => sessionExists(sessionID))
    if (typeof present !== 'boolean') throw failure('session existence')
    return present
  }

  async function requireLive(sessionID) {
    if (closed.has(sessionID)) throw failure('session deleted')
    if (!await exists(sessionID)) {
      await retireAbsent(sessionID)
      throw failure('session deleted')
    }
    if (closed.has(sessionID)) throw failure('session deleted')
  }

  async function retireAbsent(sessionID) {
    closed.add(sessionID)
    const results = await Promise.allSettled([
      io('journal erasure', () => storage.remove(PREFIX + sessionID)),
      io('execution retirement', () => onAbsent(sessionID)),
    ])
    if (results.some((result) => result.status === 'rejected')) throw failure('session erasure')
  }

  function replay(messages, records) {
    const result = []
    for (let offset = 0; offset <= messages.length; offset++) {
      for (const record of records) {
        if (record.offset === offset) result.push({
          id: record.id, role: 'user', content: [{ type: 'text', text: record.text }],
        })
      }
      if (offset < messages.length) result.push(messages[offset])
    }
    return result
  }

  return {
    render({ sessionID, messages, generation, getSnapshot }) {
      return enqueue(sessionID, async () => {
        await requireLive(sessionID)
        const key = PREFIX + sessionID
        const stored = validate(await io('journal read', () => storage.get(key)))
        const journal = { version: VERSION, entries: stored.entries }
        // Prepared records survive failed compensation but are never replayable.
        if (stored.prepared) await io('journal recovery', () => storage.set(key, journal))
        const hashes = prefixes(messages)
        const applicable = journal.entries.filter((record) => (record.offset > 0 || record.generation === generation) &&
          hashes[record.offset] === record.prefix).sort((a, b) => a.offset - b.offset)
        // A missing anchor may return after staged revert or model-dependent compaction.
        const previous = applicable.at(-1)?.text
        let provisional = false
        try { for (;;) {
          const text = await getSnapshot()
          if (typeof text !== 'string') throw failure('snapshot rendering')
          await requireLive(sessionID)
          const record = { id: `opencode-use:${randomUUID()}`, generation, offset: messages.length, prefix: hashes.at(-1), text }
          const changed = text !== previous
          const entries = changed ? [...journal.entries, record] : journal.entries
          if (changed) {
            provisional = true
            await io('journal write', () => storage.set(key, { ...journal, prepared: record }))
          } else if (provisional) {
            await io('journal restoration', () => storage.set(key, journal))
            provisional = false
          }
          await requireLive(sessionID)
          if (await getSnapshot() !== text) continue
          if (closed.has(sessionID)) throw failure('session deleted')
          if (changed) {
            await io('journal acceptance', () => storage.set(key, { version: VERSION, entries }))
            provisional = false
          }
          if (closed.has(sessionID)) throw failure('session deleted')
          return replay(messages, changed ? [...applicable, record] : applicable)
        } } catch {
          if (provisional && !closed.has(sessionID)) await io('journal restoration', () => storage.set(key, journal))
          throw failure('snapshot preparation')
        }
      })
    },

    remove(sessionID) {
      // Invalidate queued renders before waiting for an already-started write.
      closed.add(sessionID)
      return enqueue(sessionID, () => io('journal erasure', () => storage.remove(PREFIX + sessionID)))
    },

    async reconcile() {
      let after
      do {
        const page = await io('journal scan', () => storage.scan({ prefix: PREFIX, after }))
        if (!Array.isArray(page?.entries)) throw failure('journal scan')
        for (const { key } of page.entries) {
          if (typeof key !== 'string' || !key.startsWith(PREFIX)) throw failure('journal scan')
          const sessionID = key.slice(PREFIX.length)
          await enqueue(sessionID, async () => {
            if (!await exists(sessionID)) {
              await retireAbsent(sessionID)
            }
          })
        }
        if (page.next && page.next === after) throw failure('journal scan pagination')
        after = page.next
      } while (after)
    },
  }
}
