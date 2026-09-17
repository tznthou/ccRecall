// SPDX-License-Identifier: Apache-2.0
//
// Guards the wrapper's zero-write detection and its single retry (#75 follow-up).
//
// Background: the text-shape marker added in #78 only catches ONE failure
// shape — the model printing `recall_save(...)` instead of invoking it. The
// other shape, where it quietly does nothing at all, is byte-identical in
// telemetry to a session that genuinely had nothing worth saving. Measured
// 2026-09-18 against 257 clean runs: 7 runs carried a 52–200KB transcript and
// wrote nothing, and the marker caught none of them — roughly 1 in 8 coverage.
//
// Two functions close that gap and both are tested here rather than
// reimplemented: the wrapper is sourced and its shipped functions are called,
// matching wrapper-secure-log.test.ts.
//
// The database query is the risky half. ccRecall is a read-only application
// and this is the first time the wrapper opens the database at all, so the
// test that matters most is the one asserting it cannot write.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const WRAPPER = path.join(__dirname, '..', 'scripts', 'post-session-extract.sh')
const HAS_SQLITE = spawnSync('sh', ['-c', 'command -v sqlite3'], { encoding: 'utf8' }).status === 0

const SID = '170347d4-b2ba-4659-849a-7e9d14acc301'
const OTHER_SID = '99999999-1111-2222-3333-444444444444'

function cleanEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    ZDOTDIR: home,
    CCRECALL_EXTRACT_LOG: path.join(home, 'extract.log.jsonl'),
    ...extra,
  }
  delete env.BASH_ENV
  delete env.ENV
  return env
}

interface ShellResult {
  code: number
  stdout: string
  stderr: string
}

const HAS_ZSH = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).status === 0

/**
 * Run one of the wrapper's shipped functions in a real shell.
 *
 * zsh is not optional coverage here. This file is sourced from the user's
 * interactive shell, which is zsh, and the two shells disagree on the test
 * that guards "unknown write count": `[ "" -eq 0 ]` fails in bash (rc 2) but
 * SUCCEEDS in zsh, which reads an empty string as 0. A bash-only suite lets a
 * mutant that deletes the emptiness check survive — and in zsh that deletion
 * turns every undeterminable count into a retry. Found by mutation, 2026-09-18.
 */
function runShell(
  body: string,
  home: string,
  extra: NodeJS.ProcessEnv = {},
  shell = 'bash',
): ShellResult {
  const flags = shell === 'zsh' ? ['-f', '-c'] : ['-c']
  const r = spawnSync(shell, [...flags, `. "$1"\n${body}`, 'ccrecall-test', WRAPPER], {
    encoding: 'utf8',
    env: cleanEnv(home, extra),
    timeout: 20_000,
  })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** The shells this wrapper actually gets sourced into. */
const SHELLS = ['bash', ...(HAS_ZSH ? ['zsh'] : [])]

/** Build a throwaway database with the columns the wrapper's query touches. */
function makeDb(file: string, rows: Array<[string, string]>): void {
  const inserts = rows
    .map(([sid, origin]) => `INSERT INTO memories (session_id, content, type, origin) VALUES ('${sid}', 'x', 'pattern', '${origin}');`)
    .join('\n')
  const sql = `
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT, content TEXT NOT NULL, type TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'explicit'
    );
    ${inserts}
  `
  const r = spawnSync('sqlite3', [file], { input: sql, encoding: 'utf8', timeout: 10_000 })
  if (r.status !== 0) throw new Error(`fixture db failed: ${r.stderr}`)
}

describe.skipIf(!HAS_SQLITE)('extract wrapper: zero-write detection', () => {
  let home: string
  let db: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-retry-'))
    db = path.join(home, 'test.db')
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('counts only the memories this extraction produced', () => {
    // Two agent-inferred rows for our session, plus rows that must NOT count:
    // an explicit row (the user saved that by hand mid-session — counting it
    // is exactly the mistake that made a broken run look successful) and a
    // row belonging to another session.
    makeDb(db, [
      [SID, 'agent-inferred'],
      [SID, 'agent-inferred'],
      [SID, 'explicit'],
      [OTHER_SID, 'agent-inferred'],
    ])
    const r = runShell(`_ccrecall_count_extracted "${SID}"`, home, { CCRECALL_DB_PATH: db })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('2')
  })

  it('reports zero when the extraction wrote nothing', () => {
    makeDb(db, [[OTHER_SID, 'agent-inferred']])
    const r = runShell(`_ccrecall_count_extracted "${SID}"`, home, { CCRECALL_DB_PATH: db })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('0')
  })

  it('cannot write to the database', async () => {
    // ccRecall is read-only by contract and this is the wrapper's first
    // database access. A read-only handle is the guard; this asserts the
    // guard rather than the intent.
    makeDb(db, [[SID, 'agent-inferred']])
    const before = await readFile(db)
    const beforeStat = await stat(db)

    runShell(`_ccrecall_count_extracted "${SID}"`, home, { CCRECALL_DB_PATH: db })
    // And the direct attempt the function's own handle would have to permit:
    const attack = runShell(
      `_ccrecall_sqlite_ro "${db}" "CREATE TABLE evil (x);" ; echo "rc=$?"`,
      home,
      { CCRECALL_DB_PATH: db },
    )

    const after = await readFile(db)
    const afterStat = await stat(db)
    expect(after.equals(before)).toBe(true)
    expect(afterStat.size).toBe(beforeStat.size)
    expect(attack.stdout).not.toMatch(/rc=0/)
  })

  it('degrades to "unknown" rather than 0 when the database is missing', () => {
    // The distinction is load-bearing: "unknown" must not trigger a retry,
    // while a real 0 on a substantial transcript must.
    const r = runShell(`_ccrecall_count_extracted "${SID}"`, home, {
      CCRECALL_DB_PATH: path.join(home, 'nope.db'),
    })
    expect(r.code).not.toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  it('degrades to "unknown" when sqlite3 is not installed', () => {
    makeDb(db, [[SID, 'agent-inferred']])
    // Empty PATH for the lookup only; the function must not abort the shell.
    const r = runShell(
      `PATH=/nonexistent _ccrecall_count_extracted "${SID}"; echo "rc=$?"`,
      home,
      { CCRECALL_DB_PATH: db },
    )
    expect(r.stdout).toMatch(/rc=[1-9]/)
  })
})

describe.each(SHELLS)('extract wrapper: retry decision (%s)', (shell) => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-retry-d-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  /** exit 0 from the decision function means "retry". */
  function decide(
    exitCode: number,
    textCount: number,
    bytes: number,
    extracted: string,
    attempt: number,
  ): number {
    return runShell(
      `_ccrecall_should_retry ${exitCode} ${textCount} ${bytes} "${extracted}" ${attempt}`,
      home,
      {},
      shell,
    ).code
  }

  it('retries a clean exit that printed the call as text', () => {
    expect(decide(0, 4, 196_318, '0', 1)).toBe(0)
  })

  it('retries a substantial transcript that wrote nothing', () => {
    // The shape the marker never caught: 7 of these in 257 runs.
    expect(decide(0, 0, 67_235, '0', 1)).toBe(0)
  })

  it('does not retry a thin transcript that wrote nothing', () => {
    // "Save 0-5 insights" — 0 is a legal answer for a 500-byte transcript.
    // Retrying these would burn quota on sessions that had nothing to say.
    expect(decide(0, 0, 562, '0', 1)).not.toBe(0)
  })

  it('does not retry when the extraction wrote something', () => {
    expect(decide(0, 0, 196_318, '3', 1)).not.toBe(0)
  })

  it('does not retry when the write count is unknown', () => {
    // No sqlite3, or no database: silence is not evidence of failure.
    // zsh reads "" as 0 in an integer test, so this case is only guarded by
    // the explicit emptiness check — which is why it runs in both shells.
    expect(decide(0, 0, 196_318, '', 1)).not.toBe(0)
  })

  it('still retries an unknown write count if the text marker fired', () => {
    // The marker alone is sufficient — it does not depend on the database.
    expect(decide(0, 2, 196_318, '', 1)).toBe(0)
  })

  it('does not retry a non-zero exit', () => {
    // Those already carry their own diagnostics (argv limits, auth, budget)
    // and a retry would repeat a failure whose cause is not transient.
    expect(decide(2, 0, 196_318, '0', 1)).not.toBe(0)
  })

  it('never retries twice', () => {
    expect(decide(0, 4, 196_318, '0', 2)).not.toBe(0)
  })

  it('honours a configurable thin-transcript threshold', () => {
    const r = runShell(
      `CCRECALL_ZERO_WRITE_MIN_BYTES=100 _ccrecall_should_retry 0 0 562 "0" 1`,
      home,
      {},
      shell,
    )
    expect(r.code).toBe(0)
  })
})

describe('extract wrapper: structural guards', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-retry-s-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  /** Ask bash what it parsed, rather than scanning the file as text. */
  function definition(fn: string): string {
    const r = runShell(`declare -f ${fn}`, home)
    if (!r.stdout.trim()) throw new Error(`declare -f ${fn} returned nothing`)
    return r.stdout.replace(/\s+/g, ' ')
  }

  it('calls sqlite3 through `command`', async () => {
    // This file is sourced into an interactive shell, where a user alias or
    // function shadows a bare external command (#99). Same rule the rest of
    // the wrapper already follows.
    expect(definition('_ccrecall_sqlite_ro')).toMatch(/command sqlite3/)
  })

  it('opens the database read-only', () => {
    expect(definition('_ccrecall_sqlite_ro')).toMatch(/-readonly/)
  })

  it('ships both new functions', () => {
    const names = runShell('declare -F | sed "s/^declare -f //"', home).stdout
    expect(names).toMatch(/_ccrecall_count_extracted/)
    expect(names).toMatch(/_ccrecall_should_retry/)
  })
})
