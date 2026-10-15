// SPDX-License-Identifier: Apache-2.0
//
// Guards the effort level and the permissions the extraction run starts with.
//
// Effort. The extraction step is a headless `claude -p` launched from the
// user's own shell, so it inherits that shell's environment — and
// CLAUDE_CODE_EFFORT_LEVEL outranks --effort, /effort and every effortLevel
// setting. A user who exports `max` for their interactive sessions (one did, in
// ~/.zshrc) therefore ran every extraction at max: measured 2026-10-15 on two
// real transcripts, 90-95% of each run was thinking — 32-46K tokens before the
// first recall_save, 261-355 s end to end. Pinned to high, the same two runs
// took 26-40 s and wrote five memories each, no fewer than at max. Passing
// --effort cannot fix this; only the variable itself outranks the variable.
//
// High is a default, not a ceiling: CCRECALL_EXTRACT_EFFORT picks another
// level for the run, and the start message names the level used. A value
// that is not a level falls back to high with a warning, rather than
// reaching Claude Code as CLAUDE_CODE_EFFORT_LEVEL, where the message would
// then name a level the run did not get.
//
// Permissions. The run used to start with --dangerously-skip-permissions and
// every MCP server the user had configured, so a model reading a transcript the
// prompt itself calls untrusted held Bash and, on that machine, Gmail, Google
// Drive and Calendar connectors, with nothing asking first. It now loads only
// ccRecall's own server, no built-in tools, and an allowlist of the two tools
// extraction uses, under dontAsk: anything else is refused, not prompted for.
//
// The interactive session before extraction is deliberately untouched — the
// user chose its effort and its permissions — and so is the caller's shell,
// which this file is SOURCED into: an exported effort would follow the user
// into every later session started from that terminal.
//
// Every subprocess runs under `isolatedEnv`, which points HOME, PATH, the
// telemetry log and the daemon port into a temp dir, so nothing here reads or
// writes the real ~/.claude, ~/.ccrecall or :7749.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod, copyFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const WRAPPER = path.join(__dirname, '..', 'scripts', 'post-session-extract.sh')
const PROMPT_FILE = path.join(__dirname, '..', 'scripts', 'extraction-prompt.md')

const SESSION_ID = '11111111-2222-3333-4444-888888888888'
const PROJECT_ID = '-tmp-ccrecall-run-config-fixture'
/** How the stub records a variable that is not set at all. */
const UNSET = '<unset>'
const ALLOWED_TOOLS = 'mcp__ccrecall__recall_save,mcp__ccrecall__recall_query'
/** The levels CLAUDE_CODE_EFFORT_LEVEL accepts, per the Claude Code docs. */
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
/** Where the warning for a value that is not a level starts. */
const NOT_A_LEVEL = 'CCRECALL_EXTRACT_EFFORT must be one of '

const HAS_ZSH = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).status === 0
/** zsh is what users source this into; bash is what it is written against. */
const SHELLS = ['bash', ...(HAS_ZSH ? ['zsh'] : [])]

/**
 * Stub `claude`, first on PATH for both wrapper phases. Each invocation
 * appends the effort it was started with to a per-phase file and records its
 * argv NUL-separated, so an empty argument (`--tools ""`) survives intact.
 */
const STUB_CLAUDE = `#!/bin/bash
case " $* " in
  *" -p "*) phase=extract ;;
  *) phase=interactive ;;
esac
printf '%s\\n' "\${CLAUDE_CODE_EFFORT_LEVEL-${UNSET}}" >> "\${STUB_CLAUDE_OUT}/\${phase}.effort"
printf '%s\\0' "$@" > "\${STUB_CLAUDE_OUT}/\${phase}.argv.nul"
# Drain the prompt the wrapper pipes in, so its printf never meets a closed pipe.
if [ "$phase" = extract ]; then cat > /dev/null; fi
exit 0
`

/** Stub daemon in its own process: spawnSync blocks this thread's event loop. */
const STUB_DAEMON = `
const http = require('http')
const s = http.createServer((req, res) => {
  const p = req.url.split('?')[0]
  if (p === '/health') { res.writeHead(200); res.end('ok'); return }
  if (p === '/session/last') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ sessionId: ${JSON.stringify(SESSION_ID)}, projectId: ${JSON.stringify(PROJECT_ID)} }))
    return
  }
  res.writeHead(404); res.end()
})
s.listen(0, '127.0.0.1', () => process.stdout.write(s.address().port + '\\n'))
`

/** Enough dialogue for the wrapper to build a transcript and reach phase 2. */
function fixtureTranscript(): string {
  return [0, 1, 2, 3]
    .map((i) =>
      JSON.stringify({
        type: i % 2 === 0 ? 'user' : 'assistant',
        uuid: `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`,
        message: { content: [{ type: 'text', text: `fixture message ${i}` }] },
      }),
    )
    .join('\n') + '\n'
}

/** The argument right after `flag`, failing loudly when the flag is absent. */
function valueAfter(argv: string[], flag: string): string {
  const i = argv.indexOf(flag)
  expect(i, `${flag} missing from argv: ${JSON.stringify(argv)}`).toBeGreaterThanOrEqual(0)
  expect(i + 1, `${flag} has no value in argv: ${JSON.stringify(argv)}`).toBeLessThan(argv.length)
  return argv[i + 1]
}

/**
 * The least-privilege shape every extraction run must have, wherever it was
 * started from. Asserted on what claude actually received.
 */
function expectLeastPrivilege(argv: string[]) {
  expect(argv).not.toContain('--dangerously-skip-permissions')
  expect(argv).toContain('--strict-mcp-config')
  const servers = JSON.parse(valueAfter(argv, '--mcp-config')).mcpServers
  expect(Object.keys(servers)).toEqual(['ccrecall'])
  // "" disables every built-in tool; MCP tools are unaffected by --tools.
  expect(valueAfter(argv, '--tools')).toBe('')
  expect(valueAfter(argv, '--allowedTools')).toBe(ALLOWED_TOOLS)
  expect(valueAfter(argv, '--permission-mode')).toBe('dontAsk')
  expect(argv).toContain('--disable-slash-commands')
}

describe('extract wrapper: effort and permissions of the extraction run', () => {
  let daemon: ChildProcess
  let daemonHome: string
  let port: number
  let home: string
  let stubBin: string
  let stubOut: string

  beforeAll(async () => {
    daemonHome = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-run-config-daemon-'))
    const daemonEnv: NodeJS.ProcessEnv = { ...process.env, HOME: daemonHome }
    delete daemonEnv.NODE_OPTIONS
    delete daemonEnv.BASH_ENV
    delete daemonEnv.ENV
    for (const k of Object.keys(daemonEnv)) if (k.startsWith('BASH_FUNC_')) delete daemonEnv[k]
    daemon = spawn(process.execPath, ['-e', STUB_DAEMON], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: daemonEnv,
    })
    port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('stub daemon did not report a port')), 10_000)
      daemon.stdout!.once('data', (b: Buffer) => {
        clearTimeout(t)
        resolve(Number(b.toString().trim()))
      })
      daemon.once('error', reject)
    })
  })

  afterAll(async () => {
    daemon.kill()
    await new Promise<void>((resolve) => {
      if (daemon.exitCode !== null || daemon.signalCode !== null) return resolve()
      daemon.once('exit', () => resolve())
      setTimeout(resolve, 5_000).unref?.()
    })
    await rm(daemonHome, { recursive: true, force: true })
  })

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-run-config-'))
    stubBin = path.join(home, 'bin')
    stubOut = path.join(home, 'stub-out')
    await mkdir(stubBin)
    await mkdir(stubOut)

    const stub = path.join(stubBin, 'claude')
    await writeFile(stub, STUB_CLAUDE, 'utf8')
    await chmod(stub, 0o755)

    const projectDir = path.join(home, '.claude', 'projects', PROJECT_ID)
    await mkdir(projectDir, { recursive: true })
    await writeFile(path.join(projectDir, `${SESSION_ID}.jsonl`), fixtureTranscript(), 'utf8')
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  /**
   * CLAUDE_CODE_EFFORT_LEVEL is deleted, not inherited. This suite is usually
   * run from inside a Claude Code session, whose Bash tool passes its own value
   * down — exactly the leak under test — so inheriting it would let the
   * developer's session decide these assertions. CCRECALL_EXTRACT_EFFORT goes
   * for the same reason: a developer who sets it for their own extractions
   * would otherwise move every default these tests pin. Tests that need either
   * set do so in the caller shell.
   */
  function isolatedEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      ZDOTDIR: home,
      PATH: `${stubBin}:${process.env.PATH}`,
      CCRECALL_PORT: String(port),
      CCRECALL_EXTRACT_LOG: path.join(home, 'extract.log.jsonl'),
      STUB_CLAUDE_OUT: stubOut,
    }
    delete env.CLAUDE_CODE_EFFORT_LEVEL
    delete env.CCRECALL_EXTRACT_EFFORT
    delete env.ANTHROPIC_API_KEY
    delete env.BASH_ENV
    delete env.ENV
    delete env.NODE_OPTIONS
    for (const k of Object.keys(env)) if (k.startsWith('BASH_FUNC_')) delete env[k]
    return env
  }

  /**
   * Source the shipped wrapper into `shell` and run it after `prelude`, the
   * caller's own setup. The CALLER line is what that shell holds afterwards:
   * its CLAUDE_CODE_EFFORT_LEVEL, then its CCRECALL_EXTRACT_EFFORT.
   * zsh gets `-f` so no startup file runs; the timeout is required because
   * spawnSync blocks Vitest's own timers while it waits.
   */
  function runExtract(shell: string, prelude = '') {
    const flags = shell === 'zsh' ? ['-f', '-c'] : ['-c']
    const script = [
      prelude,
      `source "${WRAPPER}" && ccrecall-extract`,
      `printf 'CALLER\\t%s\\t%s\\n' "\${CLAUDE_CODE_EFFORT_LEVEL-${UNSET}}" "\${CCRECALL_EXTRACT_EFFORT-${UNSET}}"`,
    ].join('\n')
    return spawnSync(shell, [...flags, script], {
      encoding: 'utf8',
      env: isolatedEnv(),
      cwd: home,
      input: '',
      timeout: 60_000,
    })
  }

  /** Every invocation of one phase, as the effort it saw. Never empty. */
  async function effortSeen(phase: 'interactive' | 'extract'): Promise<string[]> {
    const raw = await readFile(path.join(stubOut, `${phase}.effort`), 'utf8').catch(() => '')
    const rows = raw.split('\n').filter((l) => l !== '')
    // An empty list would make every per-invocation assertion below vacuous.
    expect(rows.length, `the stub never ran in the ${phase} phase`).toBeGreaterThan(0)
    return rows
  }

  /** The argv of the last invocation of one phase. The file ends in a NUL. */
  async function argvSeen(phase: 'interactive' | 'extract'): Promise<string[]> {
    const raw = await readFile(path.join(stubOut, `${phase}.argv.nul`), 'utf8')
    return raw.split('\0').slice(0, -1)
  }

  /** What the caller shell holds after the wrapper returns. */
  function callerAfter(stdout: string): { effort: string; extractEffort: string } {
    const line = stdout.split('\n').find((l) => l.startsWith('CALLER\t'))
    expect(line, `no CALLER line in:\n${stdout}`).toBeDefined()
    const [, effort, extractEffort] = line!.split('\t')
    return { effort, extractEffort }
  }

  /** The levels a not-a-level warning offers, read back off the warning itself. */
  function levelsOffered(stderr: string): string[] {
    const line = stderr.split('\n').find((l) => l.includes(NOT_A_LEVEL))
    expect(line, `no not-a-level warning in:\n${stderr}`).toBeDefined()
    const list = line!.slice(line!.indexOf(NOT_A_LEVEL) + NOT_A_LEVEL.length).split(' — ')[0]
    return list.split(', ')
  }

  describe.each(SHELLS)('sourced into %s', (shell) => {
    it('harness: both phases reach the stub', async () => {
      const r = runExtract(shell)
      expect(r.stdout, r.stderr).toContain('extracting memories from session')
      expect(await effortSeen('interactive')).toHaveLength(1)
      await effortSeen('extract')
    })

    it('runs extraction at high effort when the caller exported max', async () => {
      runExtract(shell, 'export CLAUDE_CODE_EFFORT_LEVEL=max')
      for (const effort of await effortSeen('extract')) expect(effort).toBe('high')
    })

    it('runs extraction at high effort when the caller set no effort at all', async () => {
      const r = runExtract(shell)
      for (const effort of await effortSeen('extract')) expect(effort).toBe('high')
      expect(r.stdout).toContain('extracting memories from session (effort high)')
      expect(r.stderr).not.toContain(NOT_A_LEVEL)
    })

    it("leaves the interactive session and the caller shell at the caller's effort", async () => {
      const r = runExtract(shell, 'export CLAUDE_CODE_EFFORT_LEVEL=max')
      expect(await effortSeen('interactive')).toEqual(['max'])
      expect(callerAfter(r.stdout).effort).toBe('max')
    })

    it('runs extraction at the level CCRECALL_EXTRACT_EFFORT names, over the caller exporting max', async () => {
      // Without its own variable the only way to move the extraction effort
      // was editing the wrapper. CLAUDE_CODE_EFFORT_LEVEL cannot be the knob:
      // it is the caller's interactive setting, the very value the pin exists
      // to override.
      const r = runExtract(
        shell,
        'export CLAUDE_CODE_EFFORT_LEVEL=max\nexport CCRECALL_EXTRACT_EFFORT=medium',
      )
      for (const effort of await effortSeen('extract')) expect(effort).toBe('medium')
      expect(r.stdout).toContain('extracting memories from session (effort medium)')
      expect(await effortSeen('interactive')).toEqual(['max'])
      expect(callerAfter(r.stdout)).toEqual({ effort: 'max', extractEffort: 'medium' })
    })

    it('falls back to high, and says so, when CCRECALL_EXTRACT_EFFORT is not a level', async () => {
      // Passed on unchecked, a typo would reach Claude Code as its own effort
      // setting, and the start message would name a level the run never got.
      const r = runExtract(shell, 'export CCRECALL_EXTRACT_EFFORT=hgih')
      for (const effort of await effortSeen('extract')) expect(effort).toBe('high')
      expect(r.stdout).toContain('extracting memories from session (effort high)')
      expect(levelsOffered(r.stderr)).toEqual(LEVELS)
      // The value itself is not echoed: it goes to a terminal, and nothing
      // has vetted what a variable from the environment holds.
      expect(r.stderr).not.toContain('hgih')
    })

    it('reaches extraction under a caller with errexit and a value that is not a level', async () => {
      // This file is sourced into the user's shell and runs under its options.
      // Under errexit, a helper that reported the bad value through a non-zero
      // status would abort the shell at the assignment, before extraction.
      runExtract(shell, 'set -o errexit\nexport CCRECALL_EXTRACT_EFFORT=hgih')
      for (const effort of await effortSeen('extract')) expect(effort).toBe('high')
    })

    it('reaches extraction under a caller with nounset and CCRECALL_EXTRACT_EFFORT unset', async () => {
      // The ordinary install sets no CCRECALL_EXTRACT_EFFORT at all, and under
      // nounset a bare $CCRECALL_EXTRACT_EFFORT aborts the substitution that
      // reads it: claude then gets an empty effort, not high.
      const r = runExtract(shell, 'set -o nounset')
      for (const effort of await effortSeen('extract')) expect(effort).toBe('high')
      expect(r.stderr).not.toMatch(/unbound variable|parameter not set/)
    })

    it("starts extraction with only ccRecall's MCP server and the two tools it uses", async () => {
      runExtract(shell)
      expectLeastPrivilege(await argvSeen('extract'))
    })

    it('opens the interactive session with the permissions it always had', async () => {
      runExtract(shell)
      expect(await argvSeen('interactive')).toContain('--dangerously-skip-permissions')
    })
  })

  it.each(LEVELS)('passes CCRECALL_EXTRACT_EFFORT=%s through to the run', async (level) => {
    // Every level the warning offers must be one the check accepts. bash only:
    // the check is a literal `case`, which reads the same in zsh, while the
    // shell-dependent parts — prefix assignment, errexit, nounset — are
    // covered under both shells above.
    const r = runExtract('bash', `export CCRECALL_EXTRACT_EFFORT=${level}`)
    for (const effort of await effortSeen('extract')) expect(effort).toBe(level)
    expect(r.stdout).toContain(`extracting memories from session (effort ${level})`)
    expect(r.stderr).not.toContain(NOT_A_LEVEL)
  })

  it('does not take auto, which Claude Code runs at high rather than the model default', async () => {
    // Claude Code documents `auto` for CLAUDE_CODE_EFFORT_LEVEL as "use the
    // model default". Read off the Stop hook's effort.level on 2.1.300, it ran
    // Sonnet 5.5 at high three times out of three, with user settings, without
    // them, and with settings saying low, while an unset variable ran at the
    // model default, medium. Passed through, the start message would say
    // "auto" for a run at high. If a later Claude Code makes `auto` mean what
    // it says, this is the test to revisit.
    const r = runExtract('bash', 'export CCRECALL_EXTRACT_EFFORT=auto')
    for (const effort of await effortSeen('extract')) expect(effort).toBe('high')
    expect(r.stderr).toContain(NOT_A_LEVEL)
  })

  it('names, in both copies of the prompt, the exact tools the run allows', async () => {
    // Without ToolSearch the model reads tool names off the prompt, and a bare
    // `recall_save` was called by that name — "No such tool available" — in one
    // of four least-privilege runs on 2026-10-15, burning a turn. The names the
    // prompt teaches must be the ones the allowlist lets through.
    runExtract('bash')
    const allowed = valueAfter(await argvSeen('extract'), '--allowedTools').split(',')
    const save = allowed.find((t) => t.endsWith('__recall_save'))
    expect(save, `no recall_save in the allowlist: ${allowed.join(',')}`).toBeDefined()
    const promptFile = await readFile(PROMPT_FILE, 'utf8')
    const src = await readFile(WRAPPER, 'utf8')
    const m = src.match(/^\s*prompt="(You are a memory extraction agent[\s\S]*?)"\s*$/m)
    expect(m, 'inline fallback prompt not found in post-session-extract.sh').not.toBeNull()
    for (const copy of [promptFile, m![1]]) {
      expect(copy).toContain(save!)
    }
  })

  describe('which MCP server the run is pointed at', () => {
    /**
     * A throwaway package laid out like the real one — scripts/ next to dist/ —
     * holding a copy of the wrapper, so the server the copy resolves can be
     * checked with and without a build. The directory name has a space in it
     * because a real install path can (macOS "Application Support").
     */
    async function packageCopy(withBuild: boolean): Promise<string> {
      const root = path.join(home, 'pkg with space')
      await mkdir(path.join(root, 'scripts'), { recursive: true })
      await copyFile(WRAPPER, path.join(root, 'scripts', 'post-session-extract.sh'))
      if (withBuild) {
        await mkdir(path.join(root, 'dist', 'mcp'), { recursive: true })
        await writeFile(path.join(root, 'dist', 'mcp', 'server.js'), '// stub\n', 'utf8')
      }
      return root
    }

    function mcpConfigFrom(shell: string, root: string) {
      const flags = shell === 'zsh' ? ['-f', '-c'] : ['-c']
      const r = spawnSync(
        shell,
        [...flags, `source "${path.join(root, 'scripts', 'post-session-extract.sh')}" && _ccrecall_extract_mcp_config`],
        { encoding: 'utf8', env: isolatedEnv(), cwd: home, input: '', timeout: 30_000 },
      )
      expect(r.status, r.stderr).toBe(0)
      return JSON.parse(r.stdout).mcpServers.ccrecall
    }

    it.each(SHELLS)("runs the package's own build when there is one (%s)", async (shell) => {
      // A checkout registered with `claude mcp add ... -- <path>/dist/mcp/server.js`
      // has no ccmem-mcp on PATH, so naming the bin would break its extraction.
      const root = await packageCopy(true)
      const server = mcpConfigFrom(shell, root)
      expect(server.command).toBe('node')
      expect(server.args).toEqual([path.join(root, 'dist', 'mcp', 'server.js')])
    })

    it.each(SHELLS)('falls back to the ccmem-mcp bin when the package has no build (%s)', async (shell) => {
      const root = await packageCopy(false)
      const server = mcpConfigFrom(shell, root)
      expect(server.command).toBe('ccmem-mcp')
    })
  })
})
