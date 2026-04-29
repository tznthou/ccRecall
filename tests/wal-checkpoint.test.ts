// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { statSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Database } from '../src/core/database'
import { runIndexer } from '../src/core/indexer'

let tmpDir: string
let dbPath: string
let db: Database

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-wal-'))
  dbPath = path.join(tmpDir, 'test.db')
  db = new Database(dbPath)
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

const walSize = (): number => {
  const p = dbPath + '-wal'
  return existsSync(p) ? statSync(p).size : 0
}

describe('Database.checkpointTruncate', () => {
  it('resets the WAL file to 0 bytes after a batch of writes', () => {
    db.upsertProject('p1', '/p1')
    for (let i = 0; i < 200; i++) {
      db.indexSession({
        sessionId: `s-${i}`, projectId: 'p1', projectDisplayName: '/p1',
        title: `t${i}`, messageCount: 0, filePath: `/tmp/${i}.jsonl`, fileSize: 0,
        fileMtime: '2024-01-01T00:00:00.000Z', startedAt: null, endedAt: null, messages: [],
      })
    }
    expect(walSize()).toBeGreaterThan(100_000)

    const r = db.checkpointTruncate()
    expect(r.busy).toBe(0)
    expect(walSize()).toBe(0)
  })

  it('is idempotent — second call on a clean WAL still returns busy=0', () => {
    db.checkpointTruncate()
    const r = db.checkpointTruncate()
    expect(r.busy).toBe(0)
    expect(walSize()).toBe(0)
  })
})

describe('runIndexer integration — WAL truncated after batch', () => {
  it('leaves WAL at 0 bytes after indexing many sessions', async () => {
    const baseDir = path.join(tmpDir, 'projects')
    const projectDir = path.join(baseDir, '-Users-test-bigbatch')
    await mkdir(projectDir, { recursive: true })

    for (let i = 0; i < 50; i++) {
      const lines = [
        {
          type: 'user', uuid: `u-${i}`,
          timestamp: '2024-06-01T10:00:00.000Z', sessionId: `sess-${i}`,
          message: { role: 'user', content: `Message ${i} ` + 'x'.repeat(500) },
        },
      ]
      await writeFile(
        path.join(projectDir, `sess-${i}.jsonl`),
        lines.map(l => JSON.stringify(l)).join('\n'),
      )
    }

    await runIndexer(db, undefined, baseDir)

    expect(walSize()).toBe(0)
  })
})
