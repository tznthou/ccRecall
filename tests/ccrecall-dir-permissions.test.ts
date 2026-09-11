// SPDX-License-Identifier: Apache-2.0
//
// #95: ~/.ccrecall holds the database — every memory and every session title —
// plus telemetry whose rows carry `cwd`, the account name and every project
// name worked on. Four call sites create that directory and only one of them
// passed a mode, so whichever ran first decided it. On the dogfood machine
// that was 0755; under `umask 002` the same lines yield 0775, a directory
// another local user can write into.
//
// The failure is silent by construction: a directory back at 0755 raises no
// error, serves every query identically, and appears nowhere in a diff. An
// assertion on the mode is the only thing that catches it, which is why these
// tests read st_mode rather than exercising behaviour.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod, stat } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { ensureCcrecallDir, secureCcrecallFile } from '../src/core/secure-dir.js'
import {
  ensureCcrecallDir as ensureCcrecallDirMjs,
  secureCcrecallFile as secureCcrecallFileMjs,
} from '../hooks/lib/secure-dir.mjs'
import { Database } from '../src/core/database.js'
import { IntegrityMonitor } from '../src/core/integrity-monitor.js'

const HOOK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../hooks/session-start.mjs',
)

async function mode(p: string): Promise<string> {
  return ((await stat(p)).mode & 0o777).toString(8)
}

let tmpHome: string
let realHome: string | undefined

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-perm-'))
  realHome = process.env.HOME
  // os.homedir() reads $HOME on POSIX, so this is what makes "is this our own
  // directory?" testable without touching the real ~/.ccrecall.
  process.env.HOME = tmpHome
})

afterEach(async () => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  await rm(tmpHome, { recursive: true, force: true })
})

describe('#95 ensureCcrecallDir', () => {
  it('creates the directory 0700', async () => {
    const dir = path.join(tmpHome, '.ccrecall')
    ensureCcrecallDir(dir)
    expect(await mode(dir)).toBe('700')
  })

  it('creates missing parents 0700 too', async () => {
    const dir = path.join(tmpHome, '.ccrecall', 'integrity-alerts')
    ensureCcrecallDir(dir)
    expect(await mode(path.join(tmpHome, '.ccrecall'))).toBe('700')
    expect(await mode(dir)).toBe('700')
  })

  // Counter-probe: without the mode argument the same call on the same machine
  // produces 0755. If this ever reports 700 the assertions above prove nothing,
  // because the platform would be handing out 0700 by default.
  it('counter-probe: a plain recursive mkdir here yields 0755', async () => {
    const dir = path.join(tmpHome, 'plain')
    mkdirSync(dir, { recursive: true })
    expect(await mode(dir)).toBe('755')
  })

  it('repairs an existing 0755 ~/.ccrecall', async () => {
    const dir = path.join(tmpHome, '.ccrecall')
    await mkdir(dir, { recursive: true })
    await chmod(dir, 0o755)
    ensureCcrecallDir(dir)
    expect(await mode(dir)).toBe('700')
  })

  it('repairs a subdirectory of ~/.ccrecall', async () => {
    const dir = path.join(tmpHome, '.ccrecall', 'integrity-alerts')
    await mkdir(dir, { recursive: true })
    await chmod(dir, 0o755)
    ensureCcrecallDir(dir)
    expect(await mode(dir)).toBe('700')
  })

  // PR #94 tried exactly this in the shell wrapper and was reverted twice: the
  // log path is user-configurable, so a relative setting makes the parent the
  // working directory, and a project directory went 0755 -> 0700 in testing.
  // A creator may pick the mode of a directory it makes; it may not re-mode a
  // directory that was already there and is not ours.
  it('leaves an existing directory outside ~/.ccrecall alone', async () => {
    const dir = path.join(tmpHome, 'someones-project')
    await mkdir(dir, { recursive: true })
    await chmod(dir, 0o755)
    ensureCcrecallDir(dir)
    expect(await mode(dir)).toBe('755')
  })

  it('still creates a new directory outside ~/.ccrecall as 0700', async () => {
    const dir = path.join(tmpHome, 'custom-log-dir')
    ensureCcrecallDir(dir)
    expect(await mode(dir)).toBe('700')
  })
})

describe('#95 secureCcrecallFile', () => {
  it('repairs an existing 0644 file without discarding its contents', async () => {
    const f = path.join(tmpHome, 'startup-recall.log.jsonl')
    await writeFile(f, '{"ts":"2026-01-01T00:00:00Z"}\n', 'utf8')
    await chmod(f, 0o644)
    secureCcrecallFile(f)
    expect(await mode(f)).toBe('600')
    expect(await readFile(f, 'utf8')).toBe('{"ts":"2026-01-01T00:00:00Z"}\n')
  })

  it('does not throw when the file is missing', () => {
    expect(() => secureCcrecallFile(path.join(tmpHome, 'nope.jsonl'))).not.toThrow()
  })
})

describe('#95 both implementations agree', () => {
  const cases: Array<[string, 'new' | 'existing-own' | 'existing-foreign']> = [
    ['a fresh directory', 'new'],
    ['an existing directory of ours', 'existing-own'],
    ['an existing directory that is not ours', 'existing-foreign'],
  ]

  for (const [name, kind] of cases) {
    it(`${name}: src and hooks/lib produce the same mode`, async () => {
      const target = (tag: string) =>
        kind === 'existing-foreign'
          ? path.join(tmpHome, `foreign-${tag}`)
          : path.join(tmpHome, '.ccrecall', `d-${tag}`)

      const a = target('ts')
      const b = target('mjs')
      if (kind !== 'new') {
        await mkdir(a, { recursive: true })
        await mkdir(b, { recursive: true })
        await chmod(a, 0o755)
        await chmod(b, 0o755)
      }
      ensureCcrecallDir(a)
      ensureCcrecallDirMjs(b)
      expect(await mode(b)).toBe(await mode(a))
    })
  }

  // Surfaced by mutation: dropping the mode from the hooks-side mkdir left
  // every test green, because for a path under ~/.ccrecall the repair chmod
  // corrects it anyway. Outside ~/.ccrecall there is no repair by design, so
  // the mkdir mode is the only thing holding the directory at 0700 — and that
  // was the one combination neither side covered.
  it('a fresh directory outside ~/.ccrecall: both sides still give 0700', async () => {
    const a = path.join(tmpHome, 'foreign-new-ts')
    const b = path.join(tmpHome, 'foreign-new-mjs')
    ensureCcrecallDir(a)
    ensureCcrecallDirMjs(b)
    expect(await mode(a)).toBe('700')
    expect(await mode(b)).toBe('700')
  })

  it('secureCcrecallFile: src and hooks/lib produce the same mode', async () => {
    const a = path.join(tmpHome, 'a.jsonl')
    const b = path.join(tmpHome, 'b.jsonl')
    await writeFile(a, 'x\n', 'utf8')
    await writeFile(b, 'x\n', 'utf8')
    await chmod(a, 0o644)
    await chmod(b, 0o644)
    secureCcrecallFile(a)
    secureCcrecallFileMjs(b)
    expect(await mode(b)).toBe(await mode(a))
    expect(await mode(a)).toBe('600')
  })
})

describe('#95 every creator of ~/.ccrecall', () => {
  it('Database: the directory it creates is 0700 and the db file is 0600', async () => {
    const dbPath = path.join(tmpHome, '.ccrecall', 'ccrecall.db')
    const db = new Database(dbPath)
    try {
      expect(await mode(path.dirname(dbPath))).toBe('700')
      expect(await mode(dbPath)).toBe('600')
      // SQLite derives the -wal/-shm mode from the main database file, so
      // securing the main file is what secures the sidecars that hold recently
      // written rows. Asserted rather than assumed — this is the half a reader
      // would otherwise have to take on faith.
      expect(await mode(`${dbPath}-wal`)).toBe('600')
    } finally {
      db.close()
    }
  })

  it('IntegrityMonitor: alert directory is 0700 and an alert file is 0600', async () => {
    const alertDir = path.join(tmpHome, '.ccrecall', 'integrity-alerts')
    const db = new Database(path.join(tmpHome, '.ccrecall', 'probe.db'))
    try {
      const mon = new IntegrityMonitor(db, { intervalMs: 60_000, alertDir })
      // writeAlertFile is private; drive it the way the monitor does.
      const file = (mon as unknown as {
        writeAlertFile(at: string, lines: string[]): string | null
      }).writeAlertFile('2026-01-01T00:00:00.000Z', ['probe'])
      expect(file).not.toBeNull()
      expect(await mode(alertDir)).toBe('700')
      expect(await mode(file as string)).toBe('600')
    } finally {
      db.close()
    }
  })

  it('session-start hook: its directory is 0700 and its telemetry log 0600', async () => {
    // No daemon is running on this port, so the hook takes its failure path and
    // still writes a telemetry row — which is exactly the path that created the
    // 0755 directory on the dogfood machine, every session, for months.
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('node', [HOOK_PATH], {
        env: {
          ...process.env,
          HOME: tmpHome,
          CCRECALL_PORT: '1',
          CCRECALL_SESSION_START_STRATEGY: 'startup-v1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      proc.stdin.end(JSON.stringify({ session_id: 'x', cwd: tmpHome }))
      proc.on('error', reject)
      proc.on('close', () => resolve())
    })

    const dir = path.join(tmpHome, '.ccrecall')
    const log = path.join(dir, 'startup-recall.log.jsonl')
    expect(await mode(dir)).toBe('700')
    expect(await mode(log)).toBe('600')
  })

  // The case every existing install is actually in. `mode` on appendFileSync
  // applies only when the file is created, so a directory and a log that are
  // already 0755/0644 stay that way unless something repairs them — and this is
  // the path that reaches them, once per session start.
  //
  // Surfaced by mutation: with only the fresh-install test above, deleting the
  // repair call left the suite green, which would have shipped a fix that does
  // nothing for anyone who already has ccRecall installed.
  it('session-start hook: repairs a directory and log left at 0755/0644', async () => {
    const dir = path.join(tmpHome, '.ccrecall')
    const log = path.join(dir, 'startup-recall.log.jsonl')
    await mkdir(dir, { recursive: true })
    await writeFile(log, '{"ts":"2026-01-01T00:00:00Z","strategy":"startup-v1"}\n', 'utf8')
    await chmod(dir, 0o755)
    await chmod(log, 0o644)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('node', [HOOK_PATH], {
        env: {
          ...process.env,
          HOME: tmpHome,
          CCRECALL_PORT: '1',
          CCRECALL_SESSION_START_STRATEGY: 'startup-v1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      proc.stdin.end(JSON.stringify({ session_id: 'x', cwd: tmpHome }))
      proc.on('error', reject)
      proc.on('close', () => resolve())
    })

    expect(await mode(dir)).toBe('700')
    expect(await mode(log)).toBe('600')
    // Repair, not truncate: the pre-existing row is still there, with the new
    // one appended after it.
    const rows = (await readFile(log, 'utf8')).trim().split('\n')
    expect(rows.length).toBe(2)
    expect(rows[0]).toContain('2026-01-01T00:00:00Z')
  })
})
