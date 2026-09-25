// spec: openspec/changes/direnv-automation/specs/context-autoload/spec.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { isDirenvStatusAllowed, checkDirenvAllowed, DIRENV_TIMEOUT_MS } from '../src/lib.js'
import { makeFakeDirenvShell } from './helpers.js'

function noopLog() {}

const ENVRC = '/repo/.envrc'

// Pinned verbatim against a real direnv 2.37.1 process (see design.md D2).
const FIXTURES = {
  allowed: { state: { foundRC: { allowed: 0, path: ENVRC }, loadedRC: null } },
  notYetAllowed: { state: { foundRC: { allowed: 1, path: ENVRC }, loadedRC: null } },
  denied: { state: { foundRC: { allowed: 2, path: ENVRC }, loadedRC: null } },
  noRC: { state: { foundRC: null, loadedRC: null } },
}

describe('isDirenvStatusAllowed (pure predicate, pinned direnv 2.37.1 fixtures)', () => {
  it('allowed (foundRC.allowed === 0, matching path)', () => {
    assert.equal(isDirenvStatusAllowed(FIXTURES.allowed, ENVRC), true)
  })

  it('not-yet-allowed (foundRC.allowed === 1, never approved)', () => {
    assert.equal(isDirenvStatusAllowed(FIXTURES.notYetAllowed, ENVRC), false)
  })

  it('explicitly denied (foundRC.allowed === 2, via direnv deny)', () => {
    assert.equal(isDirenvStatusAllowed(FIXTURES.denied, ENVRC), false)
  })

  it('no .envrc found anywhere in direnv\'s own unbounded upward search', () => {
    assert.equal(isDirenvStatusAllowed(FIXTURES.noRC, ENVRC), false)
  })

  it('status reports a different RC path than the one discovery found', () => {
    const differentPath = { state: { foundRC: { allowed: 0, path: '/some/other/.envrc' }, loadedRC: null } }
    assert.equal(isDirenvStatusAllowed(differentPath, ENVRC), false)
  })

  it('unrecognised status shape', () => {
    assert.equal(isDirenvStatusAllowed({}, ENVRC), false)
    assert.equal(isDirenvStatusAllowed(null, ENVRC), false)
    assert.equal(isDirenvStatusAllowed({ state: {} }, ENVRC), false)
    assert.equal(isDirenvStatusAllowed({ state: { foundRC: 'not-an-object' } }, ENVRC), false)
  })
})

describe('checkDirenvAllowed (never throws, fail-closed matrix)', () => {
  it('returns true when direnv status --json reports the exact envrcPath as allowed', async () => {
    const $ = makeFakeDirenvShell({ status: () => JSON.stringify(FIXTURES.allowed) })

    const result = await checkDirenvAllowed($, { anchorDir: '/repo', envrcPath: ENVRC }, noopLog)

    assert.equal(result, true)
  })

  it('returns false when not allowed', async () => {
    const $ = makeFakeDirenvShell({ status: () => JSON.stringify(FIXTURES.notYetAllowed) })

    const result = await checkDirenvAllowed($, { anchorDir: '/repo', envrcPath: ENVRC }, noopLog)

    assert.equal(result, false)
  })

  it('non-zero exit from direnv status', async () => {
    const err = new Error('direnv: error')
    err.stderr = 'direnv: error'
    const $ = makeFakeDirenvShell({ status: { throw: err } })

    await assert.doesNotReject(async () => {
      const result = await checkDirenvAllowed($, { anchorDir: '/repo', envrcPath: ENVRC }, noopLog)
      assert.equal(result, false)
    })
  })

  it('ENOENT — direnv not installed', async () => {
    const err = new Error('spawn direnv ENOENT')
    err.code = 'ENOENT'
    const $ = makeFakeDirenvShell({ status: { throw: err } })

    const result = await checkDirenvAllowed($, { anchorDir: '/repo', envrcPath: ENVRC }, noopLog)

    assert.equal(result, false)
  })

  it('timeout — direnv status never resolves', async () => {
    const $ = makeFakeDirenvShell({ hang: true })

    const start = Date.now()
    const result = await checkDirenvAllowed($, { anchorDir: '/repo', envrcPath: ENVRC }, noopLog)
    const elapsed = Date.now() - start

    assert.equal(result, false)
    assert.ok(elapsed >= DIRENV_TIMEOUT_MS, `expected to wait out the ${DIRENV_TIMEOUT_MS}ms budget, waited ${elapsed}ms`)
    assert.ok(elapsed < DIRENV_TIMEOUT_MS + 2000, `expected to return promptly after the timeout, waited ${elapsed}ms`)
  })

  it('empty stdout', async () => {
    const $ = makeFakeDirenvShell({ status: '' })

    const result = await checkDirenvAllowed($, { anchorDir: '/repo', envrcPath: ENVRC }, noopLog)

    assert.equal(result, false)
  })

  it('malformed JSON', async () => {
    const $ = makeFakeDirenvShell({ status: 'not json{{{' })

    const result = await checkDirenvAllowed($, { anchorDir: '/repo', envrcPath: ENVRC }, noopLog)

    assert.equal(result, false)
  })
})
