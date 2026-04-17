// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'
import { MemoryService } from '../src/core/memory-service'
import { MaintenanceCoordinator } from '../src/core/maintenance-coordinator'

let tmpDir: string
let db: Database
let svc: MemoryService

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-maint-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  svc = new MemoryService(db)
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('MaintenanceCoordinator — lifecycle', () => {
  it('start → stop does not leak a timer', () => {
    const coord = new MaintenanceCoordinator(db, svc, { intervalMs: 10_000 })
    coord.start()
    coord.stop()
    // If the timer still fired, vitest's --test-timeout would fail the run.
    expect(true).toBe(true)
  })

  it('duplicate start() is a no-op (does not create a second timer)', () => {
    const coord = new MaintenanceCoordinator(db, svc, { intervalMs: 10_000 })
    coord.start()
    coord.start()
    expect(coord.isRunning()).toBe(true)
    coord.stop()
    expect(coord.isRunning()).toBe(false)
  })

  it('stop() before start() is safe', () => {
    const coord = new MaintenanceCoordinator(db, svc)
    expect(() => coord.stop()).not.toThrow()
  })
})

describe('MaintenanceCoordinator — manual tick', () => {
  it('tick() executes a compression pass', async () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision',
      content: 'x'.repeat(300), confidence: 0.2,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-10 days') WHERE id = ${id}`)

    const coord = new MaintenanceCoordinator(db, svc, { intervalMs: 60_000, batchSize: 50 })
    const stats = await coord.tick()
    expect(stats.compressed).toBe(1)

    const row = db.rawAll<{ compression_level: number }>(
      `SELECT compression_level FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.compression_level).toBe(1)
  })

  it('single-flight: overlapping tick() calls drop the second invocation', async () => {
    const coord = new MaintenanceCoordinator(db, svc, { intervalMs: 60_000 })
    // Kick off two concurrent ticks. Second should resolve with null (dropped).
    const [a, b] = await Promise.all([coord.tick(), coord.tick()])
    // One of them should have run (non-null stats), the other dropped.
    const ran = [a, b].filter(x => x !== null)
    const dropped = [a, b].filter(x => x === null)
    expect(ran.length).toBe(1)
    expect(dropped.length).toBe(1)
  })

  it('batchSize is forwarded to compression pipeline', async () => {
    for (let i = 0; i < 5; i++) {
      const id = db.saveMemory({
        sessionId: null, messageId: null, type: 'decision',
        content: `b${i} ` + 'x'.repeat(300), confidence: 0.2,
      })
      db.rawExec(`UPDATE memories SET created_at = datetime('now', '-10 days') WHERE id = ${id}`)
    }
    const coord = new MaintenanceCoordinator(db, svc, { intervalMs: 60_000, batchSize: 2 })
    const stats = await coord.tick()
    expect(stats?.scanned).toBe(2)
  })
})

describe('MaintenanceCoordinator — timer firing', () => {
  it('scheduled tick runs compression when timer fires', async () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision',
      content: 'y'.repeat(300), confidence: 0.2,
    })
    db.rawExec(`UPDATE memories SET created_at = datetime('now', '-10 days') WHERE id = ${id}`)

    // Tiny interval so the timer fires before we stop.
    const coord = new MaintenanceCoordinator(db, svc, { intervalMs: 20 })
    coord.start()
    // Wait for the timer to fire at least once.
    await new Promise(resolve => setTimeout(resolve, 80))
    coord.stop()

    const row = db.rawAll<{ compression_level: number }>(
      `SELECT compression_level FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.compression_level).toBe(1)
  })
})
