// Shared test helpers for the opencode-use test suite.
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from 'node:child_process'

/** Create a fresh temp directory, registering its removal on test completion. */
export async function makeTempDir(t, prefix) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Minimal Node-based stand-in for the Bun `$` shell interface that this
 * plugin depends on (`` $`command` ``, `.cwd()`, `.quiet()`, `.text()`, and —
 * critically — direct `await`-ability without calling `.text()`, since real
 * Bun shell promises are themselves thenable). Throws an Error with
 * `.stderr` on non-zero exit. Bun is not installed on this dev/CI host (this
 * project's own CI runs on plain Node — see .github/workflows/ci.yml), so
 * this shim executes the reconstructed command string via
 * `child_process.exec` instead. Test inputs are simple, shell-safe strings
 * (paths/branch names with no spaces or shell metacharacters), so a plain
 * string interpolation is sufficient here — only the Bun-specific shell
 * object is substituted; everything downstream is real git, real
 * subprocesses, real temporary repositories.
 */
export function nodeShellShim(strings, ...values) {
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
export function runGit(args, cwd) {
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

/**
 * Create a fresh temp directory, `git init` it, and make an initial commit so
 * `git worktree add -b <branch>` succeeds on any git version. Older git (pre
 * auto-orphan-inference, e.g. 2.39.x) fails with "fatal: not a valid object
 * name: 'HEAD'" on a truly empty repo; newer git (2.43.0+) silently infers
 * `--orphan` instead. An initial commit makes this test portable across both.
 * Registers the temp directory's removal on test completion.
 */
export async function makeTempRepo(t, prefix) {
  const dir = await makeTempDir(t, prefix)
  await runGit('init -q', dir)
  await runGit('config user.email test@example.com', dir)
  await runGit('config user.name Test', dir)
  await runGit('commit --allow-empty -q -m init', dir)
  return dir
}

/**
 * A minimal, in-memory stand-in for opencode V2's `ctx.storage` (design.md
 * D7): async `get`/`set`/`remove`, plus a prefix-filtered, key-ordered,
 * paginated `scan`. `set()` JSON round-trips its value (via
 * `structuredClone`) so a non-JSON-serialisable record fails here, in a
 * test, rather than silently in production.
 *
 * @param {Map<string, any>} [backing] - shared, mutable backing store; pass
 *   the same Map into a second `makeFakeStorage` call to simulate a second
 *   process reading the same persisted data.
 * @param {{ scanLimit?: number }} [options]
 */
export function makeFakeStorage(backing = new Map(), { scanLimit } = {}) {
  const storage = {
    async get(key) {
      return backing.has(key) ? structuredClone(backing.get(key)) : undefined
    },
    async set(key, value) {
      backing.set(key, structuredClone(value))
    },
    async remove(key) {
      backing.delete(key)
    },
    async scan({ prefix, after, limit = scanLimit }) {
      const keys = [...backing.keys()].filter((k) => k.startsWith(prefix)).sort()
      const startIndex = after ? keys.findIndex((k) => k > after) : 0
      const page = limit ? keys.slice(startIndex, startIndex + limit) : keys.slice(startIndex)
      const entries = page.map((key) => ({ key, value: structuredClone(backing.get(key)) }))
      const next = limit && startIndex + limit < keys.length ? page[page.length - 1] : undefined
      return { entries, next }
    },
  }
  return { storage, backing }
}

/**
 * Wraps `makeFakeStorage` with fault injection: any method named in
 * `failOn` rejects instead of completing (design.md D4/D7's fault-injecting
 * fake storage).
 *
 * @param {Map<string, any>} [backing]
 * @param {{ failOn: string[] }} options
 */
export function makeFailingStorage(backing = new Map(), { failOn = [] } = {}) {
  const { storage: base } = makeFakeStorage(backing)
  const storage = { ...base }
  for (const method of failOn) {
    storage[method] = async () => {
      throw new Error(`simulated ${method} failure`)
    }
  }
  return { storage, backing }
}
