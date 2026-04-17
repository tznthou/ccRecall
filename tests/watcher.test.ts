// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'
import { JsonlWatcher } from '../src/core/watcher'

let tmpDir: string
let baseDir: string
let db: Database

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-watch-'))
  baseDir = path.join(tmpDir, 'projects')
  await mkdir(baseDir, { recursive: true })
  db = new Database(path.join(tmpDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

function makeCountingIndexer(counter: { count: number }): (db: Database) => Promise<void> {
  return async () => {
    counter.count += 1
  }
}

describe('JsonlWatcher — lifecycle', () => {
  it('start → stop does not leak a timer', async () => {
    const counter = { count: 0 }
    const w = new JsonlWatcher(db, {
      baseDir,
      debounceMs: 50,
      fullResyncMs: 60_000,
      runIndexer: makeCountingIndexer(counter),
    })
    await w.start()
    expect(w.isRunning()).toBe(true)
    await w.stop()
    expect(w.isRunning()).toBe(false)
  })

  it('duplicate start() is a no-op', async () => {
    const counter = { count: 0 }
    const w = new JsonlWatcher(db, {
      baseDir,
      debounceMs: 50,
      fullResyncMs: 60_000,
      runIndexer: makeCountingIndexer(counter),
    })
    await w.start()
    await w.start()
    expect(w.isRunning()).toBe(true)
    await w.stop()
  })

  it('stop() before start() is safe', async () => {
    const w = new JsonlWatcher(db, { baseDir })
    await expect(w.stop()).resolves.toBeUndefined()
  })
})

describe('JsonlWatcher — runNow', () => {
  it('runNow() invokes the indexer immediately', async () => {
    const counter = { count: 0 }
    const w = new JsonlWatcher(db, {
      baseDir,
      debounceMs: 60_000,
      fullResyncMs: 60_000,
      runIndexer: makeCountingIndexer(counter),
    })
    await w.runNow()
    expect(counter.count).toBe(1)
  })

  it('single-flight: overlapping runs drop the second, then reschedule once', async () => {
    const counter = { count: 0 }
    let release: (() => void) | null = null
    const slowIndexer = async (): Promise<void> => {
      counter.count += 1
      // Hold the first run open until test explicitly releases it.
      await new Promise<void>(resolve => { release = resolve })
    }
    const w = new JsonlWatcher(db, {
      baseDir,
      debounceMs: 20,
      fullResyncMs: 60_000,
      runIndexer: slowIndexer,
    })
    const first = w.runNow()
    // Second call while first is still inflight — should mark dirty and drop.
    await w.runNow()
    expect(counter.count).toBe(1)
    // Release the first run; the dirty flag should schedule a follow-up scan.
    release!()
    await first
    // Debounce (20ms) + timer tick for the follow-up scan.
    await new Promise(resolve => setTimeout(resolve, 120))
    // Release any follow-up run that's now blocked on the hold promise.
    if (release) release()
    expect(counter.count).toBeGreaterThanOrEqual(2)
    await w.stop()
  })
})

describe('JsonlWatcher — filesystem events', () => {
  it('new .jsonl file triggers the indexer after debounce', async () => {
    const counter = { count: 0 }
    const w = new JsonlWatcher(db, {
      baseDir,
      debounceMs: 30,
      fullResyncMs: 60_000,
      runIndexer: makeCountingIndexer(counter),
    })
    await w.start()
    // Allow chokidar to finish its initial ready scan.
    await new Promise(resolve => setTimeout(resolve, 150))

    const projDir = path.join(baseDir, '-Users-test-proj')
    await mkdir(projDir, { recursive: true })
    await writeFile(path.join(projDir, 'sess.jsonl'), '{"type":"user"}\n')

    // Wait for awaitWriteFinish (500ms) + debounce (30ms) + margin.
    await new Promise(resolve => setTimeout(resolve, 1200))
    await w.stop()
    expect(counter.count).toBeGreaterThanOrEqual(1)
  })

  it('non-jsonl file changes do not trigger the indexer', async () => {
    const counter = { count: 0 }
    const w = new JsonlWatcher(db, {
      baseDir,
      debounceMs: 30,
      fullResyncMs: 60_000,
      runIndexer: makeCountingIndexer(counter),
    })
    await w.start()
    await new Promise(resolve => setTimeout(resolve, 150))

    const projDir = path.join(baseDir, '-Users-test-proj')
    await mkdir(projDir, { recursive: true })
    await writeFile(path.join(projDir, 'meta.json'), '{"foo":"bar"}\n')
    await writeFile(path.join(projDir, 'notes.txt'), 'hello\n')

    await new Promise(resolve => setTimeout(resolve, 1200))
    await w.stop()
    expect(counter.count).toBe(0)
  })
})

describe('JsonlWatcher — periodic backstop', () => {
  it('full-resync timer fires even without fs events', async () => {
    const counter = { count: 0 }
    const w = new JsonlWatcher(db, {
      baseDir,
      debounceMs: 20,
      fullResyncMs: 60,
      runIndexer: makeCountingIndexer(counter),
    })
    await w.start()
    // Wait long enough for the backstop timer (60ms) + debounce (20ms) to fire
    // at least once.
    await new Promise(resolve => setTimeout(resolve, 250))
    await w.stop()
    expect(counter.count).toBeGreaterThanOrEqual(1)
  })
})

describe('JsonlWatcher — error handling', () => {
  it('indexer throw does not crash the watcher', async () => {
    let attempts = 0
    const throwingIndexer = async (): Promise<void> => {
      attempts += 1
      throw new Error('boom')
    }
    const w = new JsonlWatcher(db, {
      baseDir,
      debounceMs: 20,
      fullResyncMs: 60_000,
      runIndexer: throwingIndexer,
    })
    await w.runNow()
    expect(attempts).toBe(1)
    // Watcher should still be usable afterwards.
    await w.runNow()
    expect(attempts).toBe(2)
  })
})
