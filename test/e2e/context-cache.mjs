import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, chmod, cp, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const binary = join(root, 'node_modules/.bin/opencode')
const scratch = await mkdtemp(join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'context-cache-'))
const requests = []
const sessionIDs = []
let child
let fixtureError
const steps = []
const server = createServer(async (request, response) => {
  try {
    let bytes = ''
    for await (const chunk of request) bytes += chunk
    const body = JSON.parse(bytes)
    const primary = request.headers['x-context-fixture-kind'] === 'primary'
    if (primary) {
      requests.push(body)
      sessionIDs.push(request.headers['x-context-fixture-session'])
    }
    const step = primary ? steps.shift() : undefined
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    if (step) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.input) } }] })
      chunk({}, 'tool_calls')
    } else {
      chunk({ role: 'assistant', content: 'fixture complete' })
      chunk({}, 'stop')
    }
    response.end('data: [DONE]\n\n')
  } catch {
    fixtureError = new Error('Fake provider could not process a request')
    response.writeHead(500).end()
  }
})

function run(args, env, cwd) {
  return new Promise((resolvePromise, reject) => {
    child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let stdout = ''
    child.stdout.on('data', (data) => { output += data; stdout += data })
    child.stderr.on('data', (data) => { output += data })
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.once('error', reject)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, output, stdout })
    })
  })
}

try {
  const project = join(scratch, 'project')
  const other = join(scratch, 'other')
  const plugin = join(scratch, 'plugin')
  await Promise.all([project, other, plugin].map((path) => mkdir(path, { recursive: true })))
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': './index.js' } }))
  await writeFile(join(plugin, 'index.js'), `
import plugin from './src/plugin.v2.js'
export default { ...plugin, async setup(ctx) {
  const marker = await ctx.session.hook('http.request', (event) => {
    const headers = new Headers(event.request.headers)
    headers.set('x-context-fixture-kind', event.kind)
    headers.set('x-context-fixture-session', event.sessionID)
    event.request = new Request(event.request, { headers })
  })
  const cleanup = await plugin.setup(ctx)
  let other
  let compactionMode
  const compaction = await ctx.session.hook('compaction', (event) => {
    event.result = { summary: 'Synthetic compacted fixture history.' }
    if (compactionMode === 'native') event.result.native = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic native history window.' }] }] }
  })
  const control = await ctx.tool.transform((editor) => editor.add({
    name: 'context_fixture_control', description: 'Run the synthetic local environment fixture.',
    input: { type: 'object', properties: { action: { type: 'string', enum: ['other-load', 'other-clear', 'other-delete', 'compact-text', 'compact-native'] }, path: { type: 'string' } }, required: ['action', 'path'] },
    options: { codemode: false },
    async execute(input, context) {
      if (input.action.startsWith('compact-')) {
        compactionMode = input.action === 'compact-native' ? 'native' : 'text'
        await ctx.session.compact({ sessionID: context.sessionID })
        return { content: 'synthetic compaction admitted' }
      }
      if (!other) other = await ctx.session.create({ location: { directory: input.path } })
      if (input.action === 'other-delete') {
        await ctx.session.remove({ sessionID: other.id })
        try { await ctx.session.get({ sessionID: other.id }) } catch (error) {
          return { content: 'missing-session-tag:' + String(error?._tag ?? 'wrapped') }
        }
        throw new Error('Deleted fixture session still exists')
      }
      const tools = await ctx.tool.list()
      const name = input.action === 'other-load' ? 'use_direnv' : 'use_clear'
      const tool = tools.find((entry) => entry.name === name)
      if (!tool) throw new Error('Fixture context tool unavailable')
      await tool.execute(input.action === 'other-load' ? { path: input.path } : { fields: ['env'] }, { ...context, sessionID: other.id })
      return { content: 'synthetic environment fixture complete' }
    },
  }))
  return async () => { await cleanup?.(); await marker.dispose(); await control.dispose(); await compaction.dispose() }
} }
`)
  const sourceRef = process.env.OPENCODE_CONTEXT_TEST_REF
  if (sourceRef) {
    await mkdir(join(plugin, 'src'))
    const { stdout: paths } = await exec('git', ['ls-tree', '-r', '--name-only', sourceRef, 'src'], { cwd: root })
    for (const path of paths.trim().split('\n')) {
      const { stdout } = await exec('git', ['show', `${sourceRef}:${path}`], { cwd: root })
      await mkdir(join(plugin, dirname(path)), { recursive: true })
      await writeFile(join(plugin, path), stdout)
    }
  } else {
    await cp(join(root, 'src'), join(plugin, 'src'), { recursive: true })
  }
  await symlink(join(root, 'node_modules'), join(plugin, 'node_modules'))
  for (const directory of [project, other]) {
    await exec('git', ['init', '-q'], { cwd: directory })
    await writeFile(join(directory, 'AGENTS.md'), `Synthetic advisory for ${directory === project ? 'first' : 'second'} repository.\n`)
  }
  const bin = join(scratch, 'bin')
  await mkdir(bin)
  const direnv = join(bin, 'direnv')
  await writeFile(direnv, `#!/usr/bin/env node
if (process.argv.includes('export')) process.stdout.write(JSON.stringify({ EXAMPLE: 'fixture-environment-value' }))
else if (process.argv.includes('status')) process.stdout.write(JSON.stringify({ foundRC: { path: process.cwd() + '/.envrc', allowed: 0 } }))
`)
  await chmod(direnv, 0o700)
  await writeFile(join(project, '.envrc'), '# Synthetic fixture; never executed.\n')
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const config = {
    plugins: [plugin],
    providers: { fixture: {
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-not-a-credential' }, // pragma: allowlist secret - local fake provider
      models: { chat: { capabilities: { tools: true } } },
    } },
  }
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(scratch, 'home'), PWD: project,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG_DIR: join(scratch, 'config'),
    OPENCODE_DB: join(scratch, 'test.db'), OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_FILEWATCHER: 'true',
    XDG_CACHE_HOME: join(scratch, 'cache'), XDG_CONFIG_HOME: join(scratch, 'xdg-config'),
    XDG_DATA_HOME: join(scratch, 'data'), XDG_STATE_HOME: join(scratch, 'state'),
  }
  const { stdout: version } = await exec(binary, ['--version'], { env, cwd: project })
  assert.ok(version.trim().endsWith('2.2.5'), 'request capture must use the lockfile CLI version 2.2.5')
  steps.push(
    { name: 'use_workdir', input: { path: project } },
    { name: 'shell', input: { command: 'pwd' } },
    { name: 'use_direnv', input: { path: project } },
    { name: 'context_fixture_control', input: { action: 'other-load', path: project } },
    { name: 'context_fixture_control', input: { action: 'other-clear', path: project } },
    { name: 'use_workdir', input: { path: other } },
    { name: 'shell', input: { command: 'pwd' } },
    { name: 'use_clear', input: { fields: ['cwd', 'env', 'worktree'] } },
    { name: 'shell', input: { command: 'pwd' } },
  )
  const result = await run(['run', 'Execute the deterministic local fixture tools.', '--standalone', '--auto', '--model', 'fixture/chat'], env, project)
  if (fixtureError) throw fixtureError
  assert.ok(result.code === 0, `Isolated CLI failed (exit ${result.code}, signal ${result.signal ?? 'none'}, captured requests ${requests.length}, output bytes ${result.output.length})`)
  assert.equal(requests.length, 10, 'all native tool continuations must reach the fake provider')
  assert.ok(JSON.stringify(requests[0].tools).includes('use_workdir'), 'the provider must actually receive the native tool catalog')
  for (const [index, directory] of [[2, project], [7, other], [9, project]]) {
    const result = requests[index].messages.filter((message) => message.role === 'tool').at(-1)
    assert.ok(JSON.stringify(result?.content).includes(directory), 'shell output must reflect active routing and clearing')
  }
  const initialSystem = JSON.stringify(requests[0].messages.filter((message) => message.role === 'system' || message.role === 'developer'))
  for (let index = 1; index < requests.length; index++) {
    const before = requests[index - 1].messages
    const after = requests[index].messages
    const mismatch = before.findIndex((message, position) => JSON.stringify(message) !== JSON.stringify(after[position]))
    const shape = (message) => JSON.stringify({ role: message?.role, fields: Object.keys(message ?? {}), bytes: JSON.stringify(message ?? {}).length, snapshot: JSON.stringify(message ?? {}).includes('Session Context Snapshot') })
    assert.ok(mismatch < 0, `request ${index + 1} must preserve the previously sent message prefix (index ${mismatch}, before ${shape(before[mismatch])}, after ${shape(after[mismatch])})`)
    assert.ok(JSON.stringify(after.filter((message) => message.role === 'system' || message.role === 'developer')) === initialSystem, 'system text must remain stable')
    assert.ok(JSON.stringify(requests[index].tools) === JSON.stringify(requests[0].tools), 'tool declarations must remain stable')
  }
  const snapshots = requests.map((body) => JSON.stringify(body.messages).split('## Session Context Snapshot (opencode-use)').length - 1)
  assert.ok(JSON.stringify(snapshots) === JSON.stringify([1, 1, 1, 2, 3, 4, 5, 5, 6, 6]), `only real context transitions may add snapshots (counts ${snapshots.join(',')})`)
  const final = JSON.stringify(requests.at(-1).messages)
  assert.ok(final.includes('Repository advisory: none'), 'clearing must explicitly retire the current advisory')
  assert.ok(final.includes(other), 'the actual tool request path must reach the final request history')
  assert.ok(!final.includes('fixture-environment-value'), 'environment values must not enter the outgoing prompt')
  assert.ok(JSON.stringify(requests[4]).includes('injection may be suppressed'), 'another session loading env must deliver the concurrency warning')
  assert.ok(!JSON.stringify(requests[5]).split('## Session Context Snapshot (opencode-use)').at(-1).includes('injection may be suppressed'), 'clearing the other session must withdraw the applicable warning')
  const restartAt = requests.length
  steps.push({ name: 'shell', input: { command: `node -e 'process.stdout.write(process.env.EXAMPLE ?? "absent")'` } })
  const resumed = await run(['run', 'Continue the synthetic fixture after reload.', '--session', sessionIDs[0], '--standalone', '--auto', '--model', 'fixture/chat'], env, project)
  assert.ok(resumed.code === 0, 'the isolated session must resume after plugin restart')
  assert.equal(requests.length, restartAt + 2, 'resume must execute the shell continuation')
  assert.ok(JSON.stringify(requests[restartAt].messages.slice(0, requests[restartAt - 1].messages.length)) === JSON.stringify(requests[restartAt - 1].messages), 'reload must retain the exact previously sent prefix')
  assert.ok(JSON.stringify(requests.at(-1).messages.filter((message) => message.role === 'tool').at(-1)?.content).includes('absent'), 'reload must not restore a loaded environment from the journal')
  assert.ok(!JSON.stringify(requests.at(-1)).includes('fixture-environment-value'), 'reload must not reinject an environment value')
  for (const mode of ['text', 'native']) {
    const start = requests.length
    steps.push({ name: 'context_fixture_control', input: { action: `compact-${mode}`, path: project } })
    const compacted = await run(['run', 'Run the synthetic compaction fixture.', '--session', sessionIDs[0], '--standalone', '--auto', '--model', 'fixture/chat'], env, project)
    assert.ok(compacted.code === 0, `the ${mode} compaction run must complete`)
    assert.ok(requests.length > start + 1, `the ${mode} compaction must lead to a continuation request`)
    const window = JSON.stringify(requests.at(-1).messages)
    assert.ok(window.includes(mode === 'native' ? 'Synthetic native history window.' : 'Synthetic compacted fixture history.'), `the final provider request must contain the ${mode} compaction window`)
    assert.ok(window.includes('Session Context Snapshot'), 'compaction must supply current context in its replacement history')
  }
  const session = sessionIDs[0]
  const api = async (method, path, data) => {
    const args = ['api', method, path, '--standalone']
    if (data) args.push('--data', JSON.stringify(data))
    const result = await run(args, env, project)
    assert.ok(result.code === 0, `isolated lifecycle API ${method} must succeed`)
    return result.stdout.trim() ? JSON.parse(result.stdout) : undefined
  }
  const messages = await api('get', `/api/session/${session}/message?type=user&order=asc&limit=1`)
  const messageID = messages.data?.[0]?.id
  assert.ok(messageID, 'the canonical message API must supply a revert boundary')
  await api('post', `/api/session/${session}/revert/stage`, { messageID })
  await api('delete', `/api/session/${session}/revert`)
  const beforeClear = requests.at(-1).messages
  const clearedRevert = await run(['run', 'Continue after clearing the staged revert.', '--session', session, '--standalone', '--auto', '--model', 'fixture/chat'], env, project)
  assert.ok(clearedRevert.code === 0, 'a cleared staged revert must permit continuation')
  assert.ok(JSON.stringify(requests.at(-1).messages.slice(0, beforeClear.length)) === JSON.stringify(beforeClear), 'clearing a staged revert must preserve its original history prefix')
  await api('post', `/api/session/${session}/revert/stage`, { messageID })
  await api('post', `/api/session/${session}/revert/commit`)
  const committed = await run(['run', 'Continue from the committed revert boundary.', '--session', session, '--standalone', '--auto', '--model', 'fixture/chat'], env, project)
  assert.ok(committed.code === 0, 'a committed revert must permit a fresh context snapshot')
  assert.ok(!JSON.stringify(requests.at(-1).messages).includes(other), 'a removed transcript suffix must not resurrect historical context')
  const deletionAt = requests.length
  steps.push(
    { name: 'context_fixture_control', input: { action: 'other-load', path: project } },
    { name: 'context_fixture_control', input: { action: 'other-delete', path: project } },
    { name: 'shell', input: { command: `node -e 'process.stdout.write(process.env.EXAMPLE ?? "absent")'` } },
  )
  const deletion = await run(['run', 'Run the isolated deletion fixture.', '--session', session, '--standalone', '--auto', '--model', 'fixture/chat'], env, project)
  assert.ok(deletion.code === 0, 'the isolated deletion fixture must finish')
  const deletionResult = JSON.stringify(requests[deletionAt + 2].messages.filter((message) => message.role === 'tool').at(-1)?.content)
  assert.ok(deletionResult.includes('missing-session-tag:Session.NotFoundError'), 'the released Promise API must expose the exact recognized absence tag')
  assert.ok(JSON.stringify(requests.at(-1).messages.filter((message) => message.role === 'tool').at(-1)?.content).includes('absent'), 'deleted-session environments must not remain selectable')
  process.stdout.write(`context-cache: ${requests.length} final provider requests verified; loops, transitions, other-session environments and restart passed.\n`)
} catch (error) {
  process.stderr.write(`context-cache: ${error.message}\n`)
  process.exitCode = 1
} finally {
  child?.kill('SIGTERM')
  await new Promise((resolvePromise) => server.close(resolvePromise))
  await rm(scratch, { recursive: true, force: true })
}
