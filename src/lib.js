// ---------------------------------------------------------------------------
// opencode-use internals
// ---------------------------------------------------------------------------
//
// IMPORTANT: this file is deliberately NOT symlinked into
// `~/.config/opencode/plugins/` (only `src/index.js` is). opencode's own
// legacy-plugin loader (`getLegacyPlugins` in its plugin registry) invokes
// EVERY top-level named export of a scanned plugin file that is a function
// as an independent plugin factory, called as `server(input, load.options)`.
// Any helper exported here for direct unit testing would be misinterpreted
// as its own "plugin" and invoked with the wrong argument shape if this file
// were ever placed where opencode scans it. Keep it here, and have
// `src/index.js` import from it — `src/index.js` must export nothing but
// `default`. See `test/plugin-export-surface.test.js` for the regression
// guard and `openspec/changes/archive/*/fix-plugin-export-scan/proposal.md`
// for the full incident writeup.

import { dirname, join, relative, isAbsolute, resolve } from 'node:path'
import { stat, readFile, realpath } from 'node:fs/promises'

/**
 * Find the nearest existing ancestor directory of `path`, walking upward past
 * path segments that don't exist yet (e.g. an un-created `.worktrees/<branch>`
 * destination). Returns the filesystem root if no ancestor exists.
 */
export async function nearestExistingDir(path) {
  let dir = path
  while (true) {
    try {
      if ((await stat(dir)).isDirectory()) return dir
    } catch {
      // Doesn't exist yet — keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) return dir
    dir = parent
  }
}

/**
 * List all worktrees registered against the repository rooted at `root`, via
 * `git worktree list --porcelain`. Returns `[{ path, branch }]` — `branch` is
 * the raw `refs/heads/<name>` ref string (or `undefined` for a detached-HEAD
 * worktree, which has no `branch ` line in the porcelain output). Shared by
 * every `use_worktree` recovery path that needs to answer "is this branch (or
 * path) already registered somewhere?" so the porcelain-parsing logic exists
 * in exactly one place.
 */
export async function listWorktrees($, root) {
  const output = await $`git worktree list --porcelain`.cwd(root).quiet().text()
  return output.trim().split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n')
    return {
      path: lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length),
      branch: lines.find(l => l.startsWith('branch '))?.slice('branch '.length),
    }
  })
}

/**
 * Best-effort realpath: resolves symlinks in `path` for a canonical
 * comparison basis, without requiring `path` to exist. Walks up to the
 * nearest existing ancestor (the target worktree path itself typically
 * doesn't exist yet), realpaths that, then rejoins the non-existent
 * remainder. Falls back to the original path if realpath fails for any
 * other reason (e.g. permissions).
 */
async function realpathBestEffort(path) {
  const existing = await nearestExistingDir(path)
  const suffix = relative(existing, path)
  try {
    const real = await realpath(existing)
    return suffix ? join(real, suffix) : real
  } catch {
    return path
  }
}

/**
 * Whether two paths refer to the same location, tolerant of symlink
 * resolution differences — e.g. one side is git's own realpath'd
 * `worktree list` output, the other is the plugin's own `resolve()`d path
 * (design.md D3). Compares `resolve()`-normalised paths first, then falls
 * back to a realpath'd comparison so a symlinked path component doesn't
 * cause a spurious mismatch. Returns `false` for a missing/empty path
 * rather than throwing.
 */
export async function isSamePath(a, b) {
  if (!a || !b) return false
  if (resolve(a) === resolve(b)) return true
  const [realA, realB] = await Promise.all([
    realpathBestEffort(resolve(a)),
    realpathBestEffort(resolve(b)),
  ])
  return realA === realB
}

/**
 * Whether `child` is inside `parent`, or equal to it. Used to validate that a
 * resolved git root candidate actually contains the target worktree path —
 * a candidate can be a perfectly valid git repository while still being the
 * wrong one (e.g. a stale session context left over from an unrelated task).
 * Both sides are realpath'd before comparing so a symlinked path component
 * (e.g. a repo checked out under a symlinked directory) doesn't cause a
 * spurious containment failure against git's own (symlink-resolved) output.
 */
async function isPathInsideOrEqual(parent, child) {
  const realParent = await realpathBestEffort(resolve(parent))
  const realChild = await realpathBestEffort(resolve(child))
  const rel = relative(realParent, realChild)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Resolve a validated git root for worktree operations.
 * Tries `candidateRoot` (the session's gitRoot()) first; if that isn't
 * actually inside a git repository, or resolves to a git repository that does
 * NOT contain the target worktree path (e.g. a stale session context pointing
 * at an unrelated repository from an earlier task), falls back to discovering
 * one by walking up from the nearest existing ancestor of the target worktree
 * path — which, by construction, always contains that path. Throws a clear,
 * actionable error if neither yields a containing repository, instead of
 * letting a raw git subprocess error (e.g. "origin does not appear to be a
 * git repository") leak through from a later command run in the wrong place,
 * or — worse — silently running git operations against the wrong repository.
 *
 * @param {string} retryTool - The tool name to name in the failure message's
 *   retry instruction. Callers other than `use_worktree` (e.g. `use_clear`,
 *   which is trying to remove a worktree, not create one) must pass their own
 *   tool name so the suggested next step is the one that's actually correct
 *   for what the caller was trying to do.
 */
export async function resolveGitRoot($, candidateRoot, resolvedWorktreePath, retryTool = 'use_worktree') {
  const nearestExisting = await nearestExistingDir(dirname(resolvedWorktreePath))
  for (const cwd of [candidateRoot, nearestExisting]) {
    try {
      const root = (await $`git rev-parse --show-toplevel`.cwd(cwd).quiet().text()).trim()
      if (!(await isPathInsideOrEqual(root, resolvedWorktreePath))) continue
      return root
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `Cannot determine a git repository for this operation.\n` +
    `  Session git root candidate: '${candidateRoot}' is not inside a git repository.\n` +
    `  Target worktree path's nearest existing ancestor '${nearestExisting}' is not inside one either.\n` +
    `Call use_workdir('<path-to-the-target-repo>') first, then call ${retryTool} again.`,
  )
}

// ---------------------------------------------------------------------------
// Repository context auto-load (AGENTS.md discovery + .envrc detection)
// ---------------------------------------------------------------------------

/** Content above this size (bytes) is truncated before being stored/injected. */
const MAX_AGENTS_MD_BYTES = 16 * 1024

/** A file above this size (bytes) is not read at all. */
const MAX_AGENTS_MD_READ_BYTES = 1024 * 1024

/** Human-readable label for a byte count, for agent-facing note text (e.g. "16 KiB", "1 MiB"). */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${bytes / (1024 * 1024)} MiB`
  if (bytes >= 1024) return `${bytes / 1024} KiB`
  return `${bytes} bytes`
}

/**
 * Discover the git root for `dir` via `git rev-parse --show-toplevel`.
 * Never throws: returns `null` on any failure (not a repository, `git`
 * absent, permission error) rather than propagating an error, since this
 * discovery must remain best-effort (see design.md D2).
 */
export async function discoverGitRoot($, dir) {
  try {
    return (await $`git rev-parse --show-toplevel`.cwd(dir).quiet().text()).trim()
  } catch {
    return null
  }
}

/** True if `path` exists (file or directory), false otherwise. Never throws. */
async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Truncate `content` to at most `maxBytes` UTF-8 bytes, cutting at the last
 * newline within that budget so a multi-byte character or a mid-line cut
 * never corrupts the result. Returns the original content unchanged when it
 * is already within budget.
 *
 * Edge case (accepted, documented): if the content's first line alone
 * exceeds `maxBytes` (no newline within the budget), this falls back to a
 * hard byte-boundary cut rather than a true line boundary — `Buffer#toString`
 * safely emits a replacement character for any split multi-byte sequence at
 * that boundary rather than corrupting the string, so this degrades
 * gracefully; it does not corrupt output, it just does not honor "cut at a
 * line boundary" for this narrow, unlikely-in-practice case.
 */
function truncateContentToBytes(content, maxBytes) {
  const buf = Buffer.from(content, 'utf8')
  if (buf.byteLength <= maxBytes) return { content, truncated: false }
  let cut = buf.subarray(0, maxBytes)
  const lastNewline = cut.lastIndexOf(0x0a)
  if (lastNewline > 0) cut = cut.subarray(0, lastNewline)
  return { content: cut.toString('utf8'), truncated: true }
}

/**
 * Discover repository context (an `AGENTS.md` file and `.envrc` presence)
 * for `dir`, bounded by `dir`'s git root (or `dir` itself when not inside a
 * git repository). Never throws: every internal failure (git, filesystem, or
 * unexpected) is caught, logged, and resolves to
 * `{ agentsMd: null, envrcPath: null, notes: [] }`. `.envrc` is only ever
 * checked for existence — never read, never executed — for this discovery
 * step; `envrcPath` is surfaced so a caller (`applyDirectoryChange`) can
 * decide whether to load it (design.md D1).
 *
 * @returns {Promise<{ agentsMd: { repoPath: string, filePath: string, content: string }|null, envrcPath: string|null, notes: string[] }>}
 */
export async function resolveRepoContext($, dir, log) {
  try {
    let base
    try {
      base = await realpath(dir)
    } catch {
      base = dir
    }

    const root = await discoverGitRoot($, base)
    const boundary = root ?? base

    let agentsMdPath = null
    let envrcPath = null
    let current = base
    while (true) {
      if (!agentsMdPath && (await pathExists(join(current, 'AGENTS.md')))) {
        agentsMdPath = join(current, 'AGENTS.md')
      }
      if (!envrcPath && (await pathExists(join(current, '.envrc')))) {
        envrcPath = join(current, '.envrc')
      }
      if ((agentsMdPath && envrcPath) || current === boundary) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }

    const notes = []
    let agentsMd = null

    if (agentsMdPath) {
      const info = await stat(agentsMdPath)
      if (info.size > MAX_AGENTS_MD_READ_BYTES) {
        notes.push(
          `AGENTS.md at ${agentsMdPath} exceeds ${formatBytes(MAX_AGENTS_MD_READ_BYTES)} — ` +
          `not loaded automatically; read it directly if needed.`,
        )
      } else {
        const raw = await readFile(agentsMdPath, 'utf8')
        const { content, truncated } = truncateContentToBytes(raw, MAX_AGENTS_MD_BYTES)
        if (truncated) {
          const finalContent =
            `${content}\n\n[... AGENTS.md truncated — read ${agentsMdPath} directly for the full file ...]`
          agentsMd = { repoPath: boundary, filePath: agentsMdPath, content: finalContent }
          notes.push(`Loaded AGENTS.md from ${agentsMdPath} (truncated to ${formatBytes(MAX_AGENTS_MD_BYTES)}).`)
        } else {
          agentsMd = { repoPath: boundary, filePath: agentsMdPath, content: raw }
          notes.push(`Loaded AGENTS.md from ${agentsMdPath}.`)
        }
      }
    }

    return { agentsMd, envrcPath, notes }
  } catch (err) {
    log?.('resolveRepoContext failed', err)
    return { agentsMd: null, envrcPath: null, notes: [] }
  }
}

// ---------------------------------------------------------------------------
// Direnv status/export/allow primitives
// ---------------------------------------------------------------------------

/**
 * Budget for any single `direnv` subprocess invocation (`status`, `export`,
 * `allow`), mirroring the existing `HYDRATION_TIMEOUT_MS` convention. A Bun
 * `$` subprocess cannot be aborted mid-flight, so a timeout abandons the
 * promise (attaching a no-op `.catch()` so the eventual settlement doesn't
 * produce an unhandled rejection) and treats the call as failed.
 */
export const DIRENV_TIMEOUT_MS = 5000

/** Race `promise` against `DIRENV_TIMEOUT_MS`; resolves `TIMED_OUT` on timeout without waiting for `promise` to settle. */
const TIMED_OUT = Symbol('direnv-timeout')
function withDirenvTimeout(promise) {
  promise.catch(() => {}) // Prevent an unhandled rejection if it settles after the race.
  const timeout = new Promise((resolvePromise) => setTimeout(() => resolvePromise(TIMED_OUT), DIRENV_TIMEOUT_MS))
  return Promise.race([promise, timeout])
}

/**
 * Pure predicate: does `status` (the parsed JSON from `direnv status --json`)
 * report `envrcPath` — the exact file discovery found — as allowed?
 *
 * Matching on the path matters: direnv's own upward search is unbounded,
 * unlike discovery's git-root-bounded search (design.md D3), so a status hit
 * for a different (e.g. ancestor) RC file must not be read as a hit for ours.
 * `allowed: 1` (never approved) and `allowed: 2` (explicitly denied via
 * `direnv deny`) both return `false` here — this predicate only answers
 * "auto-load-eligible", not "why not".
 */
export function isDirenvStatusAllowed(status, envrcPath) {
  const foundRC = status?.state?.foundRC
  if (!foundRC || typeof foundRC !== 'object') return false
  return foundRC.allowed === 0 && foundRC.path === envrcPath
}

/**
 * Never throws. Returns `false` for every uncertainty — non-zero exit,
 * `ENOENT` (direnv absent), timeout, empty stdout, malformed JSON, or a
 * status shape `isDirenvStatusAllowed` doesn't recognise — logging the
 * reason each time. Fail-closed is the safe direction: a false negative
 * costs the agent today's `use_direnv` suggestion; a false positive would
 * execute an `.envrc` the user never trusted (design.md D2).
 *
 * @returns {Promise<boolean>}
 */
export async function checkDirenvAllowed($, { anchorDir, envrcPath }, log) {
  try {
    const result = await withDirenvTimeout($`direnv status --json`.cwd(anchorDir).quiet().text())
    if (result === TIMED_OUT) {
      log?.(`checkDirenvAllowed: direnv status --json timed out after ${DIRENV_TIMEOUT_MS}ms in ${anchorDir}`)
      return false
    }
    const trimmed = result.trim()
    if (!trimmed) {
      log?.(`checkDirenvAllowed: empty stdout from direnv status --json in ${anchorDir}`)
      return false
    }
    let status
    try {
      status = JSON.parse(trimmed)
    } catch (err) {
      log?.(`checkDirenvAllowed: malformed JSON from direnv status --json in ${anchorDir}`, err)
      return false
    }
    return isDirenvStatusAllowed(status, envrcPath)
  } catch (err) {
    log?.(`checkDirenvAllowed: direnv status --json failed in ${anchorDir}`, err)
    return false
  }
}

/**
 * Run `direnv export json` at `dir` and return the parsed, null-filtered,
 * `String()`-coerced environment delta. Throws the raw, unwrapped rejection
 * (preserving `.stderr`/`.code`) on subprocess failure, and lets a
 * `JSON.parse` failure propagate — exactly today's `executeUseDirenv`
 * sequence, extracted so `executeUseDirenv`'s own error translation (blocked,
 * `ENOENT`, fallback) stays entirely in `core.js`, unchanged (design.md D4).
 *
 * @returns {Promise<Record<string,string>>}
 */
export async function runDirenvExportJson($, dir) {
  const stdout = await $`direnv export json`.cwd(dir).quiet().text()
  const trimmed = stdout.trim()
  const raw = trimmed ? JSON.parse(trimmed) : {}
  const envDelta = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v !== null) envDelta[k] = String(v)
  }
  return envDelta
}

/**
 * Never-throwing, timeout-bounded wrapper around {@link runDirenvExportJson}
 * for the auto-load path, which needs none of `executeUseDirenv`'s rich error
 * translation — the allowed-check already passed, and every failure's remedy
 * is identical (fall back to the note-only behaviour). Returns `null` on any
 * failure (subprocess error, timeout, malformed JSON), logging the reason.
 *
 * @returns {Promise<Record<string,string>|null>}
 */
async function loadDirenvEnvSafe($, dir, log) {
  try {
    const result = await withDirenvTimeout(runDirenvExportJson($, dir))
    if (result === TIMED_OUT) {
      log?.(`loadDirenvEnvSafe: direnv export json timed out after ${DIRENV_TIMEOUT_MS}ms in ${dir}`)
      return null
    }
    return result
  } catch (err) {
    log?.(`loadDirenvEnvSafe: direnv export json failed in ${dir}`, err)
    return null
  }
}

/**
 * Auto-trusts a newly created worktree's `.envrc` when it is byte-identical
 * to the repository root's own already-allowed `.envrc` (design.md D7,
 * feature (e), narrowed to the create path only). Never throws.
 *
 * TOCTOU-safe by construction: every step reads fresh at the moment of
 * decision — nothing is reused from an earlier `resolveRepoContext` call,
 * and only the repository root's own `.envrc` is ever compared (no upward
 * search, no other-worktree comparison) since the byte-identity argument is
 * only defensible for the root↔worktree pair — a worktree is a checkout of
 * the same tracked tree as the root.
 *
 * @returns {Promise<{ notes: string[], contentVerified: boolean }>} `contentVerified: false`
 *   means the caller must skip auto-load for this pass — `direnv allow`
 *   hashes the file as it is on disk when `allow` runs, not the bytes
 *   compared in step 1, so a post-allow re-read that disagrees means the
 *   plugin cannot vouch for what it just blessed.
 */
async function maybeAutoTrustWorktreeEnvrc($, { repoRoot, worktreePath }, log) {
  const worktreeEnvrcPath = join(worktreePath, '.envrc')
  const rootEnvrcPath = join(repoRoot, '.envrc')

  let wtBytes
  try {
    wtBytes = await readFile(worktreeEnvrcPath)
  } catch {
    return { notes: [], contentVerified: true } // No .envrc in the new worktree — nothing to trust.
  }

  let rootBytes
  try {
    rootBytes = await readFile(rootEnvrcPath)
  } catch {
    return { notes: [], contentVerified: true } // No .envrc at the repo root — nothing to compare against.
  }

  if (!rootBytes.equals(wtBytes)) {
    return {
      notes: [
        `The worktree's .envrc at ${worktreeEnvrcPath} differs from the repository root's ` +
        `(${rootEnvrcPath}) — not auto-trusted. Call use_direnv('${worktreePath}') after reviewing it.`,
      ],
      contentVerified: true,
    }
  }

  const rootAllowed = await checkDirenvAllowed($, { anchorDir: repoRoot, envrcPath: rootEnvrcPath }, log)
  if (!rootAllowed) {
    return {
      notes: [
        `The worktree's .envrc at ${worktreeEnvrcPath} is byte-identical to the repository root's, ` +
        `but the root's .envrc is not itself allowed by direnv — not auto-trusted.`,
      ],
      contentVerified: true,
    }
  }

  try {
    const result = await withDirenvTimeout($`direnv allow ${worktreeEnvrcPath}`.cwd(worktreePath).quiet().text())
    if (result === TIMED_OUT) {
      log?.(`maybeAutoTrustWorktreeEnvrc: direnv allow timed out after ${DIRENV_TIMEOUT_MS}ms for ${worktreeEnvrcPath}`)
      return {
        notes: [`Auto-trusting the worktree's .envrc at ${worktreeEnvrcPath} timed out — not loaded.`],
        contentVerified: true,
      }
    }
  } catch (err) {
    log?.(`maybeAutoTrustWorktreeEnvrc: direnv allow failed for ${worktreeEnvrcPath}`, err)
    return {
      notes: [`Auto-trusting the worktree's .envrc at ${worktreeEnvrcPath} failed — not loaded.`],
      contentVerified: true,
    }
  }

  // Post-allow verification: `direnv allow` hashes the file as it is on disk
  // when `allow` runs, not the bytes compared above. Re-read and compare to
  // detect a modification in that window.
  let reReadBytes
  try {
    reReadBytes = await readFile(worktreeEnvrcPath)
  } catch (err) {
    log?.(`maybeAutoTrustWorktreeEnvrc: post-allow re-read failed for ${worktreeEnvrcPath}`, err)
    return {
      notes: [
        `The worktree's .envrc at ${worktreeEnvrcPath} could not be re-read after auto-trusting it — ` +
        `not loaded. Inspect the file and call use_direnv('${worktreePath}') manually.`,
      ],
      contentVerified: false,
    }
  }
  if (!reReadBytes.equals(wtBytes)) {
    return {
      notes: [
        `The worktree's .envrc at ${worktreeEnvrcPath} changed between being compared and being ` +
        `allowed — not loaded. Inspect the file and call use_direnv('${worktreePath}') manually.`,
      ],
      contentVerified: false,
    }
  }

  return {
    notes: [
      `Auto-trusted the worktree's .envrc at ${worktreeEnvrcPath} — identical to the already-allowed ` +
      `repository root .envrc.`,
    ],
    contentVerified: true,
  }
}

/**
 * Wraps (never bypasses) `applyDirectoryChange` for `use_worktree` (design.md
 * D7). On any non-create path (reuse, idempotent), delegates directly with
 * `autoLoadEnv: true` — auto-trust never runs there. On the create path, runs
 * {@link maybeAutoTrustWorktreeEnvrc} first so that a freshly blessed
 * `.envrc` is auto-loaded in the very same pass; `autoLoadEnv` is forced to
 * `false` only when the post-allow re-read verification fails.
 *
 * @param {{ repoRoot: string, created: boolean }} options
 * @returns {Promise<{ changed: boolean, notes: string[] }>}
 */
export async function applyDirectoryChangeForWorktree($, state, resolvedDir, log, { repoRoot, created }) {
  if (created !== true) {
    return applyDirectoryChange($, state, resolvedDir, log, { autoLoadEnv: true })
  }

  const { notes: trustNotes, contentVerified } = await maybeAutoTrustWorktreeEnvrc(
    $, { repoRoot, worktreePath: resolvedDir }, log,
  )
  const { changed, notes: changeNotes } = await applyDirectoryChange(
    $, state, resolvedDir, log, { autoLoadEnv: contentVerified },
  )
  return { changed, notes: [...trustNotes, ...changeNotes] }
}

/**
 * The single choke point for every session directory change. Assigns
 * `state.cwd` unconditionally, and — only when the resolved directory
 * differs from the prior `state.cwd` — runs repository-context discovery,
 * overwrites `state.agentsMd` with its result (including `null`), and
 * conditionally auto-loads an already-`direnv allow`-ed `.envrc` into
 * `state.env`/`state.envSource` (design.md D5).
 *
 * Invariant: `state.cwd` must only ever be assigned through this function
 * (see design.md D1); `use_clear` is the sole exception, and only ever nulls
 * it. The `try`/`catch` here is defense-in-depth only — `resolveRepoContext`
 * itself never throws (see design.md D8).
 *
 * `options.autoLoadEnv` defaults to `false` **deliberately** — every call
 * site must pass it explicitly (enforced by a source-guard test). The
 * asymmetric failure modes decide this: a call site that forgets the
 * argument under a `true` default would silently execute an `.envrc`
 * subprocess nobody reviewed for it; under a `false` default it only loses a
 * convenience.
 *
 * `state.env` is never cleared by a directory change — moving to a directory
 * with no `.envrc`, or an untrusted one, leaves any previously loaded
 * environment in place, matching `use_direnv`'s existing overwrite-only
 * precedent. `use_clear(['env'])` remains the sole explicit way to drop it.
 *
 * @param {{ autoLoadEnv?: boolean }} [options]
 * @returns {Promise<{ changed: boolean, notes: string[] }>}
 */
export async function applyDirectoryChange($, state, resolvedDir, log, options = {}) {
  const { autoLoadEnv = false } = options
  const changed = state.cwd !== resolvedDir
  state.cwd = resolvedDir
  if (!changed) return { changed: false, notes: [] }

  try {
    const { agentsMd, envrcPath, notes } = await resolveRepoContext($, resolvedDir, log)
    state.agentsMd = agentsMd

    if (!envrcPath) return { changed: true, notes }

    const anchorDir = dirname(envrcPath)
    const suggestManualLoadNote =
      `Found .envrc at ${envrcPath} — call use_direnv('${anchorDir}') to load it (not loaded automatically).`

    if (!autoLoadEnv) {
      return { changed: true, notes: [...notes, suggestManualLoadNote] }
    }

    const allowed = await checkDirenvAllowed($, { anchorDir, envrcPath }, log)
    if (!allowed) {
      return { changed: true, notes: [...notes, suggestManualLoadNote] }
    }

    const envDelta = await loadDirenvEnvSafe($, anchorDir, log)
    if (envDelta === null) {
      return {
        changed: true,
        notes: [
          ...notes,
          `Found .envrc at ${envrcPath} — it is allowed by direnv but automatic loading failed; ` +
          `call use_direnv('${anchorDir}') to retry.`,
        ],
      }
    }

    state.env = envDelta
    state.envSource = `direnv:${anchorDir}`
    const count = Object.keys(envDelta).length
    return {
      changed: true,
      notes: [
        ...notes,
        count > 0
          ? `Loaded ${count} variable(s) from .envrc at ${envrcPath} (already allowed by direnv).`
          : `.envrc at ${envrcPath} is allowed by direnv and was loaded — no environment changes exported.`,
      ],
    }
  } catch (err) {
    log?.('applyDirectoryChange discovery failed', err)
    state.agentsMd = null
    return { changed: true, notes: [] }
  }
}
