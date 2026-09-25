// spec: openspec/changes/direnv-automation/specs/context-autoload/spec.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { resolveSessionLocation, initSessionDirectory } from '../src/core.js'
import { makeTempRepo, nodeShellShim } from './helpers.js'

function noopLog() {}

function freshState() {
  return { cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null }
}

describe('resolveSessionLocation (design.md D6)', () => {
  it('a plain directory location resolves to that directory', () => {
    assert.equal(resolveSessionLocation({ directory: '/repo' }), '/repo')
  })

  it('a subpath is joined onto the directory', () => {
    assert.equal(resolveSessionLocation({ directory: '/repo', subpath: 'pkg/a' }), join('/repo', 'pkg/a'))
  })

  it('a workspaceID present resolves to null (directory may not be local)', () => {
    assert.equal(resolveSessionLocation({ directory: '/repo', workspaceID: 'ws1' }), null)
  })

  it('no directory at all resolves to null', () => {
    assert.equal(resolveSessionLocation({}), null)
    assert.equal(resolveSessionLocation(null), null)
    assert.equal(resolveSessionLocation(undefined), null)
  })
})

describe('initSessionDirectory (design.md D6)', () => {
  it('skips silently when the resolved path does not exist', async () => {
    const state = freshState()
    await initSessionDirectory(state, '/no/such/path/at/all', { $: nodeShellShim, log: noopLog }, { autoLoadEnv: false })
    assert.equal(state.cwd, null)
  })

  it('skips silently when state.cwd is already set (race guard)', async (t) => {
    const repoRoot = await makeTempRepo(t, 'session-init-race-')
    const state = freshState()
    state.cwd = '/already/set/by/use_workdir'
    await initSessionDirectory(state, repoRoot, { $: nodeShellShim, log: noopLog }, { autoLoadEnv: false })
    assert.equal(state.cwd, '/already/set/by/use_workdir')
  })

  it('never throws on an unexpected failure', async () => {
    const state = freshState()
    const throwingShell = () => {
      throw new Error('boom')
    }
    await assert.doesNotReject(
      initSessionDirectory(state, '/tmp', { $: throwingShell, log: noopLog }, { autoLoadEnv: false }),
    )
  })

  it('never auto-loads env when autoLoadEnv is false, even with an allowed .envrc', async (t) => {
    const repoRoot = await makeTempRepo(t, 'session-init-no-env-')
    const state = freshState()
    await initSessionDirectory(state, repoRoot, { $: nodeShellShim, log: noopLog }, { autoLoadEnv: false })
    assert.equal(state.cwd, repoRoot)
    assert.deepEqual(state.env, {})
    assert.equal(state.envSource, null)
  })

  it('routes through the applyDirectoryChange choke point (AGENTS.md discovery runs)', async (t) => {
    const repoRoot = await makeTempRepo(t, 'session-init-agents-md-')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(repoRoot, 'AGENTS.md'), '# hello\n')
    const state = freshState()
    await initSessionDirectory(state, repoRoot, { $: nodeShellShim, log: noopLog }, { autoLoadEnv: false })
    assert.equal(state.cwd, repoRoot)
    assert.ok(state.agentsMd, 'expected agentsMd to be populated by applyDirectoryChange')
    assert.ok(state.agentsMd.content.includes('hello'))
  })

  it('with requireUnsetCwd: false (V2 session-move), updates an already-set state.cwd', async (t) => {
    const firstRepo = await makeTempRepo(t, 'session-init-move-from-')
    const secondRepo = await makeTempRepo(t, 'session-init-move-to-')
    const state = freshState()
    state.cwd = firstRepo

    await initSessionDirectory(
      state,
      secondRepo,
      { $: nodeShellShim, log: noopLog },
      { autoLoadEnv: false, requireUnsetCwd: false },
    )

    assert.equal(state.cwd, secondRepo, 'expected the move to overwrite the already-set cwd')
  })
})
