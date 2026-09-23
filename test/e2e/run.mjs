#!/usr/bin/env node
// test/e2e/run.mjs — design.md D9 layer 3: one real end-to-end run against
// the actual @opencode/cli V2 runtime. Not part of `npm test` (see
// package.json's "test:e2e" script) — this is the only check that can
// actually observe the highest-consequence failure mode in this change
// (D4's silent Code-Mode demotion), which is invisible to every mock.
//
// Asserts, against a real running opencode V2 process:
//   1. use_workdir is invoked as a direct native tool call, not via Code Mode.
//   2. A subsequent eligible tool call (the built-in shell tool) receives
//      the injected `workdir`.
//   3. The "Active Session Context (opencode-use)" block appears in the
//      assembled system prompt (observed indirectly via the workdir-
//      injection log line, since the raw system prompt is not exposed by
//      the CLI's --print-logs output).
//
// Requires `opencode` (the real @opencode/cli binary) resolvable on PATH,
// or overridable via the OPENCODE_V2_BIN environment variable — this repo's
// devDependency install places it at node_modules/.bin/opencode.

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, cp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

const OPENCODE_BIN = process.env.OPENCODE_V2_BIN ?? join(repoRoot, 'node_modules', '.bin', 'opencode')

/**
 * Runs the opencode CLI with stdin explicitly closed. execFile's default
 * piped-but-never-closed stdin was observed to make the real V2 binary
 * hang/exit early with truncated output under Node's child_process — bash's
 * redirected stdin does not have this problem, which is why a manual
 * `opencode run ...` invocation behaved differently from the equivalent
 * execFile call during this script's own development.
 */
function runOpencode(args, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(OPENCODE_BIN, args, {
      ...options,
      // Node's spawn `cwd` sets the OS-level working directory but does NOT
      // update a `PWD` env var inherited from the parent shell — and the
      // real V2 binary was observed picking the *parent's* PWD as its
      // project directory instead of the actual spawned cwd, silently
      // running against the wrong project. Override it explicitly.
      env: { ...process.env, PWD: options.cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 180_000)
    child.on('close', () => {
      clearTimeout(timer)
      resolvePromise({ stdout: output })
    })
  })
}

async function main() {
  const scratchDir = await mkdtemp(join(tmpdir(), 'opencode-use-e2e-'))
  try {
    await setupScratchProject(scratchDir)

    const { stdout } = await runOpencode(
      [
        'run',
        'call use_workdir with path ".", then run the shell tool with command "true" without specifying a workdir argument',
        '--print-logs',
        '--log-level',
        'debug',
        '--standalone',
        '--auto',
        '--model',
        process.env.OPENCODE_E2E_MODEL ?? 'github-copilot/claude-sonnet-5',
      ],
      { cwd: scratchDir, timeout: 180_000 },
    )

    if (process.env.OPENCODE_E2E_DEBUG) {
      console.error('--- full captured output ---')
      console.error(stdout)
      console.error('--- end captured output ---')
    }

    assertDirectToolCall(stdout, 'use_workdir')
    assertWorkdirInjected(stdout)

    console.log('test:e2e PASSED — direct tool call, workdir injection, and clean load all confirmed')
    process.exitCode = 0
  } finally {
    await rm(scratchDir, { recursive: true, force: true })
  }
}

async function setupScratchProject(scratchDir) {
  await mkdir(join(scratchDir, '.opencode', 'plugins', 'node_modules'), { recursive: true })
  await mkdir(join(scratchDir, '.opencode', 'lib'), { recursive: true })
  await cp(join(repoRoot, 'src', 'plugin.v2.js'), join(scratchDir, '.opencode', 'plugins', 'plugin.v2.js'))
  await cp(join(repoRoot, 'src', 'core.js'), join(scratchDir, '.opencode', 'lib', 'core.js'))
  await cp(join(repoRoot, 'src', 'lib.js'), join(scratchDir, '.opencode', 'lib', 'lib.js'))

  // plugin.v2.js imports './core.js' — rewrite the relative import for the
  // scratch project's directory layout (plugins/ and lib/ are siblings).
  const { readFile } = await import('node:fs/promises')
  const pluginSrc = await readFile(join(scratchDir, '.opencode', 'plugins', 'plugin.v2.js'), 'utf8')
  await writeFile(
    join(scratchDir, '.opencode', 'plugins', 'plugin.v2.js'),
    pluginSrc.replace("from './core.js'", "from '../lib/core.js'"),
  )

  await symlink(
    join(repoRoot, 'node_modules', '@opencode'),
    join(scratchDir, '.opencode', 'plugins', 'node_modules', '@opencode'),
  )

  await execFileAsync('git', ['init', '-q'], { cwd: scratchDir })
  await writeFile(join(scratchDir, 'README.md'), 'e2e scratch project\n')
}

function assertDirectToolCall(output, toolName) {
  // Non-TTY output (piped, as here) does not render the TUI's ⚙/✗ glyphs, so
  // detect Code-Mode indirection by its own distinctive signature instead:
  // the model routing the call through the separate `execute` JS tool
  // (`tools.<toolName>(...)`), which only happens when the tool is NOT
  // directly/natively callable (options.codemode: false missing or wrong).
  if (output.includes(`tools.${toolName}(`)) {
    console.error(output)
    throw new Error(
      `Found Code-Mode indirection ("tools.${toolName}(...)") in opencode output — ` +
      `the model had to route '${toolName}' through Code Mode instead of calling it directly. ` +
      `Check options.codemode: false on the tool descriptor.`,
    )
  }
  if (output.includes(`No tool named "${toolName}"`) || output.includes(`No tool named '${toolName}'`)) {
    throw new Error(`Output contains "No tool named ${toolName}" — the tool was rejected as unavailable.`)
  }
  // Raw tool return content is not echoed verbatim in --print-logs output
  // (only the model's own paraphrase is) — success is instead confirmed by
  // assertWorkdirInjected below: workdir-injection only logs when
  // state.cwd is truthy, which can only be true if use_workdir's execute body
  // actually ran and set it.
}

function assertWorkdirInjected(output) {
  if (!/workdir-injection: shell => /.test(output)) {
    console.error(output)
    throw new Error(
      `Expected a "workdir-injection: shell => <path>" log line confirming execute.before injected ` +
      `the session's active working directory into a shell tool call.`,
    )
  }
}

main().catch((err) => {
  console.error('test:e2e FAILED:', err.message)
  process.exitCode = 1
})
