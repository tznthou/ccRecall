// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { Database } from '../src/core/database'
import { IntegrityMonitor } from '../src/core/integrity-monitor'

let tmpDir: string
let alertDir: string
let db: Database

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-integrity-'))
  alertDir = path.join(tmpDir, 'alerts')
  db = new Database(path.join(tmpDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

async function alertFiles(): Promise<string[]> {
  try { return await readdir(alertDir) } catch { return [] }
}

describe('IntegrityMonitor — lifecycle', () => {
  it('start → stop does not leak a timer', () => {
    const mon = new IntegrityMonitor(db, { intervalMs: 60_000, alertDir })
    mon.start()
    expect(mon.isRunning()).toBe(true)
    mon.stop()
    expect(mon.isRunning()).toBe(false)
  })

  it('duplicate start() is a no-op', () => {
    const mon = new IntegrityMonitor(db, { intervalMs: 60_000, alertDir })
    mon.start()
    mon.start()
    expect(mon.isRunning()).toBe(true)
    mon.stop()
  })

  it('stop() before start() is safe', () => {
    const mon = new IntegrityMonitor(db, { alertDir })
    expect(() => mon.stop()).not.toThrow()
  })

  it('getLastRecord() is null before the first tick completes', () => {
    const mon = new IntegrityMonitor(db, { alertDir })
    expect(mon.getLastRecord()).toBeNull()
  })
})

describe('IntegrityMonitor — clean DB', () => {
  it('tick() on a fresh DB records ok=true and writes no alert file', async () => {
    const fixedNow = new Date('2026-04-25T10:00:00.000Z')
    const mon = new IntegrityMonitor(db, { alertDir, clock: () => fixedNow })

    const rec = await mon.tick()

    expect(rec).toEqual({ at: '2026-04-25T10:00:00.000Z', ok: true })
    expect(mon.getLastRecord()).toEqual(rec)
    expect(await alertFiles()).toEqual([])
  })
})

describe('IntegrityMonitor — drift detected', () => {
  it('tick() with corruption lines records ok=false and writes an alert file', async () => {
    const fixedNow = new Date('2026-04-25T10:00:00.000Z')
    const mon = new IntegrityMonitor(db, { alertDir, clock: () => fixedNow })
    vi.spyOn(db, 'integrityCheck').mockReturnValue([
      'row 48 missing from index idx_memories_access',
      'row 91 missing from index idx_memories_project',
    ])

    const rec = await mon.tick()

    expect(rec).toEqual({ at: '2026-04-25T10:00:00.000Z', ok: false })
    expect(mon.getLastRecord()).toEqual(rec)

    const files = await alertFiles()
    expect(files).toHaveLength(1)
    // Filename embeds the timestamp with `:` / `.` replaced so every filesystem accepts it.
    expect(files[0]).toBe('integrity-check-2026-04-25T10-00-00-000Z.log')

    const body = await readFile(path.join(alertDir, files[0]), 'utf8')
    expect(body).toContain('row 48 missing from index idx_memories_access')
    expect(body).toContain('row 91 missing from index idx_memories_project')
    expect(body).toContain('Do NOT run REINDEX before capturing a snapshot')
    expect(body).toContain('2026-04-25T10:00:00.000Z')
  })

  it('two distinct ticks write two distinct alert files (no overwrite)', async () => {
    let tick = 0
    const clocks = [
      new Date('2026-04-25T10:00:00.000Z'),
      new Date('2026-04-25T16:00:00.000Z'),
    ]
    const mon = new IntegrityMonitor(db, { alertDir, clock: () => clocks[tick++] })
    vi.spyOn(db, 'integrityCheck').mockReturnValue(['row 1 missing from index idx_x'])

    await mon.tick()
    await mon.tick()

    const files = (await alertFiles()).sort()
    expect(files).toHaveLength(2)
    expect(files[0]).toBe('integrity-check-2026-04-25T10-00-00-000Z.log')
    expect(files[1]).toBe('integrity-check-2026-04-25T16-00-00-000Z.log')
  })

  it('tick() swallows pragma errors (e.g. DB closed) without crashing the daemon', async () => {
    const mon = new IntegrityMonitor(db, { alertDir })
    vi.spyOn(db, 'integrityCheck').mockImplementation(() => {
      throw new Error('database is locked')
    })
    const rec = await mon.tick()
    expect(rec).toBeNull()
    // lastRecord unchanged (still null) — we don't flip Ok=false on harness errors.
    expect(mon.getLastRecord()).toBeNull()
  })
})

describe('IntegrityMonitor — single-flight', () => {
  it('overlapping tick() calls drop the second invocation', async () => {
    const mon = new IntegrityMonitor(db, { alertDir })
    const [a, b] = await Promise.all([mon.tick(), mon.tick()])
    const ran = [a, b].filter(x => x !== null)
    const dropped = [a, b].filter(x => x === null)
    expect(ran.length).toBe(1)
    expect(dropped.length).toBe(1)
  })
})

describe('IntegrityMonitor — start() kicks off immediate tick', () => {
  it('start() schedules a non-blocking first tick so /health has a value', async () => {
    const mon = new IntegrityMonitor(db, { intervalMs: 60_000, alertDir })
    mon.start()
    // start() is fire-and-forget; await a microtask cycle to let it settle.
    await new Promise(resolve => setImmediate(resolve))
    expect(mon.getLastRecord()?.ok).toBe(true)
    mon.stop()
  })
})
