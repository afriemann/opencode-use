// spec: openspec/changes/v2-plugin-migration/specs/workdir-injection/spec.md
// (Requirement: Shell Environment Injection — V2 fail-closed env-resolution ladder, D6)
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEnvSessionForShell } from '../src/core.js'

function makeSessions(entries) {
  return new Map(entries)
}

describe('resolveEnvSessionForShell (design.md D6 fail-closed ladder)', () => {
  it('returns null when no session has a non-empty environment', () => {
    const sessions = makeSessions([
      ['s1', { env: {}, cwd: '/a' }],
      ['s2', { env: {}, cwd: '/b' }],
    ])
    assert.equal(resolveEnvSessionForShell(sessions, { cwd: '/a' }), null)
  })

  it('resolves the single env-bearing session regardless of cwd (rule 1)', () => {
    const sessions = makeSessions([
      ['s1', { env: { FOO: 'bar' }, cwd: '/a' }],
      ['s2', { env: {}, cwd: '/b' }],
    ])
    const result = resolveEnvSessionForShell(sessions, { cwd: '/unrelated' })
    assert.equal(result.sessionID, 's1')
    assert.deepEqual(result.state.env, { FOO: 'bar' })
  })

  it('resolves by exact cwd match when multiple sessions have envs (rule 2)', () => {
    const sessions = makeSessions([
      ['s1', { env: { FOO: 'bar' }, cwd: '/a' }],
      ['s2', { env: { BAZ: 'qux' }, cwd: '/b' }],
    ])
    const result = resolveEnvSessionForShell(sessions, { cwd: '/b' })
    assert.equal(result.sessionID, 's2')
  })

  it('resolves by ancestor cwd match when multiple sessions have envs (rule 2)', () => {
    const sessions = makeSessions([
      ['s1', { env: { FOO: 'bar' }, cwd: '/a' }],
      ['s2', { env: { BAZ: 'qux' }, cwd: '/repo/worktree' }],
    ])
    const result = resolveEnvSessionForShell(sessions, { cwd: '/repo/worktree/subdir' })
    assert.equal(result.sessionID, 's2')
  })

  it('never matches a sibling directory that merely shares a string prefix (not a real ancestor)', () => {
    const sessions = makeSessions([
      ['s1', { env: { FOO: 'bar' }, cwd: '/repo/worktree' }],
      ['s2', { env: { BAZ: 'qux' }, cwd: '/repo/worktree-other' }],
    ])
    const result = resolveEnvSessionForShell(sessions, { cwd: '/repo/worktree-other/subdir' })
    assert.equal(result.sessionID, 's2')
  })

  it('resolves to ambiguous (inject nothing) when multiple sessions have envs and none matches by cwd', () => {
    const sessions = makeSessions([
      ['s1', { env: { FOO: 'bar' }, cwd: '/a' }],
      ['s2', { env: { BAZ: 'qux' }, cwd: '/b' }],
    ])
    const result = resolveEnvSessionForShell(sessions, { cwd: '/unrelated' })
    assert.equal(result.ambiguous, true)
    assert.deepEqual(new Set(result.candidates), new Set(['s1', 's2']))
  })

  it('resolves to ambiguous when multiple sessions have envs and the invocation carries no cwd', () => {
    const sessions = makeSessions([
      ['s1', { env: { FOO: 'bar' }, cwd: '/a' }],
      ['s2', { env: { BAZ: 'qux' }, cwd: '/b' }],
    ])
    const result = resolveEnvSessionForShell(sessions, {})
    assert.equal(result.ambiguous, true)
  })

  it('never returns a session other than the one resolved by the ladder (no wrong-session injection)', () => {
    // Two env-bearing sessions, cwd matches BOTH by prefix ambiguity guard --
    // construct a case where two sessions' cwds are equal (pathological but
    // must still resolve deterministically to ambiguous, never guess).
    const sessions = makeSessions([
      ['s1', { env: { FOO: 'bar' }, cwd: '/same' }],
      ['s2', { env: { BAZ: 'qux' }, cwd: '/same' }],
    ])
    const result = resolveEnvSessionForShell(sessions, { cwd: '/same' })
    assert.equal(result.ambiguous, true)
  })
})
