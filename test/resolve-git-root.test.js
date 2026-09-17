// spec: openspec/changes/fix-worktree-git-root-resolution/specs/worktree-git-root/spec.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import OpenCodeUse from '../src/plugin.v1.js'
import { resolveGitRoot } from '../src/lib.js'
import { makeTempDir, makeTempRepo, nodeShellShim, runGit } from './helpers.js'

describe('resolveGitRoot', () => {
  it('session has an explicit working directory', async (t) => {
    const repoRoot = await makeTempRepo(t, 'owgr-repo-')
    const nestedDir = join(repoRoot, 'nested')
    await mkdir(nestedDir)
    // Target worktree path is irrelevant here — the candidate root is already valid.
    const resolvedWorktreePath = join(repoRoot, '.worktrees', 'some-branch')

    const root = await resolveGitRoot(nodeShellShim, nestedDir, resolvedWorktreePath)

    // Canonicalized to the repository's top-level, not the subdirectory passed in.
    assert.equal(root, repoRoot)
  })

  it('session was opened outside a git repository with no explicit working directory', async (t) => {
    const invalidCandidateRoot = await makeTempDir(t, 'owgr-notarepo-')
    const repoRoot = await makeTempRepo(t, 'owgr-repo-')
    // .worktrees/some-branch does not exist yet — nearestExistingDir must walk
    // up past both missing segments to find repoRoot.
    const resolvedWorktreePath = join(repoRoot, '.worktrees', 'some-branch')

    const root = await resolveGitRoot(nodeShellShim, invalidCandidateRoot, resolvedWorktreePath)

    assert.equal(root, repoRoot)
  })

  it('neither the session context nor the target path resolves to a git repository', async (t) => {
    const invalidCandidateRoot = await makeTempDir(t, 'owgr-notarepo-a-')
    const otherNonRepoDir = await makeTempDir(t, 'owgr-notarepo-b-')
    const resolvedWorktreePath = join(otherNonRepoDir, 'sub', 'worktree')

    await assert.rejects(
      resolveGitRoot(nodeShellShim, invalidCandidateRoot, resolvedWorktreePath),
      (err) => {
        assert.match(err.message, /Cannot determine a git repository/)
        assert.ok(err.message.includes(invalidCandidateRoot))
        assert.ok(err.message.includes(otherNonRepoDir))
        return true
      },
    )
  })

  it('session context resolves to a valid but unrelated repository', async (t) => {
    const unrelatedRepo = await makeTempRepo(t, 'owgr-unrelated-')
    const targetRepo = await makeTempRepo(t, 'owgr-target-')
    // Session's cached candidate is nested inside the UNRELATED repo — valid git repo,
    // but does not contain the target worktree path.
    const staleCandidate = join(unrelatedRepo, 'nested')
    await mkdir(staleCandidate)
    const resolvedWorktreePath = join(targetRepo, '.worktrees', 'some-branch')

    const root = await resolveGitRoot(nodeShellShim, staleCandidate, resolvedWorktreePath)

    // Must resolve to the repo that actually contains the target path, not the stale candidate.
    assert.equal(root, targetRepo)
  })

  it('rejects a candidate whose path is a string-prefix of the target repo path (sibling, not ancestor)', async (t) => {
    const candidateRepo = await makeTempRepo(t, 'owgr-prefix-a-')
    // Sibling directory whose absolute path is `candidateRepo`'s path plus a suffix — a naive
    // `child.startsWith(parent)` containment check would wrongly treat a path under this sibling
    // as "inside" candidateRepo, purely because of the string-prefix collision.
    const siblingRepo = `${candidateRepo}-sibling`
    await mkdir(siblingRepo)
    t.after(() => rm(siblingRepo, { recursive: true, force: true }))
    await runGit('init -q', siblingRepo)
    await runGit('config user.email test@example.com', siblingRepo)
    await runGit('config user.name Test', siblingRepo)
    await runGit('commit --allow-empty -q -m init', siblingRepo)
    const resolvedWorktreePath = join(siblingRepo, '.worktrees', 'some-branch')

    const root = await resolveGitRoot(nodeShellShim, candidateRepo, resolvedWorktreePath)

    // Must resolve to the sibling that actually contains the path, not the string-prefix match.
    assert.equal(root, siblingRepo)
  })
})

describe('use_worktree integration', () => {
  it('creates a worktree when the session context is invalid but the target path is nested under a real repository', async (t) => {
    const invalidCandidateRoot = await makeTempDir(t, 'owgr-int-notarepo-')
    const repoRoot = await makeTempRepo(t, 'owgr-int-repo-')
    const worktreePath = join(repoRoot, '.worktrees', 'integration-branch')

    const plugin = await OpenCodeUse({
      client: { app: { log: () => Promise.resolve() } },
      $: nodeShellShim,
    })

    // Session with no prior use_cwd call, opened outside a git repository —
    // the exact conditions that reproduced the original bug.
    const ctx = { sessionID: 'use-worktree-integration-test', directory: invalidCandidateRoot }

    const result = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'integration-branch', create: true, fromRemote: false },
      ctx,
    )

    assert.match(result, /^Worktree created at/)
    assert.ok(result.includes(worktreePath))
    assert.ok(result.includes(`Repository root: ${repoRoot}`))
  })

  it('does not hijack an unrelated repository when the session context is stale', async (t) => {
    const unrelatedRepo = await makeTempRepo(t, 'owgr-int-unrelated-')
    const targetRepo = await makeTempRepo(t, 'owgr-int-target-')
    const worktreePath = join(targetRepo, '.worktrees', 'target-branch')

    const plugin = await OpenCodeUse({
      client: { app: { log: () => Promise.resolve() } },
      $: nodeShellShim,
    })

    // Session's directory (the fallback candidate when state.cwd is unset) is a
    // valid but unrelated repository — the exact conditions that reproduced the
    // cross-repo worktree hijack.
    const ctx = { sessionID: 'use-worktree-cross-repo-test', directory: unrelatedRepo }

    const result = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'target-branch', create: true, fromRemote: false },
      ctx,
    )

    assert.match(result, /^Worktree created at/)
    assert.ok(result.includes(`Repository root: ${targetRepo}`))
    assert.ok(!result.includes(unrelatedRepo))

    // The worktree must be registered against the target repo, not the unrelated one.
    const targetList = (await runGit('worktree list --porcelain', targetRepo)).trim()
    assert.ok(targetList.includes(worktreePath))
    const unrelatedList = (await runGit('worktree list --porcelain', unrelatedRepo)).trim()
    assert.ok(!unrelatedList.includes(worktreePath))
  })
})
