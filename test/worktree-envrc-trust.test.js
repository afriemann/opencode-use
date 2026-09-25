// spec: openspec/changes/direnv-automation/specs/worktree-envrc-trust/spec.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import OpenCodeUse from '../src/plugin.v1.js'
import { makeTempDir, makeTempRepo, runGit } from './helpers.js'

let sessionCounter = 0
function uniqueSessionId() {
  sessionCounter += 1
  return `worktree-envrc-trust-test-${sessionCounter}`
}

async function commitAll(dir, message = 'test commit') {
  await runGit('add -A', dir)
  await runGit(`-c user.email=test@example.com -c user.name=test commit -q -m ${JSON.stringify(message)}`, dir)
}

const ALLOWED_STATUS = (envrcPath) => JSON.stringify({
  state: { foundRC: { allowed: 0, path: envrcPath }, loadedRC: null },
})
const NOT_ALLOWED_STATUS = (envrcPath) => JSON.stringify({
  state: { foundRC: { allowed: 1, path: envrcPath }, loadedRC: null },
})

/**
 * A shell that delegates real `git` subprocesses (via `realShell`) and fakes
 * `direnv status`/`export`/`allow` per test-configured outcomes, recording
 * every direnv invocation's (subcommand, cwd) pair in `callLog` for
 * TOCTOU-ordering assertions.
 */
function makeTracingDirenvShell(realShell, { initiallyAllowed = [], exportFor, allowResult = 'ok' }, callLog) {
  const allowed = new Set(initiallyAllowed)
  return function taggedTemplate(strings, ...values) {
    const command = strings.reduce((acc, part, i) => acc + part + (values[i] ?? ''), '')
    if (!command.startsWith('direnv ')) return realShell(strings, ...values)

    let cwd
    const subcommand = command.startsWith('direnv status') ? 'status'
      : command.startsWith('direnv export') ? 'export'
      : command.startsWith('direnv allow') ? 'allow'
      : 'unknown'

    const builder = {
      cwd(dir) {
        cwd = dir
        return builder
      },
      quiet() {
        return builder
      },
      text() {
        callLog.push({ subcommand, cwd, command })
        if (subcommand === 'status') {
          const envrcPath = join(cwd, '.envrc')
          return Promise.resolve(
            allowed.has(envrcPath) ? ALLOWED_STATUS(envrcPath) : NOT_ALLOWED_STATUS(envrcPath),
          )
        }
        if (subcommand === 'export') return Promise.resolve(exportFor ? exportFor(cwd) : '{}')
        if (subcommand === 'allow') {
          if (allowResult && allowResult.throw) return Promise.reject(allowResult.throw)
          // `values[0]` is the interpolated `.envrc` path in `` `direnv allow ${path}` ``.
          allowed.add(values[0])
          return Promise.resolve('')
        }
        return Promise.reject(new Error(`unexpected direnv command: ${command}`))
      },
      then(resolvePromise, reject) {
        return this.text().then(resolvePromise, reject)
      },
    }
    return builder
  }
}

describe('worktree envrc auto-trust (create path only, design.md D7)', () => {
  it("Newly created worktree's identical, already-allowed .envrc is auto-trusted", async (t) => {
    const repoRoot = await makeTempRepo(t, 'wet-identical-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    await commitAll(repoRoot)
    const worktreePath = join(repoRoot, '.worktrees', 'wet-branch')
    const rootEnvrcPath = join(repoRoot, '.envrc')

    const callLog = []
    const { nodeShellShim } = await import('./helpers.js')
    const $ = makeTracingDirenvShell(
      nodeShellShim,
      {
        initiallyAllowed: [rootEnvrcPath],
        exportFor: () => JSON.stringify({ FOO: 'bar' }),
      },
      callLog,
    )
    const plugin = await OpenCodeUse({ client: { app: { log: () => Promise.resolve() } }, $ })
    const sessionID = uniqueSessionId()

    const result = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'wet-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )

    assert.match(result, /Auto-trusted/)

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)
    const block = output.system.find((s) => s.includes('Active Session Context'))
    assert.ok(block && block.includes('variable(s) from direnv'), 'expected the environment to have been auto-loaded')

    // TOCTOU ordering: both .envrc's are compared before `allow` runs, and
    // `allow` runs before the post-allow re-verification (which, in this
    // implementation, happens via a plain fs re-read, not another direnv
    // call) — assert the root's allowed-check preceded the worktree's allow.
    const allowIndex = callLog.findIndex((c) => c.subcommand === 'allow')
    const rootStatusIndex = callLog.findIndex((c) => c.subcommand === 'status' && c.cwd === repoRoot)
    assert.ok(rootStatusIndex !== -1, 'expected a status check against the repo root')
    assert.ok(allowIndex !== -1, 'expected direnv allow to have run')
    assert.ok(rootStatusIndex < allowIndex, 'expected the root allowed-check before direnv allow')
  })

  it('Differing .envrc content is never auto-trusted', async (t) => {
    const repoRoot = await makeTempRepo(t, 'wet-differ-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    await commitAll(repoRoot)
    const worktreePath = join(repoRoot, '.worktrees', 'wet-differ-branch')

    // Modify the root's *working tree* .envrc without committing — the new
    // worktree is checked out from the last commit, so it still carries the
    // original ("export FOO=bar") content while the root's on-disk file now
    // differs ("export FOO=different"). This exercises the byte-compare
    // rejection path without needing a second real direnv-allowed fixture.
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=different\n')

    const { nodeShellShim } = await import('./helpers.js')
    const callLog = []
    const $ = makeTracingDirenvShell(
      nodeShellShim,
      { initiallyAllowed: [] },
      callLog,
    )
    const plugin = await OpenCodeUse({ client: { app: { log: () => Promise.resolve() } }, $ })
    const sessionID = uniqueSessionId()

    const result = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'wet-differ-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )

    assert.match(result, /differs from the repository root/)
    assert.ok(!callLog.some((c) => c.subcommand === 'allow'), 'expected no direnv allow for differing content')
  })

  it("Auto-trust is skipped when the repository root's .envrc is not itself allowed", async (t) => {
    const repoRoot = await makeTempRepo(t, 'wet-root-not-allowed-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    await commitAll(repoRoot)
    const worktreePath = join(repoRoot, '.worktrees', 'wet-root-not-allowed-branch')

    const { nodeShellShim } = await import('./helpers.js')
    const callLog = []
    const $ = makeTracingDirenvShell(nodeShellShim, { initiallyAllowed: [] }, callLog)
    const plugin = await OpenCodeUse({ client: { app: { log: () => Promise.resolve() } }, $ })
    const sessionID = uniqueSessionId()

    const result = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'wet-root-not-allowed-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )

    assert.match(result, /not itself allowed/)
    assert.ok(!callLog.some((c) => c.subcommand === 'allow'))
  })

  it('Reusing an existing worktree never triggers auto-trust', async (t) => {
    const repoRoot = await makeTempRepo(t, 'wet-reuse-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    await commitAll(repoRoot)
    const worktreePath = join(repoRoot, '.worktrees', 'wet-reuse-branch')

    // Pre-register the worktree directly via git, bypassing the plugin, so
    // the plugin's session hits the "already exists — reusing it" path.
    await runGit(`worktree add -b wet-reuse-branch ${worktreePath}`, repoRoot)

    const { nodeShellShim } = await import('./helpers.js')
    const callLog = []
    const $ = makeTracingDirenvShell(
      nodeShellShim,
      { initiallyAllowed: [join(repoRoot, '.envrc')], exportFor: () => JSON.stringify({ FOO: 'bar' }) },
      callLog,
    )
    const plugin = await OpenCodeUse({ client: { app: { log: () => Promise.resolve() } }, $ })
    const sessionID = uniqueSessionId()

    const result = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'wet-reuse-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )

    assert.match(result, /already exists — reusing it/)
    assert.ok(!callLog.some((c) => c.subcommand === 'allow'), 'expected reuse path to never call direnv allow')
  })

  it('the idempotent same-path return never triggers auto-trust', async (t) => {
    const repoRoot = await makeTempRepo(t, 'wet-idempotent-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    await commitAll(repoRoot)
    const worktreePath = join(repoRoot, '.worktrees', 'wet-idempotent-branch')

    const { nodeShellShim } = await import('./helpers.js')
    const callLog = []
    const $ = makeTracingDirenvShell(
      nodeShellShim,
      { initiallyAllowed: [join(repoRoot, '.envrc')], exportFor: () => JSON.stringify({ FOO: 'bar' }) },
      callLog,
    )
    const plugin = await OpenCodeUse({ client: { app: { log: () => Promise.resolve() } }, $ })
    const sessionID = uniqueSessionId()

    await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'wet-idempotent-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )
    callLog.length = 0 // Only care about calls made by the second, idempotent invocation.

    const second = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'wet-idempotent-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )

    assert.match(second, /already active/)
    assert.ok(!callLog.some((c) => c.subcommand === 'allow'), 'expected the idempotent path to never call direnv allow')
  })

  it('direnv allow failing produces a note and does not throw', async (t) => {
    const repoRoot = await makeTempRepo(t, 'wet-allow-fails-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    await commitAll(repoRoot)
    const worktreePath = join(repoRoot, '.worktrees', 'wet-allow-fails-branch')
    const rootEnvrcPath = join(repoRoot, '.envrc')

    const { nodeShellShim } = await import('./helpers.js')
    const callLog = []
    const allowErr = Object.assign(new Error('allow failed'), { stderr: 'allow failed' })
    const $ = makeTracingDirenvShell(
      nodeShellShim,
      { initiallyAllowed: [rootEnvrcPath], allowResult: { throw: allowErr } },
      callLog,
    )
    const plugin = await OpenCodeUse({ client: { app: { log: () => Promise.resolve() } }, $ })
    const sessionID = uniqueSessionId()

    const result = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'wet-allow-fails-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )

    assert.match(result, /Auto-trusting.*failed/)
  })

  it('Content modified between the allow check and re-verification is caught and not loaded', async (t) => {
    const repoRoot = await makeTempRepo(t, 'wet-post-allow-mismatch-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    await commitAll(repoRoot)
    const worktreePath = join(repoRoot, '.worktrees', 'wet-post-allow-mismatch-branch')
    const rootEnvrcPath = join(repoRoot, '.envrc')

    const { nodeShellShim } = await import('./helpers.js')
    const callLog = []
    // The fake `direnv allow` handler mutates the worktree's .envrc on disk
    // as a side effect — simulating a race where the file changes between
    // the byte-compare step and the post-allow re-read (design.md D7 step 6).
    function raceyShell(strings, ...values) {
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
        async text() {
          if (command.startsWith('direnv status')) {
            callLog.push({ subcommand: 'status', cwd })
            return ALLOWED_STATUS(rootEnvrcPath)
          }
          if (command.startsWith('direnv allow')) {
            callLog.push({ subcommand: 'allow', cwd })
            await writeFile(join(worktreePath, '.envrc'), 'export FOO=mutated-during-allow\n')
            return ''
          }
          return Promise.reject(new Error(`unexpected direnv command: ${command}`))
        },
        then(resolvePromise, reject) {
          return this.text().then(resolvePromise, reject)
        },
      }
      return builder
    }
    const plugin = await OpenCodeUse({ client: { app: { log: () => Promise.resolve() } }, $: raceyShell })
    const sessionID = uniqueSessionId()

    const result = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'wet-post-allow-mismatch-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )

    assert.match(result, /changed between being compared and being\s*\n?\s*allowed/)

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)
    const block = output.system.find((s) => s.includes('Active Session Context'))
    assert.ok(!block || !block.includes('variable(s) from direnv'), 'expected auto-load to have been skipped')
  })

  it('Comparison is scoped to the repository root and the new worktree only', async (t) => {
    // Prove there is no upward search beyond the repo root: plant a
    // byte-identical .envrc at an ANCESTOR of the repo root (outside git
    // entirely), while the repo root's own .envrc differs. If a future
    // regression reintroduced an upward search, this ancestor file would
    // wrongly be treated as a match and `direnv allow` would fire.
    const parent = await makeTempDir(t, 'wet-ancestor-parent-')
    await writeFile(join(parent, '.envrc'), 'export FOO=bar\n')

    const repoRoot = join(parent, 'repo')
    await mkdir(repoRoot)
    await runGit('init -q', repoRoot)
    await runGit('config user.email test@example.com', repoRoot)
    await runGit('config user.name Test', repoRoot)
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')
    await commitAll(repoRoot)
    const worktreePath = join(repoRoot, '.worktrees', 'wet-ancestor-branch')

    // Diverge the repo root's *working-tree* .envrc from the worktree's
    // (checked-out, committed) copy — same technique as the "differing
    // content" test above — so the only byte-identical candidate is the
    // ancestor file, which must never be consulted.
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=different\n')

    const { nodeShellShim } = await import('./helpers.js')
    const callLog = []
    const $ = makeTracingDirenvShell(nodeShellShim, { initiallyAllowed: [join(parent, '.envrc')] }, callLog)
    const plugin = await OpenCodeUse({ client: { app: { log: () => Promise.resolve() } }, $ })
    const sessionID = uniqueSessionId()

    const result = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'wet-ancestor-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )

    assert.match(result, /differs from the repository root/)
    assert.ok(!callLog.some((c) => c.subcommand === 'allow'), 'expected the ancestor .envrc to never be consulted')
  })
})
