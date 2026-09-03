// spec: openspec/changes/fix-worktree-branch-exists/specs/worktree-branch-reuse/spec.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { exec } from 'node:child_process'
import { join } from 'node:path'

import OpenCodeUse from '../src/index.js'
import { makeTempDir } from './helpers.js'

/**
 * Minimal Node-based stand-in for the Bun `$` shell interface that this
 * plugin depends on (`` $`command` ``, `.cwd()`, `.quiet()`, `.text()`, and —
 * critically — direct `await`-ability without calling `.text()`, since real
 * Bun shell promises are themselves thenable). Throws an Error with
 * `.stderr` on non-zero exit. Bun is not installed on this dev/CI host, so
 * this shim executes the reconstructed command string via
 * `child_process.exec` instead. Test inputs are simple, shell-safe strings
 * (paths/branch names with no spaces or shell metacharacters), so a plain
 * string interpolation is sufficient here.
 */
function nodeShellShim(strings, ...values) {
  const command = strings.reduce((acc, part, i) => acc + part + (values[i] ?? ''), '')
  let cwd = process.cwd()

  function run() {
    return new Promise((resolvePromise, reject) => {
      exec(command, { cwd }, (err, stdout, stderr) => {
        if (err) {
          const wrapped = new Error(stderr || err.message)
          wrapped.stderr = stderr
          reject(wrapped)
          return
        }
        resolvePromise(stdout)
      })
    })
  }

  const builder = {
    cwd(dir) {
      cwd = dir
      return builder
    },
    quiet() {
      return builder
    },
    text() {
      return run()
    },
    then(onFulfilled, onRejected) {
      return run().then(onFulfilled, onRejected)
    },
  }
  return builder
}

/** Run a git command via plain child_process.exec, for test setup outside the shim's shape. */
function runGit(args, cwd) {
  return new Promise((resolvePromise, reject) => {
    exec(`git ${args}`, { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message))
        return
      }
      resolvePromise(stdout)
    })
  })
}

/** Create a fresh temp directory, `git init` it, and make an initial commit so branches can be created. */
async function makeTempRepo(t, prefix) {
  const dir = await makeTempDir(t, prefix)
  await runGit('init -q', dir)
  await runGit('config user.email test@example.com', dir)
  await runGit('config user.name Test', dir)
  await runGit('commit --allow-empty -q -m init', dir)
  return dir
}

async function makePlugin() {
  return OpenCodeUse({
    client: { app: { log: () => Promise.resolve() } },
    $: nodeShellShim,
  })
}

describe('use_worktree — branch already exists on create', () => {
  it('branch exists but is not checked out anywhere', async (t) => {
    const repoRoot = await makeTempRepo(t, 'wbr-unregistered-')
    // Branch exists locally but has no worktree checked out on it.
    await runGit('branch feature-unregistered', repoRoot)

    const plugin = await makePlugin()
    const ctx = { sessionID: 'wbr-unregistered', directory: repoRoot }
    const targetPath = join(repoRoot, '.worktrees', 'feature-unregistered')

    const result = await plugin.tool.use_worktree.execute(
      { path: targetPath, branch: 'feature-unregistered', create: true, fromRemote: false },
      ctx,
    )

    assert.match(result, /^Worktree created at/)
    assert.ok(result.includes(targetPath))

    // The existing branch was checked out — not a fresh branch created from HEAD.
    const branchInWorktree = (await runGit('rev-parse --abbrev-ref HEAD', targetPath)).trim()
    assert.equal(branchInWorktree, 'feature-unregistered')
  })

  it('branch already checked out at a different worktree path', async (t) => {
    const repoRoot = await makeTempRepo(t, 'wbr-elsewhere-')
    const existingPath = join(repoRoot, '.worktrees', 'existing-checkout')
    await runGit(`worktree add -b feature-elsewhere ${existingPath}`, repoRoot)

    const plugin = await makePlugin()
    const ctx = { sessionID: 'wbr-elsewhere', directory: repoRoot }
    const newPath = join(repoRoot, '.worktrees', 'another-path')

    await assert.rejects(
      plugin.tool.use_worktree.execute(
        { path: newPath, branch: 'feature-elsewhere', create: true, fromRemote: false },
        ctx,
      ),
      (err) => {
        assert.ok(err.message.includes(existingPath))
        assert.ok(err.message.includes('create: false') || err.message.includes('create=false'))
        return true
      },
    )
  })
})
