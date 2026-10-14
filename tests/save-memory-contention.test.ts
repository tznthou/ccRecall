// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'
import type { MemoryInput } from '../src/core/database'

/**
 * recall_save vs the daemon's write lock (2026-10-14).
 *
 * The daemon and the MCP server write the same SQLite file, and the daemon
 * re-indexes a whole session on every transcript change, holding the write
 * lock for seconds on a large session (2.1 s measured on a 2.6 MB one).
 * `saveMemory`'s key upsert ran in a deferred transaction: its SELECT opened a
 * read transaction first, and SQLite does not invoke the busy handler when a
 * read transaction is upgraded to a write. So the upsert failed with
 * SQLITE_BUSY in 0 ms and `busy_timeout = 5000` never applied — in a live
 * session every save that landed inside a re-index window failed this way
 * (MCP log: "failed after 0s"), new key and existing key alike.
 *
 * BEGIN IMMEDIATE takes the write lock before the SELECT, where the busy
 * handler does apply, so the upsert waits for the other writer instead.
 */

const HOLD_MS = 400

let tmpDir: string
let dbPath: string
let db: Database

/**
 * Another process takes the write lock and keeps it for `holdMs`, as the
 * daemon does mid re-index. Resolves once the lock is held; the returned
 * function waits for that process to commit and exit.
 */
function holdWriteLock(file: string, holdMs: number): Promise<() => Promise<void>> {
  const code = `
    const Db = require('better-sqlite3')
    const c = new Db(process.argv[1])
    c.pragma('busy_timeout = 5000')
    c.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS _contender(x); INSERT INTO _contender VALUES (1);')
    process.stdout.write('LOCKED\\n')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[2]))
    c.exec('COMMIT')
    c.close()
  `
  const child = spawn(process.execPath, ['-e', code, file, String(holdMs)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const exited = new Promise<void>((res) => child.on('exit', () => res()))
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      if (String(d).includes('LOCKED')) resolve(() => exited)
    })
    child.on('error', reject)
    child.on('exit', (status) => reject(new Error(`contender exited (${status}) before taking the lock`)))
  })
}

function mem(overrides: Partial<MemoryInput> & { content: string }): MemoryInput {
  return {
    sessionId: null,
    messageId: null,
    type: 'decision',
    projectId: null,
    ...overrides,
  }
}

function contentOf(id: number): string {
  return db.rawAll<{ content: string }>(`SELECT content FROM memories WHERE id = ${id}`)[0].content
}

/** Runs the save while the lock is held; returns its id and how long it waited. */
async function saveUnderLock(input: MemoryInput): Promise<{ id: number; waited: number }> {
  const released = await holdWriteLock(dbPath, HOLD_MS)
  const t0 = Date.now()
  try {
    const id = db.saveMemory(input)
    return { id, waited: Date.now() - t0 }
  } finally {
    await released()
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-contention-'))
  dbPath = path.join(tmpDir, 'test.db')
  db = new Database(dbPath)
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('saveMemory while another process holds the write lock', () => {
  it('saves a new key by waiting for the lock instead of failing at once', async () => {
    const { id, waited } = await saveUnderLock(mem({ content: 'new under contention', key: 'contended-new' }))

    expect(contentOf(id)).toBe('new under contention')
    // The wait is what shows the lock was really held when the save ran;
    // without this check the test would also pass on an idle database.
    expect(waited).toBeGreaterThanOrEqual(HOLD_MS / 2)
  })

  it('updates an existing key by waiting for the lock instead of failing at once', async () => {
    const first = db.saveMemory(mem({ content: 'v1', key: 'contended-existing' }))

    const { id, waited } = await saveUnderLock(mem({ content: 'v2', key: 'contended-existing' }))

    expect(id).toBe(first)
    expect(contentOf(first)).toBe('v2')
    expect(waited).toBeGreaterThanOrEqual(HOLD_MS / 2)
  })
})
