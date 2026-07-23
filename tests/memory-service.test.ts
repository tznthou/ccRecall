// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { Database } from '../src/core/database'
import { MemoryService } from '../src/core/memory-service'

let tmpDir: string
let db: Database
let svc: MemoryService

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-memsvc-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  svc = new MemoryService(db)
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('MemoryService.touch', () => {
  it('increments access_count and sets last_accessed', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'x',
    })
    svc.touch([id], 'query')
    const row = db.rawAll<{ access_count: number; last_accessed: string | null }>(
      `SELECT access_count, last_accessed FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.access_count).toBe(1)
    expect(row.last_accessed).not.toBeNull()
  })

  it('dedupes repeated ids in the same call', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'x',
    })
    svc.touch([id, id, id], 'startup')
    const row = db.rawAll<{ access_count: number }>(
      `SELECT access_count FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.access_count).toBe(1)
  })

  it('noops on empty array', () => {
    expect(() => svc.touch([], 'query')).not.toThrow()
  })

  it('handles non-existent ids silently (UPDATE matches 0 rows)', () => {
    expect(() => svc.touch([9999], 'query')).not.toThrow()
  })

  it('touches many memories atomically in one transaction', () => {
    const ids = [1, 2, 3, 4, 5].map(n =>
      db.saveMemory({ sessionId: null, messageId: null, type: 'decision', content: `m${n}` }),
    )
    svc.touch(ids, 'recall_query')
    const counts = db.rawAll<{ id: number; access_count: number }>(
      `SELECT id, access_count FROM memories ORDER BY id`,
    )
    for (const row of counts) expect(row.access_count).toBe(1)
  })

  it('logs injection entries with source', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'x',
    })
    svc.touch([id], 'startup', 'sess-abc')
    const logs = db.rawAll<{ memory_id: number; session_id: string; source: string }>(
      'SELECT memory_id, session_id, source FROM injection_log',
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ memory_id: id, session_id: 'sess-abc', source: 'startup' })
  })

  it('logs injection without session_id when omitted', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'x',
    })
    svc.touch([id], 'recall_query')
    const logs = db.rawAll<{ memory_id: number; session_id: string | null; source: string }>(
      'SELECT memory_id, session_id, source FROM injection_log',
    )
    expect(logs).toHaveLength(1)
    expect(logs[0].session_id).toBeNull()
    expect(logs[0].source).toBe('recall_query')
  })

  it('deduped touch still logs only unique ids', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'x',
    })
    svc.touch([id, id, id], 'startup', 'sess-1')
    const logs = db.rawAll<{ memory_id: number }>(
      'SELECT memory_id FROM injection_log',
    )
    expect(logs).toHaveLength(1)
  })
})

describe('MemoryService.delete', () => {
  it('deletes memory and returns true', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'x',
    })
    expect(svc.delete(id)).toBe(true)
    expect(db.getMemoryCount()).toBe(0)
  })

  it('returns false when id does not exist', () => {
    expect(svc.delete(9999)).toBe(false)
  })

  it('also removes FTS index entry via memories_ad trigger', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'zap token',
    })
    expect(db.queryMemories('zap', 10).length).toBe(1)
    svc.delete(id)
    expect(db.queryMemories('zap', 10).length).toBe(0)
  })
})

describe('MemoryService.updateContent', () => {
  it('updates content, compression_level, compressed_at and re-indexes FTS', () => {
    const id = db.saveMemory({
      sessionId: null, messageId: null, type: 'decision', content: 'original apple',
    })
    expect(svc.updateContent(id, 'new banana', 1)).toBe(true)

    const row = db.rawAll<{
      content: string; compression_level: number; compressed_at: string | null
    }>(
      `SELECT content, compression_level, compressed_at FROM memories WHERE id = ${id}`,
    )[0]
    expect(row.content).toBe('new banana')
    expect(row.compression_level).toBe(1)
    expect(row.compressed_at).not.toBeNull()

    // FTS reflects new content via memories_au trigger
    expect(db.queryMemories('apple', 10).length).toBe(0)
    expect(db.queryMemories('banana', 10).length).toBe(1)
  })

  it('returns false for non-existent id', () => {
    expect(svc.updateContent(9999, 'x', 1)).toBe(false)
  })
})
