// spec: openspec/changes/fix-resolvepath-tilde-expansion/specs/path-resolution/spec.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import OpenCodeUse from '../src/index.js'

let sessionCounter = 0
function uniqueSessionId() {
  sessionCounter += 1
  return `path-resolution-test-${sessionCounter}`
}

async function makePlugin() {
  return OpenCodeUse({ client: { app: { log: () => Promise.resolve() } }, $: undefined })
}

/**
 * Temporarily override $HOME for the duration of a test, restoring it afterward.
 * Callers register this after the temp-dir removal `t.after` — Node's test
 * runner runs `t.after` callbacks in LIFO order, so $HOME is restored before
 * the directory is removed (though the two cleanups are independent either way).
 */
function withFakeHome(t, fakeHome) {
  const original = process.env.HOME
  process.env.HOME = fakeHome
  t.after(() => {
    if (original === undefined) delete process.env.HOME
    else process.env.HOME = original
  })
}

describe('Path Resolution — Tilde Expansion', () => {
  it('Input path is a bare tilde', async (t) => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'path-resolution-home-'))
    t.after(() => rm(fakeHome, { recursive: true, force: true }))
    withFakeHome(t, fakeHome)

    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()

    const result = await plugin.tool.use_cwd.execute(
      { path: '~' },
      { sessionID, directory: undefined },
    )

    assert.equal(result.startsWith(`Working directory set to: ${homedir()}`), true)
  })

  it('Input path starts with tilde-slash', async (t) => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'path-resolution-home-'))
    t.after(() => rm(fakeHome, { recursive: true, force: true }))
    withFakeHome(t, fakeHome)

    const subdir = join(fakeHome, 'git', 'middle-earth')
    await mkdir(subdir, { recursive: true })

    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()

    const result = await plugin.tool.use_cwd.execute(
      { path: '~/git/middle-earth' },
      { sessionID, directory: undefined },
    )

    assert.equal(result.startsWith(`Working directory set to: ${subdir}`), true)
  })

  it("Input path references another user's home directory", async (t) => {
    // ~otheruser/subpath is explicitly left unexpanded; it resolves as a
    // literal relative path against the base directory instead — this
    // documents the existing pass-through behavior as a regression guard.
    const fakeHome = await mkdtemp(join(tmpdir(), 'path-resolution-home-'))
    t.after(() => rm(fakeHome, { recursive: true, force: true }))
    withFakeHome(t, fakeHome)

    const baseDir = await mkdtemp(join(tmpdir(), 'path-resolution-base-'))
    t.after(() => rm(baseDir, { recursive: true, force: true }))
    const literalDir = join(baseDir, '~otheruser', 'subpath')
    await mkdir(literalDir, { recursive: true })

    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()

    const result = await plugin.tool.use_cwd.execute(
      { path: '~otheruser/subpath' },
      { sessionID, directory: baseDir },
    )

    assert.equal(result.startsWith(`Working directory set to: ${literalDir}`), true)
  })
})
