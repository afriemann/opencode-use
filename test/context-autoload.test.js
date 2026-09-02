// spec: openspec/changes/auto-load-repo-context/specs/context-autoload/spec.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { exec } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import OpenCodeUse from '../src/index.js'
import {
  discoverGitRoot,
  resolveRepoContext,
  applyDirectoryChange,
} from '../src/lib.js'
import { makeTempDir } from './helpers.js'

/** Minimal Node-based stand-in for the Bun `$` shell interface, executing real git subprocesses. */
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

/** A shell shim whose text()/then() always reject — proves no subprocess is invoked. */
function throwingShellShim() {
  return {
    cwd() {
      return this
    },
    quiet() {
      return this
    },
    text() {
      return Promise.reject(new Error('subprocess must not be invoked'))
    },
    then(_resolve, reject) {
      return Promise.reject(new Error('subprocess must not be invoked')).catch(reject)
    },
  }
}

function noopLog() {}

/** Create a fresh temp directory and `git init` it, registering its removal on test completion. */
async function makeTempRepo(t, prefix) {
  const dir = await makeTempDir(t, prefix)
  await new Promise((resolvePromise, reject) => {
    exec('git init -q', { cwd: dir }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message))
        return
      }
      resolvePromise(stdout)
    })
  })
  return dir
}

/** Run a git command in `dir` and resolve with stdout, rejecting with a real Error on failure. */
function runGit(dir, command) {
  return new Promise((resolvePromise, reject) => {
    exec(command, { cwd: dir }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message))
        return
      }
      resolvePromise(stdout)
    })
  })
}

/**
 * Commit every file currently in `dir` on whatever branch is checked out
 * there. A `git worktree add` only checks out *committed* content — writing
 * a file into the main worktree's working directory does not make it
 * visible to a newly created linked worktree unless it is committed first.
 */
async function commitAll(dir, message = 'test commit') {
  await runGit(dir, 'git add -A')
  await runGit(
    dir,
    `git -c user.email=test@example.com -c user.name=test commit -q -m ${JSON.stringify(message)}`,
  )
}

let sessionCounter = 0
function uniqueSessionId() {
  sessionCounter += 1
  return `context-autoload-test-${sessionCounter}`
}

async function makePlugin() {
  return OpenCodeUse({ client: { app: { log: () => Promise.resolve() } }, $: nodeShellShim })
}

describe('discoverGitRoot', () => {
  it('resolves the canonical root for a directory inside a git repository', async (t) => {
    const repoRoot = await makeTempRepo(t, 'dgr-repo-')
    const nested = join(repoRoot, 'nested')
    await mkdir(nested)

    const root = await discoverGitRoot(nodeShellShim, nested)

    assert.equal(root, repoRoot)
  })

  it('returns null (not throws) for a directory that is not inside a repository', async (t) => {
    const dir = await makeTempDir(t, 'dgr-notarepo-')

    const root = await discoverGitRoot(nodeShellShim, dir)

    assert.equal(root, null)
  })
})

describe('resolveRepoContext', () => {
  it('AGENTS.md exists at the resolved directory', async (t) => {
    const repoRoot = await makeTempRepo(t, 'rrc-target-')
    await writeFile(join(repoRoot, 'AGENTS.md'), '# Root instructions\n')

    const result = await resolveRepoContext(nodeShellShim, repoRoot, noopLog)

    assert.ok(result.agentsMd)
    assert.equal(result.agentsMd.repoPath, repoRoot)
    assert.equal(result.agentsMd.filePath, join(repoRoot, 'AGENTS.md'))
    assert.equal(result.agentsMd.content, '# Root instructions\n')
    assert.ok(result.notes.some((n) => n.includes('Loaded AGENTS.md from')))
  })

  it('AGENTS.md exists only at an ancestor within the git root', async (t) => {
    const repoRoot = await makeTempRepo(t, 'rrc-ancestor-')
    await writeFile(join(repoRoot, 'AGENTS.md'), '# Root instructions\n')
    const nested = join(repoRoot, 'packages', 'foo')
    await mkdir(nested, { recursive: true })

    const result = await resolveRepoContext(nodeShellShim, nested, noopLog)

    assert.ok(result.agentsMd)
    assert.equal(result.agentsMd.filePath, join(repoRoot, 'AGENTS.md'))
    assert.equal(result.agentsMd.repoPath, repoRoot)
  })

  it('multiple AGENTS.md files exist between the directory and the git root', async (t) => {
    const repoRoot = await makeTempRepo(t, 'rrc-nearest-')
    await writeFile(join(repoRoot, 'AGENTS.md'), '# Root\n')
    const nested = join(repoRoot, 'packages', 'foo')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'AGENTS.md'), '# Nested\n')

    const result = await resolveRepoContext(nodeShellShim, nested, noopLog)

    assert.equal(result.agentsMd.filePath, join(nested, 'AGENTS.md'))
    assert.equal(result.agentsMd.content, '# Nested\n')
  })

  it('no AGENTS.md exists anywhere between the directory and the git root', async (t) => {
    const repoRoot = await makeTempRepo(t, 'rrc-none-')
    const nested = join(repoRoot, 'packages', 'foo')
    await mkdir(nested, { recursive: true })

    const result = await resolveRepoContext(nodeShellShim, nested, noopLog)

    assert.equal(result.agentsMd, null)
  })

  it('resolved directory is not inside a git repository', async (t) => {
    const outerDir = await makeTempDir(t, 'rrc-notarepo-outer-')
    const innerDir = join(outerDir, 'inner')
    await mkdir(innerDir)
    // AGENTS.md at the outer, non-repo ancestor must NOT be picked up —
    // the search must be confined to innerDir alone when not in a repo.
    await writeFile(join(outerDir, 'AGENTS.md'), '# Should not be found\n')

    const result = await resolveRepoContext(nodeShellShim, innerDir, noopLog)

    assert.equal(result.agentsMd, null)
  })

  it('git is unavailable or the directory check fails', async (t) => {
    const dir = await makeTempDir(t, 'rrc-git-fails-')
    await writeFile(join(dir, 'AGENTS.md'), '# Fallback\n')

    const result = await resolveRepoContext(throwingShellShim, dir, noopLog)

    // Falls back to searching only `dir` itself, still finding its own file.
    assert.ok(result.agentsMd)
    assert.equal(result.agentsMd.filePath, join(dir, 'AGENTS.md'))
  })

  it('.envrc exists between the resolved directory and the git root', async (t) => {
    const repoRoot = await makeTempRepo(t, 'rrc-envrc-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')

    const result = await resolveRepoContext(nodeShellShim, repoRoot, noopLog)

    assert.ok(result.notes.some((n) => n.includes('.envrc') && n.includes('use_direnv')))
  })

  it('no .envrc exists', async (t) => {
    const repoRoot = await makeTempRepo(t, 'rrc-no-envrc-')

    const result = await resolveRepoContext(nodeShellShim, repoRoot, noopLog)

    assert.ok(!result.notes.some((n) => n.includes('.envrc')))
  })

  it('detection never invokes a direnv subprocess', async (t) => {
    const repoRoot = await makeTempRepo(t, 'rrc-no-direnv-subprocess-')
    await writeFile(join(repoRoot, '.envrc'), 'export FOO=bar\n')

    // nodeShellShim only ever runs `git` commands in this test file — if the
    // implementation invoked a `direnv` command through the shell, it would
    // fail (direnv likely absent) and resolveRepoContext must not surface
    // that failure or otherwise indicate an execution attempt occurred.
    const result = await resolveRepoContext(nodeShellShim, repoRoot, noopLog)

    assert.ok(result.notes.some((n) => n.includes('.envrc')))
    // No note implies the .envrc's contents were read/executed.
    assert.ok(!result.notes.some((n) => n.includes('FOO')))
  })

  it('AGENTS.md is within the load limit', async (t) => {
    const repoRoot = await makeTempRepo(t, 'rrc-size-ok-')
    const content = 'x'.repeat(100)
    await writeFile(join(repoRoot, 'AGENTS.md'), content)

    const result = await resolveRepoContext(nodeShellShim, repoRoot, noopLog)

    assert.equal(result.agentsMd.content, content)
    assert.ok(result.notes.some((n) => n === `Loaded AGENTS.md from ${join(repoRoot, 'AGENTS.md')}.`))
  })

  it('AGENTS.md exceeds the load limit but is within the read limit', async (t) => {
    const repoRoot = await makeTempRepo(t, 'rrc-size-truncate-')
    // 17 KiB of content, each line short, so a line boundary exists before 16 KiB.
    const line = 'a'.repeat(80) + '\n'
    const content = line.repeat(220) // ~17.6 KiB
    await writeFile(join(repoRoot, 'AGENTS.md'), content)

    const result = await resolveRepoContext(nodeShellShim, repoRoot, noopLog)

    assert.ok(result.agentsMd)
    assert.ok(Buffer.byteLength(result.agentsMd.content, 'utf8') <= 16 * 1024 + 200) // truncated + marker
    assert.ok(result.agentsMd.content.length < content.length)
    assert.ok(result.notes.some((n) => n.includes('truncated')))
  })

  it('AGENTS.md exceeds the read limit', async (t) => {
    const repoRoot = await makeTempRepo(t, 'rrc-size-skip-')
    const huge = 'x'.repeat(1024 * 1024 + 10)
    await writeFile(join(repoRoot, 'AGENTS.md'), huge)

    const result = await resolveRepoContext(nodeShellShim, repoRoot, noopLog)

    assert.equal(result.agentsMd, null)
    assert.ok(result.notes.some((n) => n.includes('exceeds') && n.includes('not loaded automatically')))
  })

  it('an unexpected failure occurs during discovery', async (t) => {
    // A directory that does not exist at all: stat/readFile calls inside
    // discovery should fail, and the function must degrade to the null result
    // rather than throwing.
    const parent = await makeTempDir(t, 'rrc-unexpected-')
    const missing = join(parent, 'does-not-exist')

    await assert.doesNotReject(async () => {
      const result = await resolveRepoContext(nodeShellShim, missing, noopLog)
      assert.equal(result.agentsMd, null)
      assert.deepEqual(result.notes, [])
    })
  })
})

describe('applyDirectoryChange', () => {
  it('assigns state.cwd unconditionally', async () => {
    const state = { cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null }
    const dir = '/tmp/some-dir-does-not-need-to-exist-for-this-assertion'

    await applyDirectoryChange(nodeShellShim, state, dir, noopLog)

    assert.equal(state.cwd, dir)
  })

  it('runs discovery only when the resolved directory differs from the prior state.cwd', async (t) => {
    const repoRootA = await makeTempRepo(t, 'adc-a-')
    await writeFile(join(repoRootA, 'AGENTS.md'), '# A\n')
    const repoRootB = await makeTempRepo(t, 'adc-b-')
    await writeFile(join(repoRootB, 'AGENTS.md'), '# B\n')

    const state = { cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null }

    const first = await applyDirectoryChange(nodeShellShim, state, repoRootA, noopLog)
    assert.equal(first.changed, true)
    assert.equal(state.agentsMd.content, '# A\n')

    const second = await applyDirectoryChange(nodeShellShim, state, repoRootA, noopLog)
    assert.equal(second.changed, false)
    assert.deepEqual(second.notes, [])
    // agentsMd from the first call must remain untouched by the no-op call.
    assert.equal(state.agentsMd.content, '# A\n')

    const third = await applyDirectoryChange(nodeShellShim, state, repoRootB, noopLog)
    assert.equal(third.changed, true)
    assert.equal(state.agentsMd.content, '# B\n')
  })

  it('overwrites state.agentsMd to null when the new directory has no AGENTS.md', async (t) => {
    const repoRootA = await makeTempRepo(t, 'adc-clear-a-')
    await writeFile(join(repoRootA, 'AGENTS.md'), '# A\n')
    const repoRootB = await makeTempRepo(t, 'adc-clear-b-')

    const state = { cwd: null, env: {}, envSource: null, worktree: null, agentsMd: null }
    await applyDirectoryChange(nodeShellShim, state, repoRootA, noopLog)
    assert.ok(state.agentsMd)

    await applyDirectoryChange(nodeShellShim, state, repoRootB, noopLog)
    assert.equal(state.agentsMd, null)
  })
})

describe('use_cwd integration', () => {
  it('use_cwd moves to a genuinely new directory triggers discovery', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const repoRoot = await makeTempRepo(t, 'ucwd-')
    await writeFile(join(repoRoot, 'AGENTS.md'), '# Repo\n')

    const result = await plugin.tool.use_cwd.execute(
      { path: repoRoot },
      { sessionID, directory: repoRoot },
    )

    assert.match(result, /Working directory set to/)
    assert.match(result, /Loaded AGENTS\.md from/)
  })

  it('use_cwd is called again with the same resolved directory', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const repoRoot = await makeTempRepo(t, 'ucwd-repeat-')
    await writeFile(join(repoRoot, 'AGENTS.md'), '# Repo\n')

    await plugin.tool.use_cwd.execute({ path: repoRoot }, { sessionID, directory: repoRoot })
    const second = await plugin.tool.use_cwd.execute({ path: repoRoot }, { sessionID, directory: repoRoot })

    assert.doesNotMatch(second, /Loaded AGENTS\.md from/)
  })
})

describe('use_worktree integration (reuse paths)', () => {
  it("use_worktree's idempotent same-path return does not repeat discovery", async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const repoRoot = await makeTempRepo(t, 'uwt-idem-')
    await writeFile(join(repoRoot, 'AGENTS.md'), '# Repo\n')
    await commitAll(repoRoot)
    const worktreePath = join(repoRoot, '.worktrees', 'idem-branch')

    const first = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'idem-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )
    assert.match(first, /Loaded AGENTS\.md from/)

    const second = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'idem-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )
    assert.match(second, /already active/)
    assert.doesNotMatch(second, /Loaded AGENTS\.md from/)
  })

  it("use_worktree's idempotent same-path return fires after the directory moved elsewhere", async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const repoRoot = await makeTempRepo(t, 'uwt-moved-')
    await writeFile(join(repoRoot, 'AGENTS.md'), '# Repo\n')
    await commitAll(repoRoot)
    const worktreePath = join(repoRoot, '.worktrees', 'moved-branch')

    await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'moved-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )

    // Move cwd elsewhere via use_cwd.
    const otherDir = await makeTempDir(t, 'uwt-moved-other-')
    await plugin.tool.use_cwd.execute({ path: otherDir }, { sessionID, directory: otherDir })

    // Calling use_worktree again with the SAME worktree path/branch hits the
    // idempotent early-return branch (state.worktree.path === resolved),
    // but state.cwd now differs (it points at otherDir) — discovery must re-run.
    const third = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'moved-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )
    assert.match(third, /already active/)
    assert.match(third, /Loaded AGENTS\.md from/)
  })

  it('use_worktree reuses an existing worktree via the already-exists recovery path', async (t) => {
    const repoRoot = await makeTempRepo(t, 'uwt-reuse-')
    await writeFile(join(repoRoot, 'AGENTS.md'), '# Repo\n')
    await commitAll(repoRoot)
    const worktreePath = join(repoRoot, '.worktrees', 'reuse-branch')

    // Pre-register the worktree directly via git, bypassing the plugin —
    // state.worktree starts null for the session created below.
    await runGit(repoRoot, `git worktree add -b reuse-branch ${worktreePath}`)

    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()

    const result = await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'reuse-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )

    assert.match(result, /already exists — reusing it/)
    assert.match(result, /Loaded AGENTS\.md from/)
  })

  it('clearing worktree clears loaded repository context when cwd pointed at it', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const repoRoot = await makeTempRepo(t, 'uwt-clear-')
    await writeFile(join(repoRoot, 'AGENTS.md'), '# Repo\n')
    await commitAll(repoRoot)
    const worktreePath = join(repoRoot, '.worktrees', 'clear-branch')

    await plugin.tool.use_worktree.execute(
      { path: worktreePath, branch: 'clear-branch', create: true, fromRemote: false },
      { sessionID, directory: repoRoot },
    )

    const result = await plugin.tool.use_clear.execute({ fields: ['worktree'] }, { sessionID, directory: repoRoot })

    assert.match(result, /repository/i)

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)
    assert.ok(!output.system.some((s) => s.includes('# Repo')))
  })
})

describe('Advisory system-prompt injection (integration)', () => {
  it('AGENTS.md content is present', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const repoRoot = await makeTempRepo(t, 'prompt-present-')
    await writeFile(join(repoRoot, 'AGENTS.md'), '# Hello from repo\n')

    await plugin.tool.use_cwd.execute({ path: repoRoot }, { sessionID, directory: repoRoot })

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)

    const block = output.system.find((s) => s.includes('Hello from repo'))
    assert.ok(block, 'expected the advisory block to be present')
    assert.ok(block.includes(repoRoot))
    assert.ok(block.includes(join(repoRoot, 'AGENTS.md')))
    assert.match(block, /advisory/i)
    assert.match(block, /untrusted/i)
  })

  it('AGENTS.md content is absent', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const repoRoot = await makeTempRepo(t, 'prompt-absent-')

    await plugin.tool.use_cwd.execute({ path: repoRoot }, { sessionID, directory: repoRoot })

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)

    assert.ok(!output.system.some((s) => s.includes('Advisory')))
  })

  it('content containing a run of backtick characters gets a longer fence', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const repoRoot = await makeTempRepo(t, 'prompt-fence-')
    await writeFile(join(repoRoot, 'AGENTS.md'), 'before\n````\nafter\n')

    await plugin.tool.use_cwd.execute({ path: repoRoot }, { sessionID, directory: repoRoot })

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)

    const block = output.system.find((s) => s.includes('before'))
    assert.ok(block)
    assert.match(block, /`{5,}/)
  })

  it('content containing a colliding backtick line with trailing whitespace still gets a longer fence', async (t) => {
    // Regression guard: a closing fence in real Markdown may be followed by
    // whitespace and still validly close — so a candidate line must be
    // trimmed on both ends before being counted, not leading-only.
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const repoRoot = await makeTempRepo(t, 'prompt-fence-trailing-ws-')
    await writeFile(join(repoRoot, 'AGENTS.md'), 'before\n```   \nafter\n')

    await plugin.tool.use_cwd.execute({ path: repoRoot }, { sessionID, directory: repoRoot })

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)

    const block = output.system.find((s) => s.includes('before'))
    assert.ok(block)
    assert.match(block, /`{4,}/)
  })

  it('a directory change replaces previously injected content', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const repoRootA = await makeTempRepo(t, 'prompt-replace-a-')
    await writeFile(join(repoRootA, 'AGENTS.md'), '# Repo A content\n')
    const repoRootB = await makeTempRepo(t, 'prompt-replace-b-')
    await writeFile(join(repoRootB, 'AGENTS.md'), '# Repo B content\n')

    await plugin.tool.use_cwd.execute({ path: repoRootA }, { sessionID, directory: repoRootA })
    await plugin.tool.use_cwd.execute({ path: repoRootB }, { sessionID, directory: repoRootB })

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)

    assert.ok(!output.system.some((s) => s.includes('Repo A content')))
    assert.ok(output.system.some((s) => s.includes('Repo B content')))
  })
})

describe('use_clear clears auto-loaded repository context', () => {
  it('clearing cwd clears loaded repository context', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const repoRoot = await makeTempRepo(t, 'clear-cwd-')
    await writeFile(join(repoRoot, 'AGENTS.md'), '# Repo\n')
    await plugin.tool.use_cwd.execute({ path: repoRoot }, { sessionID, directory: repoRoot })

    const result = await plugin.tool.use_clear.execute({ fields: ['cwd'] }, { sessionID, directory: repoRoot })

    assert.match(result, /repository/i)

    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)
    assert.ok(!output.system.some((s) => s.includes('# Repo')))
  })

  it('clearing with no repository context loaded adds no repository-context line', async (t) => {
    const plugin = await makePlugin()
    const sessionID = uniqueSessionId()
    const dir = await makeTempDir(t, 'clear-no-context-')
    await plugin.tool.use_cwd.execute({ path: dir }, { sessionID, directory: dir })

    const result = await plugin.tool.use_clear.execute({ fields: ['cwd'] }, { sessionID, directory: dir })

    assert.doesNotMatch(result, /repository/i)
  })
})

describe('use_direnv no longer changes the session active directory', () => {
  it('use_direnv loads environment without moving the active directory', async (t) => {
    function fakeDirenvShell() {
      return function taggedTemplate() {
        const builder = {
          cwd() {
            return builder
          },
          quiet() {
            return builder
          },
          text() {
            return Promise.resolve('{}')
          },
          then(resolvePromise, reject) {
            return Promise.resolve('{}').then(resolvePromise, reject)
          },
        }
        return builder
      }
    }
    const plugin = await OpenCodeUse({
      client: { app: { log: () => Promise.resolve() } },
      $: fakeDirenvShell(),
    })
    const sessionID = uniqueSessionId()
    const cwdDir = await makeTempDir(t, 'direnv-nocwd-cwd-')
    const otherDir = await makeTempDir(t, 'direnv-nocwd-other-')
    await plugin.tool.use_cwd.execute({ path: cwdDir }, { sessionID, directory: cwdDir })

    await plugin.tool.use_direnv.execute({ path: otherDir, changeCwd: true }, { sessionID, directory: cwdDir })

    // changeCwd must no longer be accepted/acted upon at all: the session's
    // reported active working directory must still be cwdDir, not otherDir.
    const output = { system: [] }
    await plugin['experimental.chat.system.transform']({ sessionID }, output)
    const contextBlock = output.system.find((s) => s.includes('Active Session Context'))
    const workdirLine = contextBlock.split('\n').find((line) => line.includes('**Working directory**'))
    assert.ok(workdirLine.includes(cwdDir))
    assert.ok(!workdirLine.includes(otherDir))
  })
})

describe('D1 invariant guard (recommended, design.md Component Breakdown)', () => {
  it('src/index.js contains no non-null state.cwd assignment (only applyDirectoryChange in lib.js may assign it)', async () => {
    const { readFile: readFileText } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const source = await readFileText(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8')

    const offendingLines = []
    source.split('\n').forEach((line, i) => {
      // Match a real assignment to state.cwd that isn't `null` and isn't `===`.
      if (/state\.cwd\s*=\s*[^=]/.test(line) && !/state\.cwd\s*=\s*null/.test(line)) {
        offendingLines.push(`${i + 1}: ${line.trim()}`)
      }
    })

    assert.deepEqual(offendingLines, [], `unexpected state.cwd assignment(s) in src/index.js:\n${offendingLines.join('\n')}`)
  })

  it('src/lib.js assigns state.cwd only inside applyDirectoryChange', async () => {
    const { readFile: readFileText } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const source = await readFileText(fileURLToPath(new URL('../src/lib.js', import.meta.url)), 'utf8')

    const offendingLines = []
    let currentFunction = null
    source.split('\n').forEach((line, i) => {
      const fnMatch = line.match(/^(?:export )?(?:async )?function (\w+)/)
      if (fnMatch) currentFunction = fnMatch[1]
      if (/state\.cwd\s*=\s*[^=]/.test(line) && !/state\.cwd\s*=\s*null/.test(line)) {
        const allowed = currentFunction === 'applyDirectoryChange'
        if (!allowed) offendingLines.push(`${i + 1}: ${line.trim()} (in ${currentFunction})`)
      }
    })

    assert.deepEqual(offendingLines, [], `unexpected state.cwd assignment(s) in src/lib.js:\n${offendingLines.join('\n')}`)
  })
})
