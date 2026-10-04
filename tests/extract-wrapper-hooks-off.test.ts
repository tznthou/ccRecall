// SPDX-License-Identifier: Apache-2.0
//
// Guards which of ccRecall's own memory hooks fire during extraction.
//
// Background: the extraction step is itself a Claude Code session — a headless
// `claude -p` — and Claude Code runs the user's global hooks for it as for any
// other session. Until this was switched off, the SessionStart and
// UserPromptSubmit hooks injected memories into the extraction model on every
// run. Measured 2026-10-04 against the injection log: 100 of 111 extraction
// runs drew a startup injection within seconds of starting, and in the week to
// that date extraction runs received 134 of 294 SessionStart injections and 50
// of 204 prompt injections — memories that no person read.
//
// Each of those injections is also a write. It bumps access_count and stamps
// the injection log, and startup selection reads both: the tier that gives a
// never-surfaced memory its priority slot drops a memory once it has been
// surfaced anywhere. Of 297 memories created 2026-09-14..27, 38% were first
// surfaced in an extraction run, and only 24% of those reached an interactive
// session within a week of being written.
//
// The hooks read their off switches from the environment, so the fix is two
// assignments on the extraction command. These tests assert on what the stub
// `claude` actually received in each phase: the extraction run sees both
// switches off; the interactive session before it does not; and nothing leaks
// into the caller's shell. That last one matters because this file is SOURCED
// into the user's shell — an exported `off` would silently disable
// mid-session recall in every later session started from that terminal.
//
// Every subprocess runs under `isolatedEnv`, which points HOME, PATH, the
// telemetry log and the daemon port into a temp dir, so nothing here reads or
// writes the real ~/.claude, ~/.ccrecall or :7749.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const WRAPPER = path.join(__dirname, '..', 'scripts', 'post-session-extract.sh')

const SESSION_ID = '11111111-2222-3333-4444-777777777777'
const PROJECT_ID = '-tmp-ccrecall-hooks-off-fixture'
/** How the stub records a variable that is not set at all. */
const UNSET = '<unset>'

const HAS_ZSH = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).status === 0
/**
 * The shells this wrapper actually gets sourced into. zsh is the one users
 * run; bash is what the file is written against. Prefix assignments and
 * `export` are exactly where the two could differ, so both run.
 */
const SHELLS = ['bash', ...(HAS_ZSH ? ['zsh'] : [])]

/**
 * Stub `claude`, first on PATH for both wrapper phases.
 *
 * Each invocation appends one line — the two switches as this process saw
 * them — to a file named for its phase. `${VAR-x}` without the colon, because
 * unset and empty are different answers and only the exact string "off" turns
 * a hook off.
 */
const STUB_CLAUDE = `#!/bin/bash
case " $* " in
  *" -p "*) phase=extract ;;
  *) phase=interactive ;;
esac
printf '%s\\t%s\\n' "\${CCRECALL_SESSION_START_STRATEGY-${UNSET}}" "\${CCRECALL_PROMPT_RECALL-${UNSET}}" \\
  >> "\${STUB_CLAUDE_OUT}/\${phase}.env"
# Drain the prompt the wrapper pipes in, so its printf never meets a closed pipe.
if [ "$phase" = extract ]; then cat > /dev/null; fi
exit 0
`

/**
 * Stub ccRecall daemon, run as its OWN process: `spawnSync` blocks this
 * thread for as long as the wrapper runs, so a server sharing this event loop
 * would never answer the wrapper's `curl`.
 */
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

describe('extract wrapper: memory hooks during extraction', () => {
  let daemon: ChildProcess
  let daemonHome: string
  let port: number
  let home: string
  let stubBin: string
  let stubOut: string

  beforeAll(async () => {
    daemonHome = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-hooks-off-daemon-'))
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
    home = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-hooks-off-'))
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
   * The one environment every run here gets. The two switches are deleted,
   * not inherited: a developer who exported either one would otherwise decide
   * these tests' outcome. Tests that need them set do so in the caller shell.
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
    delete env.CCRECALL_SESSION_START_STRATEGY
    delete env.CCRECALL_PROMPT_RECALL
    delete env.ANTHROPIC_API_KEY
    delete env.BASH_ENV
    delete env.ENV
    delete env.NODE_OPTIONS
    for (const k of Object.keys(env)) if (k.startsWith('BASH_FUNC_')) delete env[k]
    return env
  }

  /**
   * Source the shipped wrapper into `shell` and run it. `prelude` runs first,
   * as the caller's own setup; the CALLER line printed afterwards is what that
   * caller's shell holds once the wrapper has returned.
   *
   * zsh gets `-f` so no startup file runs; the timeout is required because
   * spawnSync blocks Vitest's own timers while it waits.
   */
  function runExtract(shell: string, prelude = '') {
    const flags = shell === 'zsh' ? ['-f', '-c'] : ['-c']
    const script = [
      prelude,
      `source "${WRAPPER}" && ccrecall-extract`,
      `printf 'CALLER\\t%s\\t%s\\n' "\${CCRECALL_SESSION_START_STRATEGY-${UNSET}}" "\${CCRECALL_PROMPT_RECALL-${UNSET}}"`,
    ].join('\n')
    return spawnSync(shell, [...flags, script], {
      encoding: 'utf8',
      env: isolatedEnv(),
      cwd: home,
      input: '',
      timeout: 60_000,
    })
  }

  /** Every invocation of one phase, as [strategy, promptRecall]. Never empty. */
  async function seen(phase: 'interactive' | 'extract'): Promise<string[][]> {
    const raw = await readFile(path.join(stubOut, `${phase}.env`), 'utf8').catch(() => '')
    const rows = raw.split('\n').filter((l) => l !== '').map((l) => l.split('\t'))
    // An empty list would make every per-invocation assertion below vacuous.
    expect(rows.length, `the stub never ran in the ${phase} phase`).toBeGreaterThan(0)
    return rows
  }

  function callerAfter(stdout: string): string[] {
    const line = stdout.split('\n').find((l) => l.startsWith('CALLER\t'))
    expect(line, `no CALLER line in:\n${stdout}`).toBeDefined()
    return line!.split('\t').slice(1)
  }

  describe.each(SHELLS)('sourced into %s', (shell) => {
    it('harness: both phases reach the stub', async () => {
      // Every assertion below reads what the stub recorded. If the wrapper
      // stopped short of phase 2, green would mean nothing.
      const r = runExtract(shell)
      expect(r.stdout, r.stderr).toContain('extracting memories from session')
      expect(await seen('interactive')).toHaveLength(1)
      await seen('extract')
    })

    it('runs extraction with both memory hooks switched off', async () => {
      runExtract(shell)
      for (const [strategy, promptRecall] of await seen('extract')) {
        expect(strategy).toBe('off')
        expect(promptRecall).toBe('off')
      }
    })

    it('leaves the interactive session and the caller shell as they were', async () => {
      // The interactive session keeps the wrapper's own startup-v1 and inherits
      // the caller's (here unset) prompt switch. Nothing is left behind once the
      // wrapper returns.
      const r = runExtract(shell)
      expect(await seen('interactive')).toEqual([['startup-v1', UNSET]])
      expect(callerAfter(r.stdout)).toEqual([UNSET, UNSET])
    })

    it('overrides switches the caller exported, without changing them in the caller shell', async () => {
      const r = runExtract(
        shell,
        'export CCRECALL_SESSION_START_STRATEGY=legacy\nexport CCRECALL_PROMPT_RECALL=on',
      )
      for (const [strategy, promptRecall] of await seen('extract')) {
        expect(strategy).toBe('off')
        expect(promptRecall).toBe('off')
      }
      expect(await seen('interactive')).toEqual([['startup-v1', 'on']])
      expect(callerAfter(r.stdout)).toEqual(['legacy', 'on'])
    })
  })
})
