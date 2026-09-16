// SPDX-License-Identifier: Apache-2.0
//
// Guards scripts/backfill-extract.sh — the recovery path for sessions the argv
// ceiling already cost us (#120).
//
// The script re-runs extraction against transcripts Claude Code still holds on
// disk. That makes it a one-shot tool nobody watches closely, run once against
// real sessions and then forgotten, which is the worst possible place for a
// silent failure: the sessions it is meant to recover are gone from the
// telemetry log's perspective either way, whether it extracted them or died
// before `claude` ever started.
//
// All three tests here cover defects found by review BEFORE this script was
// first merged, each reproduced and then fixed:
//
//   1. `"${budget_args[@]}"` on an EMPTY array is an unbound-variable error
//      under `set -u` in bash 3.2 — which is what /bin/bash still is on macOS.
//      With no ANTHROPIC_API_KEY (the common case — most users are on a
//      subscription) the script aborted before claude ran. A `#!/usr/bin/env
//      bash` that resolves to a Homebrew bash 5 hides this completely, which is
//      how it passed a real run by hand.
//   2. The database path came from $CCRECALL_DB, while six other places in this
//      codebase read $CCRECALL_DB_PATH. Anyone who points that variable
//      elsewhere silently got the default, and a missing file reads as "0
//      existing memories" — so the script would re-extract over a session it
//      had already done, and miscount what it wrote.
//   3. `jq -r 'select(.cwd)'` without `-R`/`fromjson?` aborts at the first
//      unparseable line, hiding every cwd after it. The script then falls back
//      to $PWD and extracts the session against the wrong directory, reporting
//      nothing amiss.
//
// Each test runs the real script end to end against a stub `claude` and a temp
// HOME, and asserts on observable effects — what the stub received, which
// directory it ran in, whether it ran at all — rather than on the script's
// source text. A static assertion that the source "contains the right idiom"
// would have passed against defect 1 the moment the idiom was typed, without
// ever proving bash accepts it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backfill-extract.sh')

const SESSION_ID = '11111111-2222-3333-4444-666666666666'
const PROJECT_ID = '-tmp-ccrecall-backfill-fixture'

/**
 * The bash the script's shebang would pick, and the one that matters here.
 *
 * `/bin/bash` is 3.2.57 on macOS and 5.x on Linux, so the empty-array test below
 * only exercises the real defect on the macOS CI leg. That is stated rather than
 * hidden: on bash 4+ the assertion is vacuously true, and a test that cannot
 * fail is worth knowing about.
 */
const STOCK_BASH = '/bin/bash'

function bashMajor(binary: string): number {
  const r = spawnSync(binary, ['-c', 'echo "${BASH_VERSINFO[0]}"'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  return Number((r.stdout || '').trim()) || 0
}

/**
 * Stub `claude`, first on PATH.
 *
 * Records the three things the tests assert on: that it ran at all (defect 1),
 * the directory it ran in (defect 3), and its argv (so a budget flag added by a
 * leaked ANTHROPIC_API_KEY would be visible rather than silently changing the
 * shape under test). It then writes a memory row itself, because the script
 * counts writes by querying the database before and after — a stub that wrote
 * nothing would make every run report "exited cleanly but wrote 0 memories".
 */
const STUB_CLAUDE = `#!/bin/sh
printf 'ran\\n' > "\${STUB_OUT}/ran.txt"
pwd > "\${STUB_OUT}/pwd.txt"
printf '%s\\0' "$@" > "\${STUB_OUT}/argv.nul"
cat > "\${STUB_OUT}/stdin.txt"
if [ -n "\${STUB_DB:-}" ]; then
  sqlite3 "\${STUB_DB}" \\
    "INSERT INTO memories (session_id, content, origin) VALUES ('\${STUB_SESSION_ID}', 'stub memory', 'agent-inferred');"
fi
exit 0
`

/** Minimal shape of what the script queries: COUNT(*) ... WHERE session_id = ?. */
const DB_SCHEMA = `
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  content TEXT,
  origin TEXT
);
`

describe('backfill-extract.sh', () => {
  let home: string
  let stubBin: string
  let stubOut: string
  let dbPath: string
  let logPath: string
  let projectDir: string
  let runFrom: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-backfill-'))
    stubBin = path.join(home, 'bin')
    stubOut = path.join(home, 'stub-out')
    dbPath = path.join(home, 'test.db')
    logPath = path.join(home, 'extract.log.jsonl')
    projectDir = path.join(home, '.claude', 'projects', PROJECT_ID)
    // A directory that is NOT the cwd the script is invoked from, so "read the
    // cwd off the transcript" and "fell back to $PWD" cannot look the same.
    runFrom = path.join(home, 'run-from')

    await mkdir(stubBin)
    await mkdir(stubOut)
    await mkdir(runFrom)
    await mkdir(projectDir, { recursive: true })

    const stub = path.join(stubBin, 'claude')
    await writeFile(stub, STUB_CLAUDE, 'utf8')
    await chmod(stub, 0o755)

    const r = spawnSync('sqlite3', [dbPath, DB_SCHEMA], { encoding: 'utf8', timeout: 30_000 })
    expect(r.status, `sqlite3 failed to create the fixture db: ${r.stderr}`).toBe(0)
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  /**
   * The one environment every subprocess here runs under.
   *
   * ANTHROPIC_API_KEY is deleted rather than merely unset in the parent: with it
   * present the script fills budget_args, and the empty-array defect — the whole
   * point of the first test — cannot occur. The BASH_ENV/ENV/BASH_FUNC_ removals
   * follow the same rule the wrapper's tests use: the running user's startup
   * files and exported shell functions must not reach a spawned shell.
   */
  function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PATH: `${stubBin}:${process.env.PATH}`,
      CCRECALL_EXTRACT_LOG: logPath,
      CCRECALL_DB_PATH: dbPath,
      STUB_OUT: stubOut,
      STUB_DB: dbPath,
      STUB_SESSION_ID: SESSION_ID,
      ...extra,
    }
    delete env.ANTHROPIC_API_KEY
    delete env.BASH_ENV
    delete env.ENV
    delete env.NODE_OPTIONS
    delete env.CCRECALL_DB
    for (const k of Object.keys(env)) if (k.startsWith('BASH_FUNC_')) delete env[k]
    return env
  }

  function runScript(args: string[], env: NodeJS.ProcessEnv, bash = STOCK_BASH) {
    return spawnSync(bash, [SCRIPT, ...args], {
      encoding: 'utf8',
      cwd: runFrom,
      env,
      timeout: 120_000,
      input: '',
    })
  }

  async function writeTranscript(lines: string[]) {
    await writeFile(path.join(projectDir, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n', 'utf8')
  }

  function msg(text: string, cwd?: string): string {
    const o: Record<string, unknown> = {
      type: 'user',
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
      message: { content: [{ type: 'text', text }] },
    }
    if (cwd) o.cwd = cwd
    return JSON.stringify(o)
  }

  it('reaches claude under the stock /bin/bash with no ANTHROPIC_API_KEY', async () => {
    // Defect 1. Under bash 3.2 + `set -u`, expanding an EMPTY array as
    // "${a[@]}" is an unbound-variable error, so the script died at the claude
    // invocation itself — before the subprocess, with the loop's own error
    // handling never reached. What has to hold is simply that claude ran.
    const major = bashMajor(STOCK_BASH)
    await writeTranscript([msg('hello from the fixture session', runFrom)])

    const r = runScript([SESSION_ID], isolatedEnv())

    await expect(
      access(path.join(stubOut, 'ran.txt')),
      `claude never ran under ${STOCK_BASH} (bash ${major}). stdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    ).resolves.toBeUndefined()
    expect(r.stderr).not.toMatch(/unbound variable/)
    expect(r.status).toBe(0)

    // The budget flag must be absent, not merely harmless: its presence would
    // mean an API key leaked into the environment and this test never exercised
    // the empty-array path at all.
    const argv = (await readFile(path.join(stubOut, 'argv.nul'), 'utf8')).split('\0')
    expect(argv).not.toContain('--max-budget-usd')

    if (major >= 4) {
      // Not a failure — a statement of what this run did and did not prove, so
      // a green tick on a Linux runner is not mistaken for coverage of 3.2.
      console.warn(
        `[backfill-extract] ${STOCK_BASH} is bash ${major}; the empty-array defect ` +
          'only manifests on bash 3.2 (macOS). This assertion was vacuous on this runner.',
      )
    }
  })

  it('reads the database path from CCRECALL_DB_PATH, like the rest of the codebase', async () => {
    // Defect 2. Seed one memory for this session: with the path read correctly
    // the script sees it and skips. Reading $CCRECALL_DB instead means the
    // default path under the temp HOME, which does not exist — existing reads
    // as 0 and the script re-extracts over a session already done.
    const seed = spawnSync(
      'sqlite3',
      [dbPath, `INSERT INTO memories (session_id, content, origin) VALUES ('${SESSION_ID}', 'pre-existing', 'explicit');`],
      { encoding: 'utf8', timeout: 30_000 },
    )
    expect(seed.status, seed.stderr).toBe(0)

    await writeTranscript([msg('a session that was already extracted', runFrom)])

    const r = runScript([SESSION_ID], isolatedEnv())

    expect(r.stdout).toMatch(/already has 1 memories/)
    await expect(access(path.join(stubOut, 'ran.txt'))).rejects.toThrow()
  })

  it('still finds the session cwd when an earlier transcript line is unparseable', async () => {
    // Defect 3. The only line carrying a cwd sits AFTER an unparseable one. A
    // non-tolerant jq aborts at the bad line and never reaches it, leaving the
    // script to fall back to $PWD — so asserting on the directory claude ran in
    // separates the two outcomes. Claude Code's own parser is tolerant by
    // project rule; a transcript with a truncated final write is the ordinary
    // way this shows up.
    const sessionCwd = path.join(home, 'the-real-session-cwd')
    await mkdir(sessionCwd)
    await writeTranscript([
      msg('first message, no cwd on this line'),
      'THIS LINE IS NOT JSON',
      msg('second message', sessionCwd),
    ])

    const r = runScript([SESSION_ID], isolatedEnv())
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0)

    const ranIn = (await readFile(path.join(stubOut, 'pwd.txt'), 'utf8')).trim()
    // realpath both sides: macOS /tmp is a symlink to /private/tmp, so `pwd` in
    // the stub reports the resolved path while the fixture holds the symlinked
    // one. Comparing the raw strings fails for a reason that has nothing to do
    // with what is being tested.
    const resolved = spawnSync(STOCK_BASH, ['-c', `cd "${sessionCwd}" && pwd`], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(ranIn).toBe(resolved.stdout.trim())
    expect(ranIn).not.toBe(runFrom)
  })
})
