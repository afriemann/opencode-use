// spec: openspec/changes/fix-use-clear-worktree-prune/specs/worktree-cleanup/spec.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rm, writeFile } from 'node:fs/promises'

import OpenCodeUse from '../src/plugin.v1.js'
import { makeTempDir, makeTempRepo, nodeShellShim, runGit } from './helpers.js'

describe('use_clear resolves the correct repository root for owned worktree removal', () => {
  it('session context points at a different repository than the worktree', async (t) => {
    const repoA = await makeTempRepo(t, 'ucwr-owner-')
    const repoB = await makeTempRepo(t, 'ucwr-unrelated-')
    const worktreePath = join(repoA, '.worktrees', 'target-branch')

    const plugin = await OpenCodeUse({
      client: { app: { log: () => Promise.resolve() } },
      $: nodeShellShim,
    })
    const ctx = { sessionID: 'use-clear-cross-repo-test', directory: repoA }

    await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'target-branch', create: true, fromRemote: false },
      ctx,
    )

    // Session context now drifts to an unrelated repository — the exact condition
    // that reproduced the original "is not a working tree" failure.
    await plugin.tool.use_cwd.execute({ path: repoB }, ctx)

    const result = await plugin.tool.use_clear.execute({ fields: ['worktree'] }, ctx)

    assert.match(result, /^Removed owned worktree at/)
    assert.ok(result.includes(worktreePath))

    const listA = (await runGit('worktree list --porcelain', repoA)).trim()
    assert.ok(!listA.includes(worktreePath), 'worktree must be deregistered from its owning repo')
  })

  it('the worktree\'s containing repository can no longer be found', async (t) => {
    const repoA = await makeTempRepo(t, 'ucwr-vanished-')
    const worktreePath = join(repoA, '.worktrees', 'target-branch')
    const invalidCandidateRoot = await makeTempDir(t, 'ucwr-vanished-ctx-')

    const plugin = await OpenCodeUse({
      client: { app: { log: () => Promise.resolve() } },
      $: nodeShellShim,
    })
    const ctx = { sessionID: 'use-clear-vanished-repo-test', directory: repoA }

    await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'target-branch', create: true, fromRemote: false },
      ctx,
    )

    // Session context drifts to a non-repository directory, and the entire
    // repository containing the worktree is then removed from disk — neither
    // candidate resolveGitRoot tries can resolve to a containing repository.
    await plugin.tool.use_cwd.execute({ path: invalidCandidateRoot }, ctx)
    await rm(repoA, { recursive: true, force: true })

    await assert.rejects(
      plugin.tool.use_clear.execute({ fields: ['worktree'] }, ctx),
      (err) => {
        assert.match(err.message, /Cannot determine a git repository/)
        return true
      },
    )
  })

  it('regression: removes an owned worktree normally when session context already matches', async (t) => {
    const repo = await makeTempRepo(t, 'ucwr-regression-')
    const worktreePath = join(repo, '.worktrees', 'target-branch')

    const plugin = await OpenCodeUse({
      client: { app: { log: () => Promise.resolve() } },
      $: nodeShellShim,
    })
    const ctx = { sessionID: 'use-clear-regression-test', directory: repo }

    await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'target-branch', create: true, fromRemote: false },
      ctx,
    )

    const result = await plugin.tool.use_clear.execute({ fields: ['worktree'] }, ctx)

    assert.match(result, /^Removed owned worktree at/)
    const list = (await runGit('worktree list --porcelain', repo)).trim()
    assert.ok(!list.includes(worktreePath))
  })
})

describe('use_clear removal fails due to uncommitted or untracked content', () => {
  it('removal fails due to uncommitted or untracked content', async (t) => {
    const repo = await makeTempRepo(t, 'ucwr-dirty-')
    const worktreePath = join(repo, '.worktrees', 'target-branch')

    const plugin = await OpenCodeUse({
      client: { app: { log: () => Promise.resolve() } },
      $: nodeShellShim,
    })
    const ctx = { sessionID: 'use-clear-dirty-worktree-test', directory: repo }

    await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'target-branch', create: true, fromRemote: false },
      ctx,
    )
    await writeFile(join(worktreePath, 'untracked.txt'), 'not committed\n')

    await assert.rejects(
      plugin.tool.use_clear.execute({ fields: ['worktree'] }, ctx),
      (err) => {
        assert.match(err.message, /uncommitted changes or untracked files/)
        assert.ok(err.message.includes(worktreePath))
        return true
      },
    )

    const list = (await runGit('worktree list --porcelain', repo)).trim()
    assert.ok(list.includes(worktreePath), 'worktree must remain registered after a failed removal')
  })
})
