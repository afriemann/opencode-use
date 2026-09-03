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

import { dirname, join } from 'node:path'
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
 * Resolve a validated git root for worktree operations.
 * Tries `candidateRoot` (the session's gitRoot()) first; if that isn't
 * actually inside a git repository, falls back to discovering one by walking
 * up from the nearest existing ancestor of the target worktree path. Throws a
 * clear, actionable error if neither yields a real repository, instead of
 * letting a raw git subprocess error (e.g. "origin does not appear to be a
 * git repository") leak through from a later command run in the wrong place.
 */
export async function resolveGitRoot($, candidateRoot, resolvedWorktreePath) {
  const nearestExisting = await nearestExistingDir(dirname(resolvedWorktreePath))
  for (const cwd of [candidateRoot, nearestExisting]) {
    try {
      return (await $`git rev-parse --show-toplevel`.cwd(cwd).quiet().text()).trim()
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `Cannot determine a git repository for this operation.\n` +
    `  Session git root candidate: '${candidateRoot}' is not inside a git repository.\n` +
    `  Target worktree path's nearest existing ancestor '${nearestExisting}' is not inside one either.\n` +
    `Call use_cwd('<path-to-the-target-repo>') first, then call use_worktree again.`,
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
 * unexpected) is caught, logged, and resolves to `{ agentsMd: null, notes: [] }`.
 * `.envrc` is only ever checked for existence — never read, never executed.
 *
 * @returns {Promise<{ agentsMd: { repoPath: string, filePath: string, content: string }|null, notes: string[] }>}
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

    if (envrcPath) {
      notes.push(
        `Found .envrc at ${envrcPath} — call use_direnv('${dirname(envrcPath)}') to load it ` +
        `(not loaded automatically).`,
      )
    }

    return { agentsMd, notes }
  } catch (err) {
    log?.('resolveRepoContext failed', err)
    return { agentsMd: null, notes: [] }
  }
}

/**
 * The single choke point for every session directory change. Assigns
 * `state.cwd` unconditionally, and — only when the resolved directory
 * differs from the prior `state.cwd` — runs repository-context discovery
 * and overwrites `state.agentsMd` with its result (including `null`).
 *
 * Invariant: `state.cwd` must only ever be assigned through this function
 * (see design.md D1); `use_clear` is the sole exception, and only ever nulls
 * it. The `try`/`catch` here is defense-in-depth only — `resolveRepoContext`
 * itself never throws (see design.md D8).
 *
 * @returns {Promise<{ changed: boolean, notes: string[] }>}
 */
export async function applyDirectoryChange($, state, resolvedDir, log) {
  const changed = state.cwd !== resolvedDir
  state.cwd = resolvedDir
  if (!changed) return { changed: false, notes: [] }

  try {
    const { agentsMd, notes } = await resolveRepoContext($, resolvedDir, log)
    state.agentsMd = agentsMd
    return { changed: true, notes }
  } catch (err) {
    log?.('applyDirectoryChange discovery failed', err)
    state.agentsMd = null
    return { changed: true, notes: [] }
  }
}
