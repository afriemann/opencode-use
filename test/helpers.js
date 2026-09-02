// Shared test helpers for the opencode-use test suite.
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Create a fresh temp directory, registering its removal on test completion. */
export async function makeTempDir(t, prefix) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
