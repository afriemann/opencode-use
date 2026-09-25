// spec: openspec/changes/direnv-automation/specs/context-autoload/spec.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { applyDirectoryChange, DIRENV_TIMEOUT_MS } from '../src/lib.js'
import { makeTempRepo, makeFakeDirenvShell, nodeShellShim } from './helpers.js'

function noopLog() {}

function freshState() {
  return { cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null }
}

const ALLOWED_STATUS = (envrcPath) => JSON.stringify({
  state: { foundRC: { allowed: 0, path: envrcPath }, loadedRC: null },
})
const NOT_ALLOWED_STATUS = (envrcPath) => JSON.stringify({
  state: { foundRC: { allowed: 1, path: envrcPath }, loadedRC: null },
})

describe('applyDirectoryChange — autoLoadEnv matrix (design.md D5)', () => {
  it('No .envrc exists', async (t) => {
    const repoRoot = await makeTempRepo(t, 'dal-no-envrc-')
    const $ = makeFakeDirenvShell({
      status: { throw: Object.assign(new Error('must not be called'), { stderr: 'must not be called' }) },
    })

    const state = freshState()
    const result = await applyDirectoryChange($, state, repoRoot, noopLog, { autoLoadEnv: true })

    assert.equal(result.changed, true)
    assert.ok(!result.notes.some((n) => n.includes('.envrc')))
    assert.deepEqual(state.env, {})
    assert.equal(state.envSource, null)
  })

  it('.envrc present, autoLoadEnv false — suggestion note only, no direnv subprocess', async (t) => {
    const repoRoot = await makeTempRepo(t, 'dal-no-autoload-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    const $ = makeFakeDirenvShell({
      status: { throw: Object.assign(new Error('must not be called'), { stderr: 'must not be called' }) },
    })

    const state = freshState()
    const result = await applyDirectoryChange($, state, repoRoot, noopLog, { autoLoadEnv: false })

    assert.ok(result.notes.some((n) => n.includes('.envrc') && n.includes('use_direnv') && n.includes('not loaded automatically')))
    assert.deepEqual(state.env, {})
    assert.equal(state.envSource, null)
  })

  it('Auto-load never runs direnv allow', async (t) => {
    const repoRoot = await makeTempRepo(t, 'dal-not-allowed-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    const envrcPath = join(repoRoot, '.envrc')
    const $ = makeFakeDirenvShell({
      status: () => NOT_ALLOWED_STATUS(envrcPath),
      exportJson: { throw: Object.assign(new Error('must not be called'), { stderr: 'must not be called' }) },
    })

    const state = freshState()
    const result = await applyDirectoryChange($, state, repoRoot, noopLog, { autoLoadEnv: true })

    assert.ok(result.notes.some((n) => n.includes('.envrc') && n.includes('use_direnv') && n.includes('not loaded automatically')))
    assert.deepEqual(state.env, {})
    assert.equal(state.envSource, null)
  })

  it('Already-allowed .envrc is auto-loaded on a genuine directory change', async (t) => {
    const repoRoot = await makeTempRepo(t, 'dal-allowed-loaded-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    const envrcPath = join(repoRoot, '.envrc')
    const $ = makeFakeDirenvShell({
      status: () => ALLOWED_STATUS(envrcPath),
      exportJson: () => JSON.stringify({ FOO: 'bar', BAZ: 42 }),
    })

    const state = freshState()
    const result = await applyDirectoryChange($, state, repoRoot, noopLog, { autoLoadEnv: true })

    assert.ok(result.notes.some((n) => n.includes('Loaded 2 variable(s)') && n.includes('already allowed by direnv')))
    assert.deepEqual(state.env, { FOO: 'bar', BAZ: '42' })
    assert.equal(state.envSource, `direnv:${repoRoot}`)
  })

  it('Already-allowed .envrc with no environment changes exported', async (t) => {
    const repoRoot = await makeTempRepo(t, 'dal-allowed-empty-')
    await writeFile(join(repoRoot, '.envrc'), 'true\n')
    const envrcPath = join(repoRoot, '.envrc')
    const $ = makeFakeDirenvShell({
      status: () => ALLOWED_STATUS(envrcPath),
      exportJson: () => '{}',
    })

    const state = freshState()
    const result = await applyDirectoryChange($, state, repoRoot, noopLog, { autoLoadEnv: true })

    assert.ok(result.notes.some((n) => n.includes('allowed by direnv and was loaded') && n.includes('no environment changes exported')))
    assert.deepEqual(state.env, {})
    assert.equal(state.envSource, `direnv:${repoRoot}`)
  })

  it('Failed load of an already-allowed .envrc leaves the environment unchanged', async (t) => {
    const repoRoot = await makeTempRepo(t, 'dal-allowed-export-fails-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    const envrcPath = join(repoRoot, '.envrc')
    const exportErr = Object.assign(new Error('boom'), { stderr: 'boom' })
    const $ = makeFakeDirenvShell({
      status: () => ALLOWED_STATUS(envrcPath),
      exportJson: { throw: exportErr },
    })

    const state = freshState()
    state.env = { PREEXISTING: 'yes' }
    state.envSource = 'direnv:/somewhere-else'
    const result = await applyDirectoryChange($, state, repoRoot, noopLog, { autoLoadEnv: true })

    assert.ok(result.notes.some((n) => n.includes('allowed by direnv but automatic loading failed')))
    assert.deepEqual(state.env, { PREEXISTING: 'yes' })
    assert.equal(state.envSource, 'direnv:/somewhere-else')
  })

  it('no-op call (unchanged directory) runs zero direnv subprocesses even with autoLoadEnv true', async (t) => {
    const repoRoot = await makeTempRepo(t, 'dal-noop-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    const $ = makeFakeDirenvShell({
      status: { throw: Object.assign(new Error('must not be called'), { stderr: 'must not be called' }) },
      exportJson: { throw: Object.assign(new Error('must not be called'), { stderr: 'must not be called' }) },
    })

    const state = freshState()
    await applyDirectoryChange($, state, repoRoot, noopLog, { autoLoadEnv: true })
    const result = await applyDirectoryChange($, state, repoRoot, noopLog, { autoLoadEnv: true })

    assert.equal(result.changed, false)
    assert.deepEqual(result.notes, [])
  })

  it('Moving to a directory with no or not-yet-allowed .envrc does not clear the existing environment', async (t) => {
    const repoRootA = await makeTempRepo(t, 'dal-keep-env-a-')
    await writeFile(join(repoRootA, '.envrc'), 'export FOO=bar\n')
    const envrcPathA = join(repoRootA, '.envrc')
    const repoRootB = await makeTempRepo(t, 'dal-keep-env-b-')

    const $ = makeFakeDirenvShell({
      status: () => ALLOWED_STATUS(envrcPathA),
      exportJson: () => JSON.stringify({ FOO: 'bar' }),
    })

    const state = freshState()
    await applyDirectoryChange($, state, repoRootA, noopLog, { autoLoadEnv: true })
    assert.deepEqual(state.env, { FOO: 'bar' })

    await applyDirectoryChange($, state, repoRootB, noopLog, { autoLoadEnv: true })

    assert.deepEqual(state.env, { FOO: 'bar' })
    assert.equal(state.envSource, `direnv:${repoRootA}`)
  })

  it('Auto-load overwrites a previously loaded environment', async (t) => {
    const repoRootA = await makeTempRepo(t, 'dal-overwrite-a-')
    await writeFile(join(repoRootA, '.envrc'), 'export FOO=bar\n')
    const envrcPathA = join(repoRootA, '.envrc')
    const repoRootB = await makeTempRepo(t, 'dal-overwrite-b-')
    await writeFile(join(repoRootB, '.envrc'), 'export QUX=1\n')
    const envrcPathB = join(repoRootB, '.envrc')

    // Use a cwd-aware fake directly since the shared helper doesn't branch on cwd for status.
    let currentAnchor = repoRootA
    function cwdAwareShell(strings, ...values) {
      const command = strings.reduce((acc, part, i) => acc + part + (values[i] ?? ''), '')
      const builder = {
        cwd(dir) {
          currentAnchor = dir
          return builder
        },
        quiet() {
          return builder
        },
        text() {
          if (command.startsWith('direnv status')) {
            const path = currentAnchor === repoRootA ? envrcPathA : envrcPathB
            return Promise.resolve(ALLOWED_STATUS(path))
          }
          if (command.startsWith('direnv export')) {
            const vars = currentAnchor === repoRootA ? { FOO: 'bar' } : { QUX: '1' }
            return Promise.resolve(JSON.stringify(vars))
          }
          return Promise.reject(new Error(`unexpected command: ${command}`))
        },
        then(resolvePromise, reject) {
          return this.text().then(resolvePromise, reject)
        },
      }
      return builder
    }

    const state = freshState()
    await applyDirectoryChange(cwdAwareShell, state, repoRootA, noopLog, { autoLoadEnv: true })
    assert.deepEqual(state.env, { FOO: 'bar' })

    await applyDirectoryChange(cwdAwareShell, state, repoRootB, noopLog, { autoLoadEnv: true })
    assert.deepEqual(state.env, { QUX: '1' })
    assert.equal(state.envSource, `direnv:${repoRootB}`)
  })

  it('Auto-load anchors on the directory discovery reported, not the resolved leaf', async (t) => {
    const repoRoot = await makeTempRepo(t, 'dal-anchor-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    const nested = join(repoRoot, 'packages', 'foo')
    await mkdir(nested, { recursive: true })
    const envrcPath = join(repoRoot, '.envrc')

    const cwdsSeen = []
    function recordingShell(strings, ...values) {
      const command = strings.reduce((acc, part, i) => acc + part + (values[i] ?? ''), '')
      if (!command.startsWith('direnv ')) return nodeShellShim(strings, ...values)
      let cwd
      const builder = {
        cwd(dir) {
          cwd = dir
          return builder
        },
        quiet() {
          return builder
        },
        text() {
          cwdsSeen.push(cwd)
          if (command.startsWith('direnv status')) return Promise.resolve(ALLOWED_STATUS(envrcPath))
          if (command.startsWith('direnv export')) return Promise.resolve(JSON.stringify({ FOO: 'bar' }))
          return Promise.reject(new Error(`unexpected command: ${command}`))
        },
        then(resolvePromise, reject) {
          return this.text().then(resolvePromise, reject)
        },
      }
      return builder
    }

    const state = freshState()
    await applyDirectoryChange(recordingShell, state, nested, noopLog, { autoLoadEnv: true })

    assert.ok(cwdsSeen.length >= 2, 'expected at least a status and an export invocation')
    assert.ok(cwdsSeen.every((c) => c === repoRoot), `expected every direnv invocation anchored at ${repoRoot}, got ${JSON.stringify(cwdsSeen)}`)
  })
})

describe('loadDirenvEnvSafe (via applyDirectoryChange) — timeout handling', () => {
  it('Failed load of an already-allowed .envrc leaves the environment unchanged (export times out)', async (t) => {
    const repoRoot = await makeTempRepo(t, 'dal-timeout-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    const envrcPath = join(repoRoot, '.envrc')
    function hangingExportShell(strings, ...values) {
      const command = strings.reduce((acc, part, i) => acc + part + (values[i] ?? ''), '')
      const builder = {
        cwd() {
          return builder
        },
        quiet() {
          return builder
        },
        text() {
          if (command.startsWith('direnv status')) return Promise.resolve(ALLOWED_STATUS(envrcPath))
          if (command.startsWith('direnv export')) return new Promise(() => {}) // never settles
          return Promise.reject(new Error(`unexpected command: ${command}`))
        },
        then(resolvePromise, reject) {
          return this.text().then(resolvePromise, reject)
        },
      }
      return builder
    }

    const state = freshState()
    const start = Date.now()
    const result = await applyDirectoryChange(hangingExportShell, state, repoRoot, noopLog, { autoLoadEnv: true })
    const elapsed = Date.now() - start

    assert.ok(elapsed >= DIRENV_TIMEOUT_MS)
    assert.ok(result.notes.some((n) => n.includes('automatic loading failed')))
    assert.deepEqual(state.env, {})
  })
})
